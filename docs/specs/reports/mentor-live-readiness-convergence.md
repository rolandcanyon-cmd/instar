# Convergence Report — Mentor live-readiness

**Spec:** `docs/specs/MENTOR-LIVE-READINESS-SPEC.md`
**Iterations:** 2 rounds, 3 reviewers each round (lessons-aware, integration, adversarial)
**Co-designer:** instar-codey (Threadline thread 5cc61bd7, §Fix 2 mentee-side pickup)
**Outcome:** CONVERGED. Fix direction (real /idle endpoint + Codey-designed outbox pickup +
quota-aware budget+notify) endorsed by all reviewers in both rounds.

## Round 1 verdicts

| Reviewer | Verdict | Headline |
|----------|---------|----------|
| Lessons-aware | APPROVE-WITH-CHANGES (6) | Anti-loop behavioral not structural; #425 test-gap not closed; budget dedup wrong shape |
| Integration | APPROVE-WITH-CHANGES (6) | QuotaTracker null fail-open; TokenLedger attribution shape; SafeFs append guidance; migration removal step |
| Adversarial | APPROVE-WITH-CHANGES (8) | `/sessions` Bearer-authed + no `activelyWorking` field → original probe unimplementable; cross-agent fs symlink/TOCTOU; delivery-failure silent; schema negotiation; dailySpendCapUsd silent removal |

## Round 2 verdicts

| Reviewer | Verdict | Notes |
|----------|---------|-------|
| Lessons-aware | CONVERGED | All 6 round-1 findings closed; no new lessons violations |
| Integration | STILL-CHANGES → CONVERGED after 3 small additions | Echo-independence on /idle absence; budget-notifications JSON shape + concurrency; `GET /mentor/contract` capability/AAS parity |
| Adversarial | STILL-CHANGES → CONVERGED after 2 small additions | State-machine concurrency (CAS + corrupt-file recovery); parent-symlink realpath defense |

## Findings closed (round 1 + round 2)

**Structural / anti-loop:**
- Stage-B reply ingestion = `capture()`-only; explicit "no path to spawn/deliver" + unit test pinning it (lines 244-254, test #4 + 7).
- Import-surface lint on mentor-delivery module (test #6) — anti-loop is now compile-time.
- `GET /idle` unauthenticated + structured (schemaVersion/bootId/uptimeSec/activeSessions);
  fail-closed on every ambiguous outcome; liveness inferred from heartbeat.
- Cross-agent fs writes: lstat-reject symlinks + realpathSync parent check (TOCTOU/
  parent-symlink defense); menteeStateDir allowlist refuses misconfig (refuse-to-start).
- `deliverToMentee` returns `{ok,reason}`; on failure tick reports `delivered:false` +
  dedup'd Attention entry.

**Budget:**
- Trip-EPISODE state machine (not day-bucket); alerts on `ok→tripped` AND `tripped→ok`.
- File-backed persistence at `state/mentor-budget-notifications.json` via
  `SafeFsExecutor.atomicWriteJsonSync` — survives server restart.
- Explicit JSON shape + CAS single-writer + corrupt-file recovery (degradation event).
- QuotaTracker null/stale → fail-closed (`reason: quota-unknown`), overriding the default
  fail-open.
- TokenLedger sum via prefix-match `mentor-stage-b::%` (attribution_key shape correction)
  via thin `byComponent` helper.

**Schema versioning:**
- `MENTOR_CONTRACT_VERSION` export + `GET /mentor/contract` (unauthenticated).
- Reader-first rule for breaking bumps; CI changelog gate.
- Both sides dead-letter unknown schemaVersion (not crash, not silent).

**Migration:**
- `dailySpendCapUsd` removal is NOT silent if user set a non-default value — emit one
  Attention entry explaining it was decorative (don't repeat the silent-dead-config bug).
- Additive new fields via `ConfigDefaults.getMigrationDefaults()` + `applyDefaults`.
- Explicit removal step modeled on `migrateLegacyMaxSessions`.

**Coordination:**
- Echo's side ships independently of Codey's PR; absent `/idle` → continuous `mentee-busy`
  defers + degradation event (NOT refuse-to-start). Graduated-rollout pattern.
- `GET /mentor/contract` route gets CapabilityIndex prefix classification + CLAUDE.md
  template entry (Agent Awareness Standard).

**Testing — the #425 gap is closed:**
- Bidirectional integration test: fixture poller writes delivery + reply, Echo Stage-B
  parses; asserts next tick still defers (no auto-recurrence).
- Wiring-integrity test: production deps non-null, non-no-op.
- Import-surface lint.
- Fail-closed coverage on every ambiguous probe outcome.
- E2E supervised live cycle is the final test (gated on both sides shipped).

## Standards conformance

- Testing Integrity: 7 tests across 3 tiers + lint + wiring + the gap-closer. ✓
- Structure > Willpower: anti-loop made compile-time (lint + ingestion-path-by-construction);
  cross-agent writes guarded structurally (refuse-to-start + symlink reject). ✓
- Signal vs authority: idle/budget gates own blocking authority; tick stays pure. ✓
- Near-silent: state-machine dedup + recovery alert + optional long-trip reminder. ✓
- Migration parity: additive + explicit removal step + non-silent on non-default. ✓
- Bug-fix evidence bar: E2E live test required before declaring "fixed." ✓
- Co-design discipline: §Fix 2 designed by Codey on Threadline; round-2 additions explicitly
  flagged as new asks to Codey before final approval. ✓

## Co-design status

- Round 1 (closed): Codey resolved all 5 questions on Threadline thread 5cc61bd7
  (poll-job + cursor + lock + dead-letter, schemaVersion=1 with id/correlationId, full reply
  schema, 8 anti-loop constraints, two-row audit pattern).
- Round 2 (open): convergence added two Codey-side requirements after round-1:
  unauthenticated `GET /idle` endpoint, and vendoring `MENTOR_CONTRACT_VERSION`. Both go to
  Codey for confirmation before this spec ships.
