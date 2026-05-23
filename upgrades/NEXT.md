# Instar Upgrade Guide — vNEXT (Codex-instar audit batch)

<!-- bump: patch -->

## What Changed

Audit pass against instar running on Codex agents. Multiple framework-level fixes from codey's shortcomings inventory. NOT YET PUBLISHED — Justin reviews before deploy.

### Item 1: `/threadline/relay-send` now respects caller priority

Previously the endpoint hardcoded `priority: 'medium'` on every local-delivery envelope. Critical coordination traffic was indistinguishable from routine sends on the recipient side, which starved the spawn-cap override policy and caused urgent cross-agent messages to be denied at the session cap.

Now: the endpoint accepts `priority` on the request body, validates against `MessagePriority` (`'critical' | 'high' | 'medium' | 'low'`), rejects unknowns with 400, and defaults to `'medium'` only when caller omits the field.

**Scope:** local-delivery path only. The remote-relay (WebSocket) envelope schema does not currently carry priority on the wire; that's a separate, deeper change.

## Evidence

- New integration tests: `tests/integration/threadline-relay-send-priority.test.ts` — 6 tests, all pass. Verifies critical/high/low propagation, medium default, 400 on unknown string, 400 on non-string.
- Empirical confirmation on the codey codex-cli agent: `/threadline/relay-send` with `priority: "bogus"` returns 400 with the documented error; with `priority: "critical"` validates and proceeds.

## Rollback

One file, one block of validation logic + a single-line envelope change. Revert `src/server/routes.ts` and delete the new test file.
