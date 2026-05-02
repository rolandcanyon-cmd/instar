# Side-Effects Review — Compaction-resume payload carries real context

**Version / slug:** `NEXT` (will be assigned on publish)
**Date:** `2026-04-17`
**Author:** `echo`
**Second-pass reviewer:** `(this is a prompt-shape fix with no Guard surface — second pass not required per skill Phase 5)`

## Summary of the change

Replaces the one-sentence `COMPACTION_RESUME_PROMPT` constant with a payload built from `topicMemory.formatContextForSession(topicId, 20)` (summary + last 20 real messages + search hint). For Slack and TopicMemory-not-ready fallback, the same payload is built from inline log entries via a new `formatInlineHistory` helper. A `prepareInjectionText` helper writes payloads over 500 chars to `/tmp/instar-compaction-resume/` and replaces the inject with a "read this file immediately" reference — matching the `spawnSessionForTopic` bootstrap pattern.

Slack recovery path picks up `findLastRealMessage` as well, so proxy standbys / delivery acks newer than the user's message no longer mask unanswered state.

## Over-block risk

**None.** The decision of whether to recover is unchanged — `lastReal?.fromUser` still gates re-injection on both paths. The change is purely in the *content* of the injected text. No new filter, no new gate, no new "do not recover" conditions.

## Under-block risk

**None.** The module doesn't classify or authorize anything; it builds strings. The existing InputGuard check in `sessionManager.injectMessage` still applies — the Telegram inject still starts with `[telegram:${topicId}]` so provenance is `verified`, bypassing the Layer 1.5 injection-pattern check (unchanged behavior).

## Level-of-abstraction fit

The new module sits at `src/messaging/shared/` alongside `isSystemOrProxyMessage.ts` — same layer as other prompt/classifier helpers shared between the Telegram and Slack messaging paths. It does **not** reach into `SessionManager` internals, does **not** reinvent `InputGuard` logic, and does **not** read/write any state-dir files. It only writes to `/tmp`, which matches the `spawnSessionForTopic` bootstrap pattern (`/tmp/instar-telegram/`).

## Signal-vs-authority compliance

Not applicable. The preamble is a **prompt to the agent**, not a gate with blocking authority. It can only influence; the agent still decides what to say. There is no downstream check that treats the preamble's output as authoritative.

## Interactions

- **`isSystemOrProxyMessage` / `findLastRealMessage`** — now used on both Telegram and Slack recovery paths. Existing contract preserved: filters system/proxy entries, walks backward, returns last real entry. Slack log entries have the same `{ text, fromUser, timestamp }` shape the classifier expects.
- **`topicMemory.formatContextForSession`** — already used on the session-spawn path. The compaction-resume path now calls the same function with the same args (`recentLimit=20`). No new dependency; no new failure modes.
- **`sessionManager.injectMessage`** — receives a larger text in the common case. Input handling unchanged: bracketed-paste mode for multi-line content. The 500-char file-threshold keeps us inside the spawn-path's tested envelope.
- **`PresenceProxy`** — unaffected. Continues to call `isSystemOrProxyMessage` unchanged.
- **`CompactionSentinel`** — unaffected. It calls `recoverCompactedSession` with the same signature and interprets the boolean return value the same way.
- **`checkLogForAgentResponse`** — unaffected. Same classifier delegate, same log-scan semantics.
- **`InputGuard` Layer 2 (coherence review)** — the new payload has more context, which may change LLM verdicts at the margin, but the review is non-blocking (inject already happened) and only emits a warning message. No blocking impact.

## Rollback cost

**Low.** The new module is purely additive — nothing else depends on it. To roll back: revert `src/commands/server.ts` to use the one-line `COMPACTION_RESUME_PROMPT` constant, delete `src/messaging/shared/compactionResumePayload.ts`, delete `tests/unit/compactionResumePayload.test.ts`. No schema changes, no state-file migrations, no API contract changes.

## File-system footprint

The file-reference path creates one file per compaction event in `/tmp/instar-compaction-resume/resume-<topicId>-<ts>-<uuid>.txt`. `/tmp` is cleaned on macOS reboot; files are small (one summary + ~20 messages, typically <10KB). For bounded hygiene we rely on the OS reboot sweep — same as the existing `/tmp/instar-telegram/` and `/tmp/instar-paste/` dirs. No new disk-leak risk.

## Test coverage

`tests/unit/compactionResumePayload.test.ts` (12 tests) covers:
- Preamble shape and empty-context handling
- Inline history formatting (sender, timestamp, truncation, missing fields)
- File-threshold cutover + stub language
- Topic 6795 regression shape — user's verbatim last message survives the pipeline

Existing `tests/unit/isSystemOrProxyMessage.test.ts` (25 tests) still green — the walk-back contract now used on both recovery paths is unchanged.

## Failure modes explicitly left unfixed

- **Huge conversation summaries.** If `topicMemory`'s rolling summary itself exceeds some absurd size, the file-reference payload could grow large. We cap at `recentLimit=20` messages + summary, so in practice this tops out at ~20–50 KB. Not a concern at current scale; will revisit if we hit it.
- **Racing compaction events.** If two triggers (PreCompact hook + watchdog poll) fire within milliseconds, `CompactionSentinel` already dedupes — unchanged here.
