---
title: Mentor live-readiness — real idle signal, mentee-side pickup, quota-aware budget
owning-layer: scheduler + server (mentor)
status: draft
supervision: tier1
---

# Mentor live-readiness

## Summary

The mentor system ships fully built but with three placeholders that block a real live test
against Codey. All three were surfaced during the 2026-05-27 dry-run live-validation phase
(topic 13435 — Justin caught two; the third I verified before claiming a live test would
work). Fixing all three is the prerequisite for one supervised live cycle against Codey, and
then for unattended live operation.

## The three gaps

### Gap 1 — `isMenteeBusy()` is a stub that's not about the mentee at all

`AgentServer.ts:~651`:
```ts
isMenteeBusy: () => self.sessionManager.listRunningSessions().length > 0,
```

Tagged in code with `<!-- tracked: topic-13435 -->` ("refined at live validation"). It checks
**Echo's own** running-session count, not Codey's state. Echo almost always has running
sessions → `isMenteeBusy()` is almost always true → `safeWindowOpen` is almost never true →
**the mentor effectively never runs**.

### Gap 2 — `deliverToMentee` is write-only (no Codey-side pickup)

`AgentServer.ts:~671-678`: `deliverToMentee` correctly appends a JSON line to
`{stateDir}/mentor-outbox/<framework>.jsonl`. The persist-only-no-spawn shape is the
deliberate **structural fix for the cross-agent spawn loop** ([[bug_cross_agent_ack_spawn_loop]]).
But **nothing on Codey's side reads that outbox** — verified by grepping the shipped dist for
mentor-outbox readers (one writer, zero readers). A live test today would write a file Codey
never sees. The mentee-side pickup is the missing piece — and it's Codey's side, so co-design.

### Gap 3 — Budget is dollar-denominated on a token-subscription, unenforced, silent on trip

`AgentServer.ts:~656-664`: `budgetOk` checks `mentorRunsToday < cfg.maxRoundsPerDay`
(24/day **run-count**). `cfg.dailySpendCapUsd: 0.5` is configured in
`MentorOnboardingRunner.DEFAULT_MENTOR_CONFIG` and `ConfigDefaults.ts` but **read nowhere**
(dead field — verified by repo-wide grep). Worse, the unit is fundamentally wrong: Echo runs
on a Claude **subscription**, not pay-per-token API, so there is no per-token dollar charge to
cap. The real cost is **tokens against a rolling quota** (5-hour + weekly limits) — already
tracked by `QuotaTracker` (`canRunJob(priority)` → normal/elevated/critical/shutdown) and
`TokenLedger` (with `attribution: { component: 'mentor-stage-b' }` already set). And nothing
notifies Justin when the cap (round or otherwise) trips.

## Fix

### Fix 1 — Real Codey-idle signal (replaces the system-busy stub)

Replace `isMenteeBusy` with a **mentee-specific** idle check that queries the mentee agent's
own server:

- Resolve mentee endpoint from a new `mentor.menteeServerUrl` config (defaults to
  `http://localhost:4044` for `codex-cli`, the co-located Codey instance).
- Probe `GET {menteeServerUrl}/sessions` (or a dedicated `/idle` endpoint if Codey adds one as
  part of his side of the co-design) with a 500ms timeout.
- Idle = no session with `activelyWorking=true` for that mentee. On probe failure (network,
  timeout, 4xx/5xx), **fail-closed: treat as busy** — never run the mentor blindly when
  Codey's state is unknown. Emit a degradation signal on persistent probe failure (so
  unresolvable mentee-unreachable surfaces, doesn't hide).
- The check is async; the runner pre-resolves it before assembling tick deps (the tick stays
  pure).

### Fix 2 — Mentee-side outbox pickup (co-design with Codey)

Keep the outbox-write exactly as is (the spawn-loop-safe shape is correct). Add a
**pull-based pickup** on Codey's side that turns each new outbox line into a user-prompt the
running Codey session processes. Two concrete options to be co-designed with Codey (he's the
authority on his ingestion):

- **(a) Codey-side scheduled job (`mentor-inbox-poll`)** — runs every ~1min, reads
  `{stateDir}/mentor-outbox/<framework>.jsonl` (or a shared path), advances a per-file
  byte-offset cursor (idempotent), and for each new line injects the message via
  `injectInternalMessage` into Codey's active mentee-collab session. Codey's reply is
  appended to a **reply outbox** Echo's Stage-B reads.
- **(b) Codey-side filesystem watcher in-process** (no job) — same shape, event-driven.

(a) is conservative (matches the cron-job-everywhere pattern) and explicit; (b) is lower-
latency but more state to manage. **Codey picks**, and ratifies the reply-path shape.

This fix has **two-sided code**: Echo writes (already correct) + Codey reads. Echo's side
adds a documented contract (file path, line schema, reply file path) and a contract test.
Codey's side ships the pickup. The spawn-loop guard remains structural: no Echo→Codey
spawn-on-write, no Codey→Echo spawn-on-reply — both sides queue-and-pickup.

### Fix 3 — Quota-aware budget + notification (replaces the dead dollar cap)

- **Remove** `dailySpendCapUsd` from config defaults; replace with `mentor.quotaCeiling`
  (default: `elevated` — mentor stands down at elevated/critical/shutdown, runs only at
  normal). Wire `budgetOk` to `QuotaTracker.canRunJob('low')` (mentor is low-priority) AND
  the existing run-count backstop (`maxRoundsPerDay` stays — it's a real bound).
- **Add a token-spend ceiling** (`mentor.dailyTokenCeiling`, default 200_000 tokens) summed
  from `TokenLedger` with `attribution.component='mentor-stage-b'`. Hit the ceiling → defer
  with reason `budget-tokens`.
- **Notify on trip**: when `budgetOk` returns false (quota OR run-count OR token-ceiling),
  push **one** entry to the Attention Queue (`POST /attention`) deduped per-day per-reason,
  AND send a single Telegram alert to the system topic. No per-tick chatter — one alert when
  the cap closes, one when it reopens.

## Design (one place to read)

The runner gets three new service dependencies, all small + injectable for tests:
- `getMenteeIdle(menteeFramework): Promise<boolean>` — async probe + fail-closed.
- `quotaStandDown(menteeFramework): { allow: boolean; reason?: string }` — composes quota
  + run-count + token-ceiling; returns the specific blocker.
- `notifyBudgetTrip(reason, detail)` — fires the attention + Telegram alert (deduped).

The tick changes:
- Order is `canary → quota → idle → spawn → leak → forensics → capture → deliver` (idle
  becomes a real async-resolved boolean, computed in `Runner.startTick` so the tick stays
  pure).
- `deps.budgetOk` is replaced by `deps.budget` returning `{ ok, reason }`; on `!ok` the tick
  calls `deps.notifyBudgetTrip(reason)` exactly once (dedup is in the notifier, not the tick).
- `reason: 'unsafe-window'` is renamed `reason: 'mentee-busy'` to match the actual signal.

## Out of scope

- A Codey **liveness** monitor beyond the per-probe fail-closed (separate concern).
- Threadline-relay-based delivery (intentionally rejected — see [[bug_cross_agent_ack_spawn_loop]]).
- Multi-mentee fan-out (one mentee for now).

## Testing

1. **Unit — idle signal:**
   - mentee at-rest → `getMenteeIdle = true` → tick proceeds past the idle gate.
   - mentee `activelyWorking=true` → `getMenteeIdle = false` → tick defers `mentee-busy`.
   - probe timeout / network error / non-2xx → fail-closed: `getMenteeIdle = false` (NEVER
     true on unknown state); a degradation signal is emitted on persistent failure.
2. **Unit — quota-budget:**
   - quota `normal` + under run-count + under token-ceiling → `budget.ok = true`.
   - quota `elevated` → `budget.ok = false, reason = 'quota-elevated'`.
   - run-count cap → `budget.ok = false, reason = 'runs-exhausted'`.
   - token-ceiling hit → `budget.ok = false, reason = 'tokens-exhausted'`.
   - On trip, `notifyBudgetTrip` is called exactly once per (reason, day) — replays don't
     re-notify.
3. **Integration — delivery contract (Echo-side):**
   - `deliverToMentee` writes a well-formed JSONL line at the documented path; the contract
     schema is published as a typed export the Codey-side pickup imports.
4. **End-to-end — supervised live cycle (the actual test):**
   - All three fixes shipped; manually trigger one tick against the real Codey with Justin
     watching; assert Codey receives the message, replies, and Stage-B captures the reply.
     Capture before/after token-ledger spend, attention-queue state, and any degradation
     events.

## Migration parity

- **Config:** `migrateConfig` removes `mentor.dailySpendCapUsd` (silent if absent) and adds
  `mentor.menteeServerUrl`, `mentor.quotaCeiling`, `mentor.dailyTokenCeiling` with defaults
  (existence-checked, only added when missing).
- **No agent-installed file changes** beyond config defaults — loader-only shadow-install update.

## Co-design with Codey (open)

The Codey-side pickup design (option a vs b vs other), the reply-outbox shape, and any
preferred contract details are explicitly open for Codey's input on a fresh Threadline thread
(per the established short-msg + view-link pattern to avoid the command-too-long bug).
Codey's response folds into a §Mentee-side pickup section before convergence.
