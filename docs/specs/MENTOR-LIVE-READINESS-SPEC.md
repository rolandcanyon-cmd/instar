---
title: Agent-to-Agent Telegram comms primitive + Mentor live-readiness (its first consumer)
owning-layer: messaging (new primitive) + scheduler/server (mentor consumer)
status: draft
review-convergence: false
review-iterations: 0
co-designer: instar-codey (pending — recipient-side detection + anti-loop handler)
approved: false
supersedes-rounds: 2 prior convergence rounds on file-based mentor-outbox design (committed but re-architected after Justin substrate correction, topic 13435, 2026-05-27)
supervision: tier1
---

# Agent-to-Agent Telegram comms primitive + Mentor live-readiness

## Summary

Two fixes wrapped together because the consumer drove the primitive's design:

1. **A new agent-to-agent Telegram comms primitive** — a robust, recipient-knows-it's-from-
   an-agent channel any agent can use to message another agent's bot, with the indicator
   *and* the anti-loop machinery as first-class infra. Justin's framing (2026-05-27):
   "robust infra that indicates the message is from another agent… leverage infra to
   prevent the ping pong trap." Reusable for any future agent-to-agent Telegram scenario;
   the mentor is its first consumer.
2. **Mentor live-readiness** — three remaining gaps in the existing mentor system that
   block a real supervised live cycle against Codey (real idle signal, the agent-comms
   delivery — now via the primitive — replacing the broken file-outbox, and a quota-aware
   budget on actual subscription metrics).

## Design-drift correction (honoring this morning's learning)

The first version of this spec used a file-based outbox for mentor delivery — convergence
hardened it heavily, all the way to round 2 — and Justin caught that it solved the wrong
problem. The cross-agent spawn loop was a *discipline* issue (don't auto-reply to courtesy
acks); I'd misread it as a *substrate* issue and moved off Telegram, which broke the
authenticity of the simulation (Codey would process file lines, not user messages, exactly
what we DON'T want to test). Two rounds of reviewer review didn't catch it because each
reviewer asked "is this file-based design sound?" not "is file-based the right substrate?"
Recorded the meta-lesson alongside today's earlier one
([[feedback_report_verified_not_intended_behavior]]): convergence checks *how well a
design holds up*, not *whether the design's framing is correct* — that's the user's call,
and the spec must surface the substrate choice explicitly, not bury it.

## The three live-readiness gaps (unchanged from prior draft)

### Gap 1 — `isMenteeBusy()` is a stub that's not about the mentee at all

`AgentServer.ts:~651`: `isMenteeBusy: () => self.sessionManager.listRunningSessions().length > 0`.
Tagged `<!-- tracked: topic-13435 -->`. Checks Echo's own sessions; almost always true →
safe window never opens → mentor effectively never runs.

### Gap 2 — Mentor delivery to Codey does not exist as a real user-channel

The current `deliverToMentee` writes JSON lines to a file nothing reads, AND the file
substrate doesn't simulate a user interaction even if it were read. Both problems are
fixed by the new primitive: route mentor messages through Telegram (the real user channel)
so Codey processes them with his normal user-message pipeline.

### Gap 3 — Budget is dollar-denominated on a token-subscription, unenforced, silent on trip

`AgentServer.ts:~656-664`: `budgetOk` checks a run-count; `dailySpendCapUsd: 0.5` is a dead
config field; Echo runs on a Claude subscription (no per-token dollar charge to cap). The
real cost is tokens against rolling quota — already tracked by `QuotaTracker.canRunJob` +
`TokenLedger` (`attribution.component='mentor-stage-b'`).

## Fix 1 — Real Codey-idle signal (replaces the system-busy stub)

Replace `isMenteeBusy` with a **mentee-specific** idle check via a new unauthenticated
`GET /idle` endpoint Codey ships on his server (port 4044). `/sessions` is Bearer-authed
AND has no `activelyWorking` field, so a fresh endpoint is needed.

`/idle` returns:
```json
{ "schemaVersion": 1, "idle": true, "bootId": "uuid-set-at-process-start",
  "uptimeSec": 12345, "activeSessions": 0, "ts": "ISO-8601",
  "reason": "active-session | startup-warmup | unknown (optional, diagnostic only)" }
```
**`activeSessions` semantics (Codey's clarification):** sessions with *live work* — active
autonomous jobs, active Telegram-spawned sessions, running task sessions. Reaped/idle/
complete panes do NOT count. **If the local signal is ambiguous, the mentee returns
`idle:false`** rather than guessing or omitting fields. `reason` is optional and Echo
must NOT depend on it for v1 behavior (it's diagnostic for degradation reports only).

Echo-side:
- Probe `{mentor.menteeServerUrl}/idle` with 750ms timeout.
- **Fail-closed on every ambiguous outcome**: non-2xx, network/timeout, JSON-parse failure,
  unrecognized schemaVersion, missing required fields, `idle !== true` → busy.
- **Liveness-warmup**: `idle:true` but `uptimeSec < minIntervalMs/1000` → defer one cycle
  (don't pile onto a recovering Codey).
- Persistent failure (≥3 consecutive) → `DegradationReporter` event `mentor.menteeProbe`.
- Reasons split: `mentee-busy` vs `min-interval-not-elapsed` (distinct strings).

## Fix 2a — Agent-to-Agent Telegram Comms primitive (new infra)

**Module:** `src/messaging/AgentTelegramComms.ts` (new) — generic primitive, mentor-agnostic.

### The marker

Every agent-to-agent message carries a structured, visible prefix in the message body:

```
[a2a:from=<senderAgent> to=<recipientAgent> role=<role> id=<stable-uuid> corr=<uuid> v=1]

<message body>
```

- **Visible in chat** — humans can audit at a glance, AND **the Telegram chat history alone
  is enough to reconstruct the round-trip when ledgers are unavailable** (Codey's
  point — `corr` in the visible marker, not just audit metadata, so the trace is the chat).
- **Field-value charset (Codey's tightening):** `[A-Za-z0-9._:-]+` for `from`/`to`/`role`/
  `id`/`corr`; positive integer for `v`. UUIDs recommended for `id`/`corr`; parser accepts
  any token matching the charset (so ULIDs etc. work for future senders).
- **`corr` is optional in syntax, REQUIRED in semantics**: prompts omit `corr` (or set
  `corr=id`); replies MUST set `corr=<prompt's id>` to thread the round-trip.
- **Parser is strict** — regex anchored to start, consumes only the first line + the
  required blank separator. Anything marker-*like* but malformed (charset violation,
  missing required field, broken syntax) is an **A2A security event**: drop + audit row,
  NEVER fall through to normal user handling (Codey's point — avoids spoof / broken sender
  accidentally turning into a regular prompt).
- **Versioned** (`v=1`) — schema bumps are explicit.
- **No HMAC v1** — recipient trusts the marker if the sender Telegram bot identity is in
  the recipient's known-agents allowlist (the structural identity check is the Telegram bot
  ID, not the marker text). HMAC-signed markers deferred to v2 if cross-machine trust
  becomes a concern.
- **Roles defined**: `mentor`, `mentor-reply`, `coord`, `coord-reply`, `notify` (extensible).

### Sender side

```ts
sendAgentMessage({
  fromAgent: 'echo',
  toAgent: 'instar-codey',
  toBotToken: cfg.codey.mentorBotToken,   // the recipient's mentor-bot token
  toTopicId: cfg.codey.mentorTopicId,     // the dedicated topic in recipient's setup
  role: 'mentor',                          // MUST be in the caller's allowed-roles list
  message: '<the prompt>',
  correlationId?: 'optional-existing-id-for-reply-threading',
}): Promise<{ ok: boolean; sentMessageId?: string; a2aId?: string; reason?: string }>
```

- **Generic, not mentor-specific** (Codey's point): the primitive is reusable; caller
  passes the `role` from a constructor-time allowed-roles list. For Codey's first
  consumer, the only permitted outbound role is `mentor-reply` (produced only by the
  mentor handler).
- Instantiates (or reuses) a `TelegramAdapter` for the recipient's bot.
- Mints a stable `a2aId` (UUID) if `id` not supplied; prepends the marker; calls
  `sendToTopic(toTopicId, marker+body)`.
- **Returns `a2aId`** alongside `sentMessageId` so the caller can log the exact marker id
  next to its local assistant response id (Codey's tightening).
- **Audit row schema** (`state/a2a-sent.jsonl`, append-only): `localTs`, `direction:
  'sent'`, `fromAgent`, `toAgent`, `role`, `id`, `corr` (if present), `telegramBotId`,
  `topicId`, `sentMessageId`, `result: 'ok' | 'failed'`, `reason` (on failure). **No
  tokens or secrets in ledgers.**

### Recipient side

A new incoming-message handler registered with `TelegramAdapter.onMessage`. **The handler
runs BEFORE normal user routing** so agent-origin messages cannot accidentally trigger
generic courtesy/ack behavior on the user-message path (Codey's sharpening).

```ts
agentMessageHandler(rawMsg): { handled: boolean; routedTo?: string; dropReason?: string }
```

**Routing matrix (Codey-designed, explicit + audited at every branch):**

| Incoming shape | Decision | Audit row |
|---|---|---|
| No marker present | Fall through to normal user handling | (not an A2A event) |
| Marker-like-but-malformed (charset / missing field / syntax) | **DROP** (security event, NEVER fall through) | `agent-marker-malformed` |
| Valid marker, `to !== <localAgent>` | DROP | `agent-marker-wrong-recipient` |
| Valid marker, unsupported `v` | DROP | `agent-marker-unsupported-version` |
| Valid marker, `from` not in allowlist OR sender bot-ID mismatch | DROP (spoof defense) | `agent-marker-unknown` |
| Valid marker, `id` already in processed-id ledger | DROP (idempotency — Telegram retry / adapter restart) | `agent-marker-duplicate` |
| Valid allowlisted, `role` recognized | Strip marker → route to role-handler → record `id` in processed ledger | `agent-marker-routed` |
| Valid allowlisted, role unexpected for this recipient (e.g. `mentor-reply` on Codey) | DROP (don't fall through to user) | `agent-marker-unexpected-role` |
| Valid allowlisted, unknown role | DROP | `agent-marker-unknown-role` |

**Processed-id ledger (Codey's idempotency point):** a small persistent set of recently-
processed `id`s (bounded — last N=10_000 or M=30 days, whichever first) so retries/restarts
can't re-inject the same prompt. File-backed at `state/a2a-processed-ids.json` via
`SafeFsExecutor.atomicWriteJsonSync`, CAS single-writer.

**Anti-loop discipline (sharpened per Codey):**
- Agent-origin Telegram messages suppress ALL generic courtesy/ack behavior **before**
  normal user routing sees them (the handler runs first).
- The role-handler is the only producer of any outgoing message in response.
- A role-handler may only produce roles from an **explicit allowlist** for that handler
  (e.g. Codey's mentor-handler: consumes `mentor`, may produce only `mentor-reply` —
  cannot send the same role it consumes).
- **`mentor-reply` ingestion on Echo is finding-emission-only** — Stage-B parses → emits
  `ForensicFinding[]` → `capture()`. MUST NOT call `spawnStageA`, `deliverToMentee`,
  scheduler enqueue, or Threadline send. Import-surface lint enforces.
- **Every drop path writes an audit row** (silent drops make Stage-B forensics painful).
- Every received agent message (routed OR dropped) logged to `state/a2a-received.jsonl`
  (append-only).

### Anti-loop infra: structural, not just rules

1. **One outbound producer per `role`** + **role-handler allowlist** (Codey's sharpening).
   Each role-handler is constructed with an explicit allowed-outbound-roles list and
   `sendAgentMessage` refuses any role not in that list at runtime. Import-surface lint
   AT BUILD TIME asserts the module's static `sendAgentMessage` callsites only reference
   roles in the constructor's allowlist. **A role-handler cannot send the same role it
   consumes** (a mentor-handler cannot send `mentor`; only `mentor-reply`).
2. **Cycle-detection keyed precisely** (Codey's refinement): the detection key is
   `(fromBotId, toBotId, topicId, role, corr)` — NOT just `(bot, topic)` — so legitimate
   unrelated messages don't trip each other. Default window 5s, configurable. Trips →
   require explicit `cycleOk: true` parameter or refuse with a `degradation` event.
3. **Round-trip audit ledger.** Sent + received ledgers include role, ids, `corr`
   correlation chains, bot/topic, and result. Stage-B / future debugging can prove there
   is no role→reply→role path within a single tick boundary. **Every drop path also
   writes** (no silent drops).
4. **`mentor-reply` ingestion on Echo is finding-emission-only** (Codey's explicit
   invariant): MUST NOT call `spawnStageA`, `deliverToMentee`, scheduler enqueue, or
   Threadline send. Import-surface lint forbids those imports in the reply-ingestion
   module. The only outbound effect is `capture({findings})`.

### Config

New `agentTelegram` section in `.instar/config.json`:
```json
"agentTelegram": {
  "knownAgents": {
    "echo":        { "botId": "echo-mentor-bot-id" },
    "instar-codey":{ "botId": "codey-bot-id" }
  },
  "cycleDetectionWindowMs": 5000,
  "auditRetentionDays": 30
}
```

Per-recipient bot config (sender-side) lives under the consumer's section (e.g.
`mentor.codeyBot = {token, topicId}` — see Fix 2b).

## Fix 2b — Mentor consumes the primitive

- **Echo mints a dedicated mentor bot via @BotFather** (per Justin's choice C). Token
  stored in Echo's config under `mentor.botToken` (Secret-Drop-collected — never via chat
  paste).
- **Codey accepts the mentor bot** as a known agent in his `agentTelegram.knownAgents`
  allowlist, and routes any received `[a2a:role=mentor]` to a new "mentor inbox" topic
  (the dedicated Mentor session topic). The role-handler injects the message body
  (post-marker-strip) as a user prompt into Codey's mentor-session.
- **Codey's reply** goes back via `sendAgentMessage` with `role=mentor-reply` to Echo's
  mentor bot. Echo's mentor bot receives it; Echo's recipient handler routes to Stage-B.
- **Stage-B reply ingestion is finding-emission-only** — capture() only, no path to
  spawnStageA or another deliverToMentee. Unit-tested by an assertion: a `mentor-reply`
  received → next tick still defers (no implicit recurrence).
- **`deliverToMentee` (Echo-side) is replaced** by a thin wrapper around `sendAgentMessage`.
  The file-based mentor-outbox is retired (legacy artifact cleanup in migration).

### What this means for the mentor's Stage A

Stage A drives Codey "as a user would" — via Telegram, in the dedicated mentor topic,
through the primitive. Codey's mentor-handler processes the prompt the same way it would
process any user message (the test of his behavior under user-like interaction). The
identity is honest (it's Echo's mentor bot, not a Justin impersonation), but the
*interaction shape* is user-level, which is what the wild-behavior test needs.

## Fix 3 — Quota-aware budget + notification (unchanged from prior draft)

- **Remove** `dailySpendCapUsd` from config defaults; add `mentor.quotaCeiling` (default
  `elevated`), wire `budgetOk` to `QuotaTracker.canRunJob('low')` + run-count backstop.
- **Quota null/stale → fail-closed** (`reason: quota-unknown`); override the default
  fail-open.
- **Token-spend ceiling** (`mentor.dailyTokenCeiling`, default 200_000) summed via
  prefix-match `mentor-stage-b::%` on `TokenLedger.byAttributionKey({sinceMs})`.
- **Trip-EPISODE state machine** (not day-bucket); alerts on `ok→tripped` AND
  `tripped→ok`; file-backed persistence at `state/mentor-budget-notifications.json` via
  `SafeFsExecutor.atomicWriteJsonSync`; CAS single-writer; corrupt-state-file recovery
  with degradation event; optional `budgetReminderHours` long-trip reminder (default off).
- **Mentor budget is Echo-side primarily** (Codey's surface check: his instance reports
  `quotaTracking:false`). The budget gates **Echo's mentor-tick sending** — Echo's tokens
  are the spend that needs capping. Codey's replies go through his normal handling on his
  side; this fix does not require any quota wiring on Codey's side.

## Scope

- **In:** `AgentTelegramComms` primitive (sender + recipient + marker + anti-loop infra +
  audit ledgers + config), mentor as its first consumer (mentor-bot + Stage-A/Stage-B
  rewiring + retire file-outbox), Fix 1 idle signal, Fix 3 quota-budget.
- **Out:** HMAC-signed markers (v2 if cross-machine trust matters); multi-mentee fan-out;
  Threadline-relay-based mentor delivery (intentionally rejected — Telegram is the test
  substrate); a general "agent presence" service beyond the per-probe `/idle` (separate
  concern).

## Migration parity

- **Config (additive):** `agentTelegram` section (new), `mentor.botToken`,
  `mentor.menteeServerUrl`, `mentor.menteeBotId`, `mentor.menteeTopicId`,
  `mentor.quotaCeiling`, `mentor.dailyTokenCeiling`, `mentor.budgetReminderHours` added
  via `ConfigDefaults.getMigrationDefaults()` + `applyDefaults` (existence-checked).
- **Config (removal — NOT silent).** `migrateConfig` deletes `mentor.dailySpendCapUsd`
  (silent if default `0.5`); if non-default, emit ONE Attention entry explaining the
  field was decorative (subscription, no per-token charge) and the replacement is
  `mentor.dailyTokenCeiling`.
- **Retire the file-outbox.** `migrateConfig` deletes `{stateDir}/mentor-outbox/*` on the
  first run after this update lands (the legacy outbox is now dead state). Idempotent.
  An Attention entry notes the cleanup if any files were present.
- **Codey bot allowlist bootstrapping.** Echo-side: `mentor.botToken` is Secret-Drop-
  collected during a `/mentor/bot-setup` one-time command (interactive, OOB-confirmed) —
  never via chat paste. Codey-side: he adds Echo's mentor-bot ID to his
  `agentTelegram.knownAgents` allowlist as part of his side's PR.
- **Routes.** Two new routes (`GET /idle` on Codey's server; `POST /mentor/bot-setup` on
  Echo). Both get CapabilityIndex prefix classification + CLAUDE.md template entry per
  the Agent Awareness Standard.

## Testing

1. **Unit — primitive marker parsing:** valid markers parse; malformed markers
   (missing fields, wrong version, extra fields) reject; unknown sender → drop (not
   route to user handler); spoofed `from` but wrong bot ID → drop + log.
2. **Unit — anti-loop infra:**
   - Role-handler import-surface lint: a module that registers as `mentor` handler MUST
     NOT import `sendAgentMessage` with `role: 'mentor'` (only `mentor-reply`).
   - Cycle-detection: two sends to the same recipient within 5s without `cycle-ok:true`
     → refused + degradation event.
   - Round-trip ledger: send + receive both write their audit rows; correlation chain
     reconstructable.
3. **Unit — Fix 1 idle:** as prior draft (fail-closed coverage on every ambiguous
   outcome including 200+missing-fields; liveness-warmup; persistent-failure degradation).
4. **Unit — Fix 3 budget:** as prior draft (trip-episode state machine, quota null
   fail-closed, prefix-match summation, CAS persistence, corrupt-recovery).
5. **Integration — Echo-side mentor consumer:** mock `TelegramAdapter` sends via
   `sendAgentMessage`; assert marker formed correctly, audit written; simulate
   `mentor-reply` received → Stage-B parser invoked; assert next tick still defers (no
   recurrence). This closes the [[project_jobs_load_fix_layered]] test-gap pattern.
6. **Wiring-integrity:** production wiring of `getMenteeIdle` / `budget` /
   `sendAgentMessage` is non-null + non-no-op; arch-test on import surfaces.
7. **End-to-end — supervised live cycle** (the actual test):
   - Echo's mentor-bot active in a dedicated Mentor topic in Codey's setup.
   - `/idle` probe succeeds → idle:true.
   - Echo sends one tagged mentor message → Codey's recipient handler routes to mentor
     handler → injects as user prompt → Codey replies via `sendAgentMessage(role=mentor-reply)`.
   - Echo receives the reply → Stage-B emits findings.
   - Next tick defers (no auto-recurrence). Capture token-ledger spend + ledger audit
     trail + any degradation events.

## Co-design with Codey

**Round 1 (file-based) — superseded** by Justin's substrate correction.

**Round 2 (Telegram-based) — CLOSED** (Threadline thread 14629926, 2026-05-27). Codey
endorsed the substrate correction verbatim ("Telegram is the right substrate for this
test; the previous file outbox made the transport easier but weakened the actual behavior
being tested") AND **verified his own live capability surface** before answering (v1.3.15,
Telegram bidirectional, Threadline enabled, mentor endpoints present, `quotaTracking:false`
on his instance — applying [[feedback_report_verified_not_intended_behavior]]).

Codey's 5 substantive refinements (all folded above):
1. **/idle** — add optional `reason` (diagnostic-only, Echo doesn't depend); sharpen
   `activeSessions` semantics (live work only, not historical panes); ambiguous-signal →
   `idle:false` rather than omit.
2. **Recipient handler** — strict malformed-marker drop (security event, NEVER fall
   through to user); explicit per-decision audit row; processed-id idempotency ledger
   against Telegram retries / adapter restarts.
3. **Sender** — make generic (not mentor-specific); caller passes allowed-roles list at
   construction; return `a2aId` alongside `sentMessageId`; full audit-row schema
   (no secrets in ledgers).
4. **Marker schema** — constrain field-value charset to `[A-Za-z0-9._:-]+` + integer for
   `v` (deterministic parsing, avoids invisible/escaping cases); add **visible `corr=`**
   field so Telegram chat history alone reconstructs the round-trip when ledgers
   unavailable.
5. **Anti-loop invariants** — agent-origin messages suppress courtesy/ack BEFORE normal
   user routing sees them; role-handler explicit allowed-outbound-roles list (cannot send
   the role it consumes); `mentor-reply` ingestion on Echo MUST be finding-emission-only
   (no Stage A, no `deliverToMentee`, no scheduler enqueue, no Threadline send); cycle-
   detection key is `(fromBotId, toBotId, topicId, role, corr)`, not just bot+topic;
   every drop path writes an audit row.

**Implementation note Codey raised:** the Codey-side PR should land in the **instar source
package** (the upstream that produces the shadow-install), NOT as a hand-edit under
`.instar/shadow-install`. The primitive ships as part of instar; per-agent config
(agentTelegram allowlist + mentor.botToken) is the only per-agent piece.

**Quota-budget on Codey's side (Codey's surface check):** his instance reports
`quotaTracking:false`, so Fix 3 (quota-aware budget) is primarily an **Echo-side**
mechanism — Codey doesn't gate his own work against quota for this loop. The mentor
budget gates Echo's *sending* (Echo's tokens are the spend); Codey's responses go through
his own normal handling. Documented in §Fix 3 below.

## Honesty / lessons applied

- Every claim about an existing surface cites the code I read (TelegramAdapter.onMessage
  line 1327; sendToTopic widely used; QuotaTracker.canRunJob from prior verification;
  TokenLedger.byAttributionKey/attribution_key shape from prior verification). The
  substrate-vs-discipline error that bit this morning is recorded ([[feedback_report_
  verified_not_intended_behavior]] applies + adjacent lesson on level-of-fix selection).
- The convergence rounds on the file-based design caught everything that mattered about
  that design EXCEPT whether the design's substrate was right — that's an instructive
  limit of reviewer review (reviewers ask "is this sound?", not "is this framing
  correct?"). Future specs must surface substrate choices explicitly so the framing is
  reviewable, not assumed.
