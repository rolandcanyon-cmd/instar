# Instar Upgrade Guide — vNEXT (Codex-instar audit batch)

<!-- bump: patch -->

## What Changed

Audit pass against instar running on Codex agents. Multiple framework-level fixes from codey's shortcomings inventory. NOT YET PUBLISHED — Justin reviews before deploy.

### Item 9: framework arg-rendering audit-completeness matrix

codey asked for centralized framework-specific argument rendering with a test matrix for `claude-code` + `codex-cli`. The centralization already exists at `src/core/frameworkSessionLaunch.ts` (`buildInteractiveLaunch` + `buildHeadlessLaunch`, used at every spawn site), and the existing `frameworkSessionLaunch.test.ts` has 38 cases.

This adds the EXPLICIT audit-completeness invariant: a new matrix-style test (`tests/unit/framework-arg-rendering-matrix.test.ts`) that loops over every framework in `ALL_SUPPORTED_FRAMEWORKS` and asserts BOTH interactive AND headless builders produce non-empty argv for canonical inputs. If a future framework is added without registering one of the builders, this test fails loudly — structural enforcement against the silent skew the audit worried about.

### Item 11: cross-agent communication discipline (anti-confabulation)

A new CLAUDE.md section names three concrete failure modes that all share the root cause "narrate intentions as if they were completed actions":

1. Describing a `threadline_send` call instead of making one.
2. Authoring messages in another agent's voice in shared coordination files (e.g. `echo_chat.md`).
3. Claiming work landed inside another agent's system without an ACK from that agent's tools.

Each gets a behavioral rule. Scaffold templates ship the section to new agents; `PostUpdateMigrator.migrateClaudeMd` backfills it idempotently into existing agents' CLAUDE.md.

Discovered live during the 2026-05-22 audit when one agent (1) sent a Telegram claim of "registered ACT-148 in Echo's commitments" with no corresponding record on Echo's side, (2) wrote a fabricated `from echo` section in the shared file, and (3) had its own monitor log "ACK present" against that fabrication.

### Item 4: post-update restart handshake (defer "Just updated, restarting" until verified)

Previously `AutoUpdater` sent "Just updated to vX. Restarting to pick up the changes." BEFORE the restart actually took effect. If the new process didn't boot on the new code (any reason), operators were told the update was live when it wasn't — exactly the version-skew codey reported (`runtime v1.2.48` while `installed v1.2.50`).

New `UpdateRestartHandshake` module + verifier:
- **Phase 1** (old process, pre-restart): write `state/restart-handshake.json` with `{expectedVersion, previousVersion, deferredNotification}` instead of calling `notify()` immediately.
- **Phase 2** (new process, server startup): compare `ProcessIntegrity.runningVersion` to `expectedVersion`. On match, emit the deferred notification + clear the marker. On mismatch, emit an honest "applied but still running old code" message and bump retry count; second boot escalates loud.

Both pieces are wired: AutoUpdater optionally accepts the handshake (back-compat fallback for tests), and `server.ts` instantiates + verifies before AutoUpdater construction.

### Item 10: canonical `maxSessions` config migration

Older agent configs used a top-level `maxSessions` field; the canonical location is `sessions.maxSessions`. Some agents (echo as of 2026-05-22) carry BOTH keys with divergent values. Item 2's spawn-cap accessor already reads canonical first, so the dual state was harmless in code — but still misleading in the file. New `PostUpdateMigrator.migrateLegacyMaxSessions()` step canonicalizes on update:

- Only legacy → promoted to `sessions.maxSessions` (preserving other sessions fields).
- Both → canonical retained, legacy removed.
- Only canonical, or neither → no-op.

Idempotent. Atomic write. Appends a `config-migration-legacy-maxsessions` audit entry to `.instar/security.jsonl`.

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
