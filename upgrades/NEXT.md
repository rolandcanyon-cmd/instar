# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

This release completes Promise Beacon Phase 1 (follow-ups to PR #72). Six capabilities land together:

- **`atRisk` non-terminal state** — `PromiseBeacon` accepts a `classifyProgress` signal. A "stalled" verdict moves the commitment into `atRisk`, fires a softer heartbeat, and doubles cadence. Signal-only — terminal `violated` still requires session-epoch mismatch or hard-deadline lapse. Follows signal-vs-authority: the classifier is a signal, higher-level gates hold authority.
- **Boot-cap enforcement** — on startup, if the active-beacon count exceeds the configured cap, overflow beacons are marked `beaconSuppressed: "boot-cap-exceeded"` while `status` stays `pending`. No silent withdraw. Configurable per-agent via `promiseBeacon.maxActiveBeacons` (default 20).
- **`PATCH /commitments/:id`** — update `nextUpdateDueAt`, `softDeadlineAt`, `hardDeadlineAt`, `cadenceMs`, `beaconEnabled` on existing commitments. Routes through `CommitmentTracker.mutate()`. Returns 400 on unknown field, 409 on terminal status.
- **Dashboard Commitments tab extension** — "Open Promises" list with cadence, last-heartbeat, state badge, and Mark-delivered action wired to `POST /commitments/:id/deliver`. XSS-safe.
- **`<active_commitments>` session-start injection** — new `GET /commitments/active-context` endpoint (≤20 most recent pending/atRisk + "+N more"). Wired into `session-start.sh` so agents see their own open promises after compaction.
- **PresenceProxy → shared `LlmQueue`** — optional `sharedLlmQueue` config on PresenceProxy; when passed, both monitors share daily spend cap and honour cross-monitor interactive-lane preemption via `AbortController`. Backwards-compatible: absent config keeps today's behaviour.

Combined with PRs #71 (CommitmentTracker single-writer `mutate` + CAS) and #72 (beacon core, ProxyCoordinator, delivery endpoint), the follow-through heartbeat infrastructure is feature-complete for Phase 1.

## What to Tell Your User

- **I can now watch my own promises.** "When I say 'back in an hour,' I can actually mark it as a promise — the system watches the clock, and if I go quiet past the check-in time, it sends you a short 'still alive, still working' note on its own."
- **I'll flag myself when I look stuck.** "If my progress looks stalled, the promise goes into a 'looks stuck' middle state and you get a softer heads-up — not a full 'it died,' just a check-in."
- **You can change a promise's timing.** "If I said 'back in ten minutes' but it's going to take twenty, you can ask me to stretch the clock."
- **There's a board you can check.** "The dashboard now has an 'Open Promises' section. You can see every promise I'm currently on the clock for, when the next beat is due, and mark one as done."
- **I remember my promises across memory resets.** "When my memory gets packed down, I now reload a short list of what I'm still on the clock for, so I don't forget."

## Explicitly Still Deferred

- Audit log (`.instar/state/promise-beacon/audit.jsonl`)
- `paused` status (30-min non-terminal hold on session-UUID mismatch)
- Explicit `atRisk`-clear endpoint
- CommitmentSentinel shadow mode (Phase 2)
- Live dashboard updates (pull-based today)

None of these block the feature from working.
