# Side-Effects Review — Migration-consumer-lockstep CI crash on orphaned diff base

**Version / slug:** `migration-consumer-lockstep-orphaned-diff-base`
**Date:** `2026-07-22`
**Author:** `Roland`
**Second-pass reviewer:** `not required` (Tier 1, no block/allow authority surface — see Phase 5 criteria)

## Summary of the change

`scripts/lint-migration-consumer-completeness.js`'s `diffContext()` helper wraps its `git diff --diff-base <sha> HEAD` call in a try/catch. When the daily upstream-rebase force-push has orphaned the commit that `github.event.before` pointed to (making it unreachable from any branch), `git diff` used to throw "fatal: bad object <sha>" uncaught, crashing the whole Node process and taking the entire CI job down with it (observed on 2026-07-13, 2026-07-21, 2026-07-22, and the run underlying today's stale failure-notification email from 2026-07-13's f3ec91d run). The fix catches that specific failure and treats an unreachable base identically to the pre-existing "no base given" path: it logs a warning and skips the diff-driven portion of the check for that run. Files touched: `scripts/lint-migration-consumer-completeness.js` (13 LOC), plus the release-note fragment `upgrades/next/migration-consumer-lockstep-orphaned-diff-base.md`.

## Decision-point inventory

- `diffContext()` in `scripts/lint-migration-consumer-completeness.js` — modify — no new decision point added; an existing "skip the diff-driven check" outcome (already reachable via the no-base path) is now also reachable via the unreachable-base path. The check's pass/fail verdict logic (`auditMigrationConsumerCompleteness`) is untouched.

---

## 1. Over-block

No block/allow surface change — this makes the check MORE permissive (converts a hard crash into a graceful skip), never less. No legitimate input is newly rejected.

---

## 2. Under-block

A real migration-consumer-completeness violation introduced in the exact commit range between the orphaned pre-rebase tip and the new rebased tip would not be caught by the diff-driven half of that one CI run (the static contract-shape and marker-scan checks still run and still catch shape-level violations). This window only opens on a force-push day, and the very next day's run — against a stable, reachable base — would catch the same violation if it persists. This is strictly better than the current behavior, where the crash catches nothing at all, on any run, for any reason.

---

## 3. Level-of-abstraction fit

Right layer. This is the exact same pattern the script already uses for its "no base at all" case (see the surrounding code) — an unreachable base is just another way of not having a usable base, and the fix reuses the identical code path (`return { changedFiles: new Set(), baseContracts: undefined }`) rather than inventing new logic. No higher-level gate exists that this should feed instead; this is a leaf-level git-plumbing failure mode, appropriately handled at the point where the plumbing call happens.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

This is not a gate, sentinel, or authority — it's a CI lint script whose pass/fail verdict logic (`auditMigrationConsumerCompleteness`) is unchanged. The change only affects whether an unrelated git-plumbing error is allowed to crash the process before that verdict logic even runs.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Is this commit SHA reachable from HEAD" is a binary, enumerable git fact, not a judgment call between conflicting live signals.

---

## 5. Interactions

Does not shadow, get shadowed by, double-fire with, or race any other check. The other CI jobs in `ci.yml` (and the sibling `Standards Enforcement Coverage` checks) run independently; none of them depend on this script's diff-driven output.

---

## 6. External surfaces

No surface visible to other agents or users. This only affects an internal CI check that runs on every push/PR to the instar repository's own source tree.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Not applicable — this is a stateless CI script with no runtime state, no replication, and no cross-machine read/write surface. It runs once per GitHub Actions job invocation and holds no state between runs.

---

## 8. Rollback cost

Trivial. Revert the single commit; the script reverts to its prior (crashing) behavior. No data migration, no agent state, no fleet-rollout concerns — this is a source-only change to a CI lint script.

---

## Second-pass review (if required)

Not required — Tier 1, no block/allow authority surface, no sentinel/gate/watchdog/session-lifecycle/messaging-dispatch surface touched (Phase 5 trigger list).

---

## Evidence pointers

- Reproduced the crash directly: CI run `29839608759` (2026-07-21) and `29929128401` (2026-07-22) both failed with `fatal: bad object <orphaned sha>` at `diffContext` — confirmed via `gh run view --log-failed`.
- Confirmed via `gh api` that the orphaned SHA is not reachable from any branch (consistent with being the pre-rebase tip of a same-day force-push).
- `npx vitest run tests/unit/migration-consumer-completeness-lint.test.ts` — all 9 existing tests pass unchanged.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. (This fixes a CI script crash triggered by an ordinary git operation, not a defect in an LLM prompt, hook, config, skill, or standards text; and it adds no self-triggered controller.)
