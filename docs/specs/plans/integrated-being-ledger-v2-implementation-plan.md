---
title: "Integrated-Being Ledger v2 — Implementation Plan"
author: "echo"
created: "2026-04-17"
spec: "docs/specs/integrated-being-ledger-v2.md"
status: "in-progress — slices 1+2 shipped; slice 3 (commitment kind + mechanism-ref) starting 2026-04-17"
---

# Integrated-Being Ledger v2 — Implementation Plan

## Why a plan, not a single build

The v2 spec is ~450 lines across 17 new config knobs, 3 new endpoints, 1 new class (LedgerSessionRegistry), dashboard additions, tone-gate detector integration, and 5 emitters. Jamming all of that into one `/build` session guarantees either a half-finished implementation or a monster PR that can't be reviewed. Slicing makes every landing safe behind the `v2Enabled=false` feature flag, and each slice gets its own side-effects artifact.

## Slice inventory

| # | Slice | What it lands | Size | Depends on |
|---|-------|---------------|------|------------|
| 1 | **Foundation** | `commitment` entry kind types + `LedgerSessionRegistry` class + session-start hook token file + `POST /shared-state/append` endpoint (auth, no commitment-specific logic yet) | ~800 LOC incl. tests | — |
| 2 | Resolution | `POST /shared-state/resolve/:id` with PIN-unlock for user-resolve path, idempotency via `dedupKey` | ~400 LOC | 1 |
| 3 | Interactive bind fallback | `POST /shared-state/session-bind-interactive` with hook-in-progress flag attestation | ~300 LOC | 1 |
| 4 | Disputes | `disputes: <id>` field (not `supersedes` chain), per-session-per-hour cap, count derived from ledger at render | ~300 LOC | 1 |
| 5 | Dedup + normalization | NFKC + Unicode confusables skeleton, absolute-TTL dedup index, aggregation-legitimization signal | ~500 LOC | 1 |
| 6 | Emitters + sweeps | `expired`, `stranded`, dedup-rollover emitters; periodic sweep job | ~300 LOC | 1, 4 |
| 7 | Dashboard | Live commitment tab, overdue highlighting, resolution controls | ~600 LOC | 2, 4 |
| 8 | Utterance detector | Tone-gate hook that flags outbound messages containing future commitments; feeds signal to existing authority (never blocks) | ~400 LOC | 1 |

Total landable body of work: ~3600 LOC incl. tests, 8 separate side-effects artifacts, 8 separate commits. Each slice ships gated on `v2Enabled=false` so the install base is unaffected until we flip.

## Why Slice 1 is the right starting point

Every other slice either writes to the append endpoint (2, 4, 5, 8) or reads from it (6, 7). Until the append surface exists, everything else is either stubs or parallel implementations. Slice 1 is the irreducible foundation.

## Slice 1 — detailed plan

### Problem

v1 shipped a read surface and server-side emitters. Sessions cannot write to the ledger. The foundation for v2 is a sanctioned session-write API with:

- A durable session identity separate from tmux SessionManager.
- Token-file binding at session-start, with 0o600 mode, atomic rename, mode verification.
- Authenticated append that records a typed entry.

### Files touched

- `src/shared-state/types.ts` (NEW) — TypeScript types for `commitment` entry kind, `CommitmentFields`, `MechanismSpec`, `ResolutionSpec`. Non-runtime.
- `src/shared-state/LedgerSessionRegistry.ts` (NEW) — class: register, getToken, verifyToken, revoke, purgeExpired. In-memory Map with file-backed persistence in `.instar/session-binding/`.
- `src/shared-state/append.ts` (NEW) — the request handler for `POST /shared-state/append`. Validates session header + token, writes to shared-state.jsonl via the existing append machinery.
- `src/server/routes.ts` (MODIFY) — register the new route. Gated on `config.sharedState.v2Enabled`.
- `src/hooks/session-start-register-ledger.ts` (NEW) — SessionStart hook that eager-registers the session with LedgerSessionRegistry and writes the token file. Fail-closed on mode mismatch.
- `src/config/schema.ts` (MODIFY) — add `sharedState.v2Enabled`, `sharedState.tokenAbsoluteTtlHours`, `sharedState.maxWritesPerMinuteGlobal`. Default `v2Enabled: false`.
- `tests/unit/LedgerSessionRegistry.test.ts` (NEW) — unit coverage: register, verify, mode-check fail-closed, atomic rename, expired purge.
- `tests/unit/shared-state-append.test.ts` (NEW) — unit coverage: auth failure, success path, header/token binding, rate-limit.
- `tests/integration/shared-state-v2-foundation.test.ts` (NEW) — integration: spawn a session, verify token file, call append with token, verify entry appears in ledger.

### Decision points in this slice

1. **Token-file mode check** — fails closed on mode ≠ 0o600. Brittle-by-design; this is hard-invariant validation on a security boundary. Per `docs/signal-vs-authority.md` this is in the "safety guard on irreversible actions" category — brittle is correct.
2. **Session token validation on append** — structural validator at API edge. Brittle is correct (hard-invariant).
3. **Global rate-limit on append** — mechanics/transport layer. Brittle is correct.
4. **`v2Enabled` feature flag** — gating the route at registration time. Brittle is correct (boolean flag, deterministic).

None of the decision points in Slice 1 are judgment calls. No brittle blocker holds authority over a semantic question. Signal-vs-authority compliance is straightforward for this slice.

### Acceptance criteria

- `config.sharedState.v2Enabled: false` (default) → `POST /shared-state/append` returns 404 as if route doesn't exist.
- `config.sharedState.v2Enabled: true`:
  - Session without a valid token → 401.
  - Session with a valid token → 200 with entry appended and `id` in response.
  - Session token file missing 0o600 → 500 with specific error, no token accepted.
  - Rate limit exceeded (>100/min global) → 429 with Retry-After header.
- Session-start hook fires cleanly on fresh session start.
- All new files pass TypeScript strict mode.
- Full test suite passes (`npm run test:push`).

### Rollback path

Pure code rollback. No persistent state to clean up other than `.instar/session-binding/` token files. Those are harmless if left behind; they expire via absolute TTL and will be purged on next session start. No schema migrations, no data migrations. Revert the commit, ship a patch release.

### Out of scope (explicitly)

- Commitment-specific logic (deadlines, mechanism validation, resolution workflow) — that's Slice 2.
- REST interactive bind fallback — that's Slice 3.
- Disputes, dedup, dashboard, emitters, utterance detector — slices 4–8.
- Flipping `v2Enabled` to true for any user — that's a release decision after the 7-day observation window, not a slice.

## Proposed landing cadence

- One slice per day of focused work, each with its own commit, artifact, and release.
- Slices 1–6 must land before v2 can be flipped on for observation.
- Slice 7 (dashboard) and Slice 8 (utterance detector) land at/after v2 flips on, because they surface signals users observe and read.
- Full v2Enabled=true flip happens only after 7-day observation with slices 1–6 healthy on the install base.

## Open questions carried from convergence (not blocking Slice 1)

1. **Session-bind privilege separation** (for Slice 3) — Unix socket vs lifecycle-admin token?
2. **Formal status state machine** (for Slice 2) — enumerate legal state transitions explicitly?
3. **Interactive-bind challenge-response** (for Slice 3) — prevent replay of fallback bind tokens?

These are deferred to the slice that touches them. Slice 1 doesn't need resolution.
