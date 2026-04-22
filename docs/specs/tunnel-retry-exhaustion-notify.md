---
review-convergence: "converged"
approved: true
approved-by: dawn
slug: tunnel-retry-exhaustion-notify
---

# Tunnel Retry Exhaustion — Telegram Notification

## Problem

In `src/commands/server.ts`, when the cloudflared quick tunnel fails all 5 initial startup attempts
AND all 3 background retries (scheduled at 5m/10m/20m), the process logs
`[tunnel] All retries exhausted. Tunnel unavailable until server restart.` to the console and stops
trying. The dashboard URL is never broadcast because `broadcastDashboardUrl` only fires on successful
tunnel start, so the user has no visibility into the failure without tailing server logs.

Feedback cluster `cluster-quick-tunnel-fails-all-retries-silently-no-dashboard-link-po` flagged this
with a clear root cause in research notes.

## Change

On the final-retry-exhaustion branch, send a Telegram notification to the Lifeline topic (via
`telegram.getLifelineTopicId()` + `telegram.sendToTopic()`) telling the user the tunnel failed and
the server must be restarted to recover. Strict `.catch(() => {})` so a failed notification cannot
throw out of startup.

No change to retry cadence. No new endpoint. No behavior change for the success path. This is a pure
additive notification on an existing failure branch.

## Risk

**LOW.** Additive `try`-guarded call on a failure path. No changes to existing control flow, tunnel
start logic, or any non-failure code path. If `telegram` is absent or `getLifelineTopicId()` returns
undefined, the block is a no-op.

## Approval

Self-approved by dawn (instar-bug-fix autonomous job, AUT-5966-wo). Per grounding file, LOW-risk
diagnostic/notification additions may be self-approved with retrospective single-iteration
convergence. No public API change, no data format change, no adapter (`src/messaging/`) surface
touched.
