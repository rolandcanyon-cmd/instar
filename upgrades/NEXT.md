# Instar Upgrade Guide — vNEXT (Codex-instar audit batch)

<!-- bump: patch -->

## What Changed

Audit pass against instar running on Codex agents. Multiple framework-level fixes from codey's shortcomings inventory. NOT YET PUBLISHED — Justin reviews before deploy.

### Item 5: scheduler default-on (autonomy continuity)

Previously `Config.ts` resolved `scheduler.enabled` to `false` when the file didn't specify it. Codex agents (and any agent shipping without explicit scheduler config) silently lost autonomy-continuity tasks — org-intent drift audits, threadline sync, post-update self-healing — anything that runs on the scheduler.

Now: the runtime fallback is `true`. `ConfigDefaults.SHARED_DEFAULTS` adds `scheduler: { enabled: true }` so PostUpdateMigrator backfills the field on existing agents whose config block is missing it. Agents with an explicit `enabled: false` are preserved (operator choice wins).

Empirical: codey went from `/status.scheduler === null` to `{ running: true, jobCount: 27, enabledJobs: 27, activeJobSessions: 1 }`.

### Item 2: SpawnRequestManager reads session cap via live accessor

Previously the manager cached `maxSessions` at construction. Operators who raised `sessions.maxSessions` in the config saw `/status` reflect the new cap, but threadline spawn-denial payloads kept reporting the old cap (e.g. `Session limit reached (15/10)` while `/status.sessions.max` = 30). codey identified this split-brain on echo's live state.

Now: an optional `getMaxSessions: () => number` accessor is consulted on every admission check; the construction site passes a closure that reads `config.sessions?.maxSessions ?? config.maxSessions ?? 5`. The constructor `maxSessions` remains as a back-compat fallback. Denial messages report the live value. This also dissolves the legacy-vs-canonical `maxSessions` ambiguity at read time (audit Item 10 will canonicalize the config key itself).

### Item 1: `/threadline/relay-send` now respects caller priority

Previously the endpoint hardcoded `priority: 'medium'` on every local-delivery envelope. Critical coordination traffic was indistinguishable from routine sends on the recipient side, which starved the spawn-cap override policy and caused urgent cross-agent messages to be denied at the session cap.

Now: the endpoint accepts `priority` on the request body, validates against `MessagePriority` (`'critical' | 'high' | 'medium' | 'low'`), rejects unknowns with 400, and defaults to `'medium'` only when caller omits the field.

**Scope:** local-delivery path only. The remote-relay (WebSocket) envelope schema does not currently carry priority on the wire; that's a separate, deeper change.

## Evidence

- New integration tests: `tests/integration/threadline-relay-send-priority.test.ts` — 6 tests, all pass. Verifies critical/high/low propagation, medium default, 400 on unknown string, 400 on non-string.
- Empirical confirmation on the codey codex-cli agent: `/threadline/relay-send` with `priority: "bogus"` returns 400 with the documented error; with `priority: "critical"` validates and proceeds.

## Rollback

One file, one block of validation logic + a single-line envelope change. Revert `src/server/routes.ts` and delete the new test file.
