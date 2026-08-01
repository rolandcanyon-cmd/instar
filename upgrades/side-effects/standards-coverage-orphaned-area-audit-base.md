# Side-Effects Review — Standards Enforcement Coverage CI crash on orphaned area-audit base

**Version / slug:** `standards-coverage-orphaned-area-audit-base`
**Date:** `2026-08-01`
**Author:** `Roland`
**Second-pass reviewer:** `not required` (Tier 1, no block/allow authority surface — see Phase 5 criteria)

## Summary of the change

`.github/workflows/ci.yml`'s "Resolve protected-base area ledger" step (job `standards-coverage`) now checks whether its `BASE_SHA` (derived from `github.event.before` on a push) is reachable before using it, instead of crashing when it isn't. This is the identical failure class already fixed for the sibling "Migration consumer lockstep" step in the same job on 2026-07-22 (`migration-consumer-lockstep-orphaned-diff-base`): the fork's daily upstream rebase force-pushes `main`, which orphans the commit `github.event.before` pointed to at push time. `git cat-file -e "$BASE_SHA^{commit}"` then fails with "fatal: Not a valid object name" and exit 128, crashing the whole job. The step now checks reachability first and, if unreachable, logs a warning and sets `required=0` (the existing "no ledger file at this base" fallback path) instead of crashing. Files touched: `.github/workflows/ci.yml` (11 LOC added), plus the release-note fragment.

## Decision-point inventory

- `standards-coverage` job / "Resolve protected-base area ledger" step in `.github/workflows/ci.yml` — modify — no new decision point added; an existing outcome (`required=0`, already reachable via the "ledger file doesn't exist at base" path) is now also reachable via the unreachable-base path. `scripts/standards-coverage.mjs`'s pass/fail verdict logic is untouched.

---

## 1. Over-block

No block/allow surface change — this makes the step MORE permissive (converts a hard crash into a graceful skip), never less. No legitimate input is newly rejected.

---

## 2. Under-block

A real standards-area-ledger regression introduced in the exact commit range between the orphaned pre-rebase tip and the new rebased tip would not be caught by the area-ledger diff for that one CI run (the rest of `scripts/standards-coverage.mjs --check`, including the hard zero-ceiling on dangling refs, still runs unconditionally). The window only opens on a force-push day, and the very next day's run — against a stable, reachable base — would catch the same regression if it persists. Strictly better than the current behavior, where the crash catches nothing at all on that run.

---

## 3. Level-of-abstraction fit

Right layer. This mirrors the exact pattern already established for the sibling "Migration consumer lockstep" step in the same job (`scripts/lint-migration-consumer-completeness.js`'s `diffContext()`), and reuses the existing `required=0` code path rather than inventing new logic. Leaf-level git-plumbing failure mode, handled at the point where the plumbing call happens.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

Not a gate, sentinel, or authority. `scripts/standards-coverage.mjs`'s pass/fail verdict logic is unchanged; the change only affects whether an unrelated git-plumbing error is allowed to crash the process before that verdict logic runs.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Is this commit SHA reachable from HEAD" is a binary, enumerable git fact.

---

## 5. Interactions

Does not shadow, get shadowed by, double-fire with, or race any other check. Does not affect the sibling "Migration consumer lockstep" step (already independently hardened) or any other job in `ci.yml`.

---

## 6. External surfaces

No surface visible to other agents or users. Internal CI check only, runs on every push/PR to the instar repository's own source tree.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Not applicable — stateless CI workflow step, no runtime state, no replication, no cross-machine read/write surface.

---

## 8. Rollback cost

Trivial. Revert the single commit; the step reverts to its prior (crashing) behavior. Source-only change to a CI workflow file.

---

## Second-pass review (if required)

Not required — Tier 1, no block/allow authority surface, no sentinel/gate/watchdog/session-lifecycle/messaging-dispatch surface touched.

---

## Evidence pointers

- Reproduced the crash directly: CI run `30704008579` (2026-08-01) failed with `fatal: Not a valid object name 896b64acb092638458e692c8e133d37b6308a3be^{commit}` at the "Resolve protected-base area ledger" step — confirmed via `gh run view --log-failed`.
- Confirmed `required=0` is an existing, already-exercised fallback path via `scripts/standards-coverage.mjs`'s handling of `STANDARDS_AREA_AUDIT_BASE_REQUIRED`.
- Confirmed the failure timing (2026-08-01 14:33 UTC) is consistent with that day's daily-rebase force-push, matching the identical failure class already documented and fixed in `migration-consumer-lockstep-orphaned-diff-base` (2026-07-22).

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. (This fixes a CI workflow crash triggered by an ordinary git operation, not a defect in an LLM prompt, hook, config, skill, or standards text; and it adds no self-triggered controller.)
