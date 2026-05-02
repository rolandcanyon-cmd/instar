---
title: "Compaction-resume payload carries real context (summary + recent messages + search hint)"
slug: "compaction-resume-payload"
author: "echo"
created: "2026-04-17"
supersedes: "none — follow-up to docs/specs/compaction-recovery-proxy-filter.md"
review-convergence: "2026-04-17T23:55:00.000Z"
review-iterations: 1
review-completed-at: "2026-04-17T23:55:00.000Z"
approved: true
approved-by: "justin (via 'please pick back up our work here so we can finish this out' authorization on topic 6795, 2026-04-17)"
approved-at: "2026-04-17T23:57:00.000Z"
approval-note: "Design was validated in-conversation: Justin pushed back on my initial proposal to include explicit intent-quoting ('I'm actually not sure why we would need to tell the new session what the intent was'), arriving at the final shape — rich context block (summary + recent messages + search hint) with the session deciding how to continue. Explicit go-ahead: 'Please pick back up our work here so we can finish this out.'"
---

# Compaction-Resume Payload Carries Real Context

## Problem Statement

The prior fix (`compaction-recovery-proxy-filter`, shipped as 0.28.51) closed the **mechanical** failure of the compaction-recovery path: `recoverCompactedSession` was declining to re-inject because `findLastRealMessage` wasn't filtering PresenceProxy standby messages. That fix shipped and the recovery path now fires correctly.

But a screenshot from topic 6484 (2026-04-17, "commitment-backing gap + infra research") surfaced a deeper **semantic** failure: even when re-injection fires correctly, the prompt that gets injected is a single sentence telling the agent to "read the recent messages in this topic to re-orient, briefly let the user know compaction occurred, then continue where you left off."

In that screenshot, the user said "Okay, you really need to hand hold me through whatever I need to do here." The post-compaction response was: "Back from compaction. Re-oriented: integrated-being-ledger-v2 slices 1-7 shipped and pushed to origin. v2Enabled still false by default. Awaiting your cadence call — flip now to start the 7-day observation, defer until slice 8 hardening lands, or park. No autonomous next step until you decide."

That response is internally coherent with the **work state** but answers nothing the user asked. With no actual context in front of it, the recovered agent reconstructs a plausible-sounding status summary instead of engaging with the user's actual last message.

## Root Cause

The session-spawn path (`spawnSessionForTopic`) already builds rich context via `topicMemory.formatContextForSession(topicId, 50)` — a block that contains:
- Topic name + total message count
- Current focus / purpose line
- **CONVERSATION SUMMARY** — LLM-generated rolling summary
- **RECENT MESSAGES** — last N messages with sender/timestamp/text
- Search hint: `To search conversation history: curl /topic/search?topic=TOPIC_ID&q=QUERY`

The compaction-resume path ships none of this. It sends a one-line instruction and expects the agent to go fetch context itself. Empirically, agents don't — they reconstruct a plausible summary from training priors about what a post-compaction message looks like.

## Fix

Introduce `src/messaging/shared/compactionResumePayload.ts` with three helpers:

- `COMPACTION_RESUME_PREAMBLE` — structured recovery preamble injected before the context block. Originally (v0.28.52) a single loose sentence ("Briefly let the user know compaction occurred, then continue the conversation naturally."). Rewritten in v0.28.66 after two empirical failure modes on active sessions: (1) agents self-narrating as "I lost track" / "I got lost" despite having full context, and (2) agents regenerating a status summary and handing delegated decisions back to the user. The v0.28.66 preamble uses three numbered instructions: (1) open with a calm "paused for context compaction and has now resumed" statement — specific forbidden phrases listed; (2) respond to the user's MOST RECENT message — if it was a delegated decision, make the decision; (3) assume full continuity with any in-progress work. The over-threshold branch in `prepareInjectionText` carries the same guardrails so long-context recoveries get identical instructions.
- `formatInlineHistory(entries, opts)` — renders a list of `{text, fromUser, timestamp, senderName}` entries as a bordered block with sender/timestamp/text. Used as the fallback when topicMemory isn't available (and as the primary context source for Slack, where no SQLite summarizer exists).
- `buildCompactionResumePayload(contextBlock)` — concatenates preamble + context block.
- `prepareInjectionText(payload, triggerLabel, identifier)` — if the payload is over 500 chars (the bracketed-paste comfort threshold used by the bootstrap path), writes it to `/tmp/instar-compaction-resume/` and returns a "read this file immediately" stub. Otherwise returns the payload verbatim.

Route both the Telegram and Slack recovery paths through the same helpers:

**Telegram** (`recoverCompactedSession` in `src/commands/server.ts`):
- Prefer `topicMemory.formatContextForSession(topicId, 20)` for the context block.
- Fall back to `formatInlineHistory(telegram.getTopicHistory(topicId, 20))` when topicMemory isn't ready.

**Slack** (the `slackRecover` deferred handler in `src/commands/server.ts`):
- Load up to the last 20 log entries for the channel from `slack-messages.jsonl`.
- Walk back via `findLastRealMessage` (same filter the Telegram path uses) — previously slack only checked the single most-recent entry, so any from-agent log line newer than the user's message masked the unanswered state.
- Build the context block via `formatInlineHistory`.

## Side Effects

See `upgrades/side-effects/NEXT.md` (will be assigned a version number on publish) for the full review. Summary:

- **Over-block risk**: None. The decision of whether to recover is unchanged — `lastReal?.fromUser` still gates re-injection on both paths. The change is purely in the *content* of the injected text.
- **Under-block risk**: None. The module doesn't classify or authorize anything; it builds strings. InputGuard's existing checks still apply.
- **Signal-vs-authority**: Not applicable — the preamble is a prompt to the agent, not a gate with blocking authority.
- **Interactions**: reuses `topicMemory.formatContextForSession` (already used on the session-spawn path), `findLastRealMessage` (extended to Slack), `sessionManager.injectMessage` (receives larger text, handled by bracketed-paste + file-threshold). No new dependencies, no contract changes.
- **Rollback cost**: Low — new module is purely additive. Revert server.ts to use the one-line constant, delete the new module + test. No schema/state/API changes.

## Test Coverage

`tests/unit/compactionResumePayload.test.ts` (12 tests):
- Preamble-only payload when context block is empty
- Preamble + context concatenation with blank-line separator
- Preamble content requirements (mentions compaction, tells agent to let user know, asks for natural continuation)
- `formatInlineHistory` — sender/timestamp/text rendering, generic "User" fallback, 2000-char truncation, missing timestamp handling
- `prepareInjectionText` — pass-through under threshold, file-reference stub over threshold, custom threshold support
- Integration test anchored on the topic-6795/topic-6484 shape: user's verbatim last message ("Okay, you really need to hand hold me through whatever I need to do here") survives into the final payload
