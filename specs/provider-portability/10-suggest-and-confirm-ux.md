---
review-convergence: "2026-05-15T00:00:00Z"
approved: true
approved-by: "Justin (JKHeadley)"
approved-date: "2026-05-15"
---

# Phase 5b — Suggest-and-Confirm UX

**Status:** Spec locked 2026-05-15 by Justin (Telegram answers captured below)
**Branch:** `spec/provider-portability`
**Phase position:** Sits on top of Phase 5a (model + framework fitness catalogs) and Phase 5c (cost-aware routing infrastructure). Phase 5b is the user-facing surface that turns the routing decision into a confirm-once-then-cache UX.
**Companion:** ELI16 overview at `specs/provider-portability/10-suggest-and-confirm-ux.eli16.md`.

---

## What this spec defines

The user-facing surface for framework + model selection. When Instar is about to run a task, it picks a framework (Claude Code, Codex CLI, Aider, etc.) + model (Opus 4.7, gpt-5.3-codex, Gemini, DeepSeek V4, etc.) from the catalogs Phase 5a produced. Most of the time this happens silently with defaults. **For big decisions and new patterns, Instar asks first via Telegram and remembers the answer.** Asking is rare and intentional — never spammy.

---

## Operating principles (locked 2026-05-15 by Justin)

These four design answers came from a Telegram exchange on 2026-05-15. They lock the surface against drift.

### Principle 1 — Telegram only, never dashboard

The suggest-and-confirm prompt surface is **Telegram only**. Not the dashboard, not the CLI, not a web page. The dashboard MAY surface a historical view of past picks for review, but the *active* confirmation prompt lives on Telegram only — because that's where Justin is when he's AFK, and AFK is when this surface matters most.

For non-Telegram-originated work (jobs, autonomous loops, background tasks where there's no active topic to relay to), Instar **does not prompt at all** — it falls back to whatever defaults the user's catalog state declares. Background work never blocks on a confirmation that can't be delivered to the user.

### Principle 2 — Sticky yes with visible auto-pick note

A confirmed pick is sticky across future tasks of the same pattern. Subsequent runs auto-pick without prompting, but Instar **always emits a short "(auto-picked X for Y)" log line** so Justin can intercept if the pattern has drifted. The log line is part of the routine response — visible but unobtrusive. The combination keeps momentum (no repeated prompts) without losing visibility (the auto-pick is never invisible).

### Principle 3 — Re-ask only on three triggers

A previously-cached pick is rerun without confirmation EXCEPT when one of these three triggers fires:

1. **New task pattern.** The classifier sees a task type with no prior preference cached.
2. **Material cost / quota shift.** Since the cached pick was made, the cost / quota state changed materially — for example, SDK credit pot dropped below the safety margin, Max subscription hit a session limit, or a new framework / model became available that wasn't in the catalog at cache time.
3. **Low confidence.** The model fitness catalog (Phase 5a) reports the cached pick at confidence `LOW` or `PROVISIONAL` for this task pattern, AND the catalog has been updated since the cache was made (so re-evaluation might produce a different answer).

If none of these fire, the cached pick runs silently with the auto-pick note. If any fire, Instar pauses and asks via Telegram. **The default is silence; asking is the exception.**

### Principle 4 — Override via command OR inline phrasing

A user can override a sticky pick mid-flight via:

1. **Explicit slash command.** `/route reset` clears the cached preference for the current task type. `/route use <framework>+<model>` overrides for the current task only. `/route prefer <framework>+<model>` overrides AND updates the cache.
2. **Inline phrasing detection.** Free-text statements like "use Gemini for this one" or "switch to Codex" are detected by a small classifier (fast tier, single-call). When detection fires, Instar treats it identically to the explicit-command form.

Per the "intelligence over string matching" rule, the inline-phrasing check is an LLM call, not a regex. The classifier returns a structured `{ overrideRequested: bool, framework?, model?, scope: 'this-task' | 'this-pattern' }` and Instar applies it.

---

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────────┐
│ FrameworkModelRouter                                            │
│                                                                 │
│  task ─► classify ─► preferenceLookup ─► triggerCheck ─► ask?   │
│            │              │                  │           │      │
│            │              │                  │           ▼      │
│            ▼              ▼                  ▼     ┌────────┐   │
│       TaskClassifier  PreferenceStore  TriggerGate │Telegram│   │
│       (fast LLM)      (sqlite-backed)  (3-rule)    │Confirm │   │
│                                                    └────────┘   │
│                                                         │       │
│  decision ◄────────────────────────────────────────────┘       │
│     │                                                           │
│     ▼                                                           │
│  RoutingPolicy.decide (Phase 5c) ─► chosen adapter             │
└─────────────────────────────────────────────────────────────────┘
```

1. **`TaskClassifier`** — fast-tier LLM call (Haiku-class). Input: the task prompt and any context tags. Output: a `taskPattern` string (e.g., `"code-debug-typescript"`, `"summarize-meeting-transcript"`, `"shell-one-liner"`). The pattern is the cache key for preferences.

2. **`PreferenceStore`** — sqlite table keyed by `(userId, taskPattern)`. Columns: `framework`, `model`, `confirmedAt`, `costStateSnapshot` (JSON), `catalogVersionAtCache`, `confidenceAtCache`. Survives restarts. One row per user × pattern; updates on confirm.

3. **`TriggerGate`** — pure function. Inputs: cached preference (or null), current cost state, current catalog version, current confidence. Output: `'silent-use' | 'ask-new-pattern' | 'ask-cost-shift' | 'ask-low-confidence' | 'no-preference'`. The three "ask-*" outcomes are mutually exclusive — first-match wins in the priority order new-pattern > cost-shift > low-confidence.

4. **`TelegramConfirmer`** — sends a structured prompt to the user's bound Telegram topic and blocks on their reply. Replies parse via the inline-phrasing classifier (`use Gemini` / `c` for confirm / `n` for new pick / `/route reset`). Timeout: 5 minutes. On timeout, fall back to the catalog's default for the task pattern with a "(auto-defaulted due to no reply)" note in the response.

5. **`OverrideDetector`** — fast-tier LLM call. Input: each user message in active conversation. Output: `{ overrideRequested, framework?, model?, scope }`. Runs as a passive observer on EVERY user message in topics that have an active task; cost is bounded by `<= 1 cheap LLM call per inbound message`.

### Decision flow

1. Task arrives with origin (Telegram topic | autonomous job | background loop).
2. **If origin is not a live Telegram topic** → skip all UX, use catalog default, emit auto-pick note in the task's response stream.
3. **If origin IS a live Telegram topic:**
   a. Classify the task → `taskPattern`.
   b. Look up cached preference. If none → trigger = `ask-new-pattern`.
   c. Compute current cost state and current confidence. Compare with cached snapshot.
   d. Run `TriggerGate`. If `silent-use`, run the cached pick with auto-pick note. Done.
   e. If any `ask-*`, send the Telegram confirmation prompt, block.
   f. Parse reply. If confirmed → run with chosen pick, update cache. If override → run with override, update or not per scope.

### Cost budget

- 1 fast-tier LLM call per task for classification.
- 1 fast-tier LLM call per inbound user message for override detection.
- Telegram ask: 1 message out, 1 message in (plus optional override-detection on the reply).
- Storage: ~150 bytes per `(user, taskPattern)` cache row. Hundreds of patterns per user; well under 1MB total.

Classification is the dominant cost in normal operation — on the order of 100 tokens per request × $0.50/M = ~$0.00005 per task. Cheap enough to run on every task without an opt-out.

---

## Confirmation prompt shape

When the gate fires, Instar sends a Telegram message like this:

> ```
> About to run this task with Claude Code + Opus 4.7.
>
> Task: refactor the imessage adapter to use the new transport
> Pattern: code-refactor-typescript (confidence: HIGH)
> Reason for asking: new pattern, never seen this combination before
>
> Reply with:
>   ok / c / 👍       — go with this pick (cache for future)
>   no / try X        — pick X instead (free-text framework+model)
>   /route reset      — clear preferences for this pattern
>   one-shot / once   — use this pick but DON'T cache
> ```

The prompt MUST include:
- The pattern name (so the user can see what's being keyed).
- The reason for asking (which of the three triggers fired).
- The confidence the catalog reports for the proposed pick.
- The reply shorthand (so two-character replies suffice for the common case).

**No emoji-heavy framing, no marketing language.** This is an operator surface, not a consumer surface.

---

## Edge cases (locked behavior)

| Case | Behavior |
|---|---|
| Reply is unparseable | Re-ask once with shorthand reminder, then default to catalog pick after second unparseable reply. |
| User changes Telegram topic mid-task | Cache lookup is per-user, not per-topic. The cached pick still applies. |
| Catalog version changed mid-task | The decision was made against the version at task start. The cache row records the version-at-cache; next task re-checks. |
| User says "always use X" | The OverrideDetector returns `scope: 'this-pattern'`, updates cache. |
| User says "use X for everything" | Detected as a global-default change; Instar pushes back ("Setting global default to X — confirm?") rather than silently applying. This is a big-decision surface. |
| User explicitly asks "what would you pick?" | Instar runs the gate as if it were going to fire, emits the would-be prompt as informational text without blocking, runs normal flow. |
| Two Telegram messages arrive in quick succession | Override detection fires on each independently. Last-write wins for the same task. |
| Task origin is Telegram but the topic is muted / archived | Treat as "not a live topic" — auto-default with note. (User can recover the note from dashboard history.) |

---

## What's explicitly OUT OF SCOPE for Phase 5b

These belong to adjacent phases and are NOT part of this spec:

- The actual routing decision (which adapter wins given the pick) — that's Phase 5c.
- Cost / quota tracking infrastructure — already partly in `UsageMeterProvider`; Phase 5c extends.
- Catalog version / confidence semantics — defined by Phase 5a's `08-model-fitness-catalog.md` and `09-framework-fitness-catalog.md`.
- Benchmarking framework — Phase 5d.
- Open-source / local adapters — Phase 6.
- Dashboard surface for historical view of picks — separate UI work, not gated by this spec.

---

## Acceptance criteria

Phase 5b is complete when:

1. `TaskClassifier`, `PreferenceStore`, `TriggerGate`, `TelegramConfirmer`, `OverrideDetector` exist as implemented components in `src/providers/uxConfirm/`.
2. The composition root (server.ts wiring) constructs the `FrameworkModelRouter` and wires it ahead of `RoutingPolicy.decide`.
3. Round-trip Telegram test: a task originating from a Telegram topic produces a confirmation prompt in that topic and resumes on reply. Real Telegram, not mocked.
4. Cache survives server restart (sqlite-backed).
5. Three trigger-cases each have a passing unit test producing the right `ask-*` outcome with the right reason payload.
6. OverrideDetector correctly classifies at least 8 inline phrasing variants ("use Gemini", "switch to Codex", "try Opus for this", "force claude code", "let's try DeepSeek", "go with the cheaper one", "use whatever's free", "stick with the default") — with a confusion matrix recorded in `acceptance/phase-5b.json`.
7. Background / autonomous origin paths skip the UX entirely and auto-default — verified by a unit test.
8. ELI16 companion exists, is linked from this spec, and is sent to Justin's Telegram topic when Phase 5b ships.

---

## Open questions deferred to Phase 5c

These don't block Phase 5b spec lock-in, but Phase 5c needs to settle them:

- **Multi-user.** The cache is keyed by `(userId, taskPattern)`. What's the canonical `userId` when a task comes through a non-Telegram channel? (Default proposal: agent owner = primary user.)
- **Cost state granularity.** What counts as a "material" cost shift? (Default proposal: SDK credit pot crossing the safety margin OR Max subscription crossing 50% of session-window budget OR a new framework / model entering the catalog.)
- **Catalog version bumps.** Is every catalog edit a version bump? (Default proposal: only edits that change a confidence label OR add / remove a framework / model bump the version that the trigger gate checks.)

---

## References

- `04-anthropic-path-constraints.md` — Rules 1 & 2 (subscription floor + no direct API). The pick must respect these regardless of catalog preference.
- `08-model-fitness-catalog.md` — confidence labels and task-pattern entries.
- `09-framework-fitness-catalog.md` — compatible frameworks list (CLI-equipped only).
- `research/synthesis-nate-b-jones.md` — citations behind the catalog entries.
