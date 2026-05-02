---
title: "Compaction recovery proxy-filter fix (shared isSystemOrProxyMessage module)"
slug: "compaction-recovery-proxy-filter"
author: "echo"
created: "2026-04-17"
review-convergence: "2026-04-17T17:00:00.000Z"
review-iterations: 1
review-completed-at: "2026-04-17T17:00:00.000Z"
approved: true
approved-by: "echo-autonomous"
approved-at: "2026-04-17T17:00:00.000Z"
---

# Compaction Recovery Proxy-Filter Fix

## Problem Statement

When a session hit context compaction, `recoverCompactedSession` was deciding "is there pending work to re-inject?" by looking at the last message in the topic without filtering out PresenceProxy standby messages (`🔭 …`) or server-emitted delivery/lifecycle acks (`✓ Delivered`, `Session respawned.`). Those messages are `fromUser: false` but they are NOT real agent responses. Treating them as "agent answered" caused the compaction-recovery safety net to decline three consecutive re-inject attempts while the user sat with an unanswered question for ~15 minutes (topic 6795, 2026-04-17).

## Root Cause

Three separate copies of the system-message prefix list existed:
1. `PresenceProxy.isSystemMessage()` — instance method with inline list
2. `checkLogForAgentResponse()` in `server.ts` — separate inline copy
3. `recoverCompactedSession`'s "has agent responded" check — **missing entirely**

The recovery path was the only one that had no filter at all.

## Fix

Hoist the prefix classifier into a shared module (`src/messaging/shared/isSystemOrProxyMessage.ts`) with:
- `isSystemOrProxyMessage(text)` — single classifier, all consumers route through it
- `findLastRealMessage(history)` — walk-back helper that scans backward past system/proxy messages

Update `PresenceProxy`, `server.ts` (via dynamic import), and `recoverCompactedSession` to use the shared module. Add 25-test unit suite that includes an exact topic-6795 regression anchor.

## Side Effects

See `upgrades/side-effects/0.28.52.md` for full review.

**Over-block risk**: None. The classifier only classifies messages with exact prefix/content patterns (`🔭`, `✓ Delivered`, `Session respawned.`, etc.) — the same patterns that were already in use in two of three callsites.

**Under-block risk**: Any new system message format not in the list would still appear as "real" — same as the pre-fix state. The single list makes future additions propagate to all consumers for free.

**Signal-vs-authority**: Classifier is a pure signal; it does not gate or block. Consumers decide what action to take with the signal. Compliant.
