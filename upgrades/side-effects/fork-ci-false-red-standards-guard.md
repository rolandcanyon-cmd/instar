# Side-Effects Review — Fork CI false-red: standards guard + non-semver upgrade fragments

**Version / slug:** `fork-ci-false-red-standards-guard`
**Date:** `2026-09-03`
**Author:** `Roland`
**Second-pass reviewer:** `required` — this change removes a block/allow surface from one repository (see §4).

## Summary of the change

The fork's CI has failed on every push since 2026-08-15, from two causes, neither a defect in the code under test:

1. The `standards-coverage` job (`Standards Enforcement Coverage`) measures against a **protected merge base on canonical main**. A fork's CI checkout cannot resolve that base — `fatal: Not a valid object name f915bd96…` — and the check then fails closed by design (`protected merge base unavailable`, `measurement population is empty or unreadable (zero-of-zero is never clean)`). It failed identically regardless of the change under test. Now guarded with `if: github.repository == 'JKHeadley/instar'`.
2. `tests/unit/upgrade-guide-check.test.ts` requires every non-`NEXT`, non-`.eli16` file in `upgrades/` to be named for a semver release. Two fragments (`docs-coverage-issue-body-truncation.md`, `migration-consumer-lockstep-orphaned-diff-base.md`) carried descriptive names. Both document fork-local CI fixes that ship in no upstream release, so neither has a version to take; they would have failed forever. Content was well-formed — only the filename assertion failed — so it is preserved verbatim in `upgrades/NEXT.md`, the directory's own convention for pending notes.

Files touched: `.github/workflows/ci.yml` (one `if:` + comment), `upgrades/NEXT.md` (added), two `upgrades/*.md` (deleted, content merged).

## Decision-point inventory

- `standards-coverage` job in `.github/workflows/ci.yml` — **modify** — adds a repository-identity precondition to an existing gate. No new decision point; the job's internal verdict logic (`scripts/standards-coverage.mjs`) is untouched and retains full authority where it runs.
- `upgrades/` filename convention — **no change**. The rule is unchanged; two non-conforming files were brought into conformance.

---

## 1. Over-block

None. The change is strictly permissive: on the canonical repository behaviour is byte-identical (the `if:` evaluates true), and on forks a job that previously always failed is now skipped. No legitimate input is newly rejected anywhere.

---

## 2. Under-block

**This is the real risk and it is not zero.** On any fork, the standards-enforcement ratchet no longer runs at all. A fork-local change that genuinely regressed standards coverage would not be caught by fork CI.

Weighing it honestly:

- **Nothing measurable is lost today.** The job has produced *zero* valid measurements on the fork since it began failing — it aborts at base resolution, before any measurement is taken. Its verdict carried no information: it was `failure` for every commit, good or bad. You cannot lose a signal that was never present, and a permanently-red check is worse than a skipped one, because it also masks the *other* failures in the same run (exactly what happened here — the genuine `upgrade-guide-check` failure sat behind it for two weeks).
- **Upstream authority is untouched.** `JKHeadley/instar` continues to run the job on every push with full blocking authority, which is where the ratchet is designed to bind. Verified: upstream CI passes this job on runs where the fork cannot.
- **The residual risk is real but bounded.** Fork-local source changes are rare (the fork carries CI fixes and rebases daily onto upstream), and anything that reaches upstream is measured there.
- **One caveat worth recording:** this guard keys on *repository identity*, not on *whether the base resolves*. If a fork's CI checkout were later fixed to fetch the canonical base, the job would then be capable of running correctly — and this `if:` would keep it skipped. A base-availability precondition would be the more precise long-term shape; it was not chosen here because it would let a genuine base-resolution regression upstream silently downgrade to a skip, converting a loud failure into a quiet one. Repository identity is the safer predicate: it can only ever skip where the check provably cannot function.

---

## 3. Level-of-abstraction fit

Right layer. A job-level `if:` is the mechanism GitHub Actions provides for "this job is meaningful only in this repository", and it is evaluated before checkout, so no work is done to reach a foregone conclusion. The alternative — disabling the workflow in GitHub's UI — was rejected for the CI job because it is out-of-band repository state invisible in the source tree, and would also disable the unrelated jobs sharing that workflow. It remains the right tool for the scheduled `Standards Area Audit Cadence` workflow, which has no other jobs.

---

## 4. Signal vs authority compliance

- [x] **Yes — this change touches a block/allow surface.**

It removes a gate's authority on forks. The mitigation is that the gate had no functioning authority there to remove: it never reached a verdict. Authority is unchanged on the canonical repository, where the measurement is possible. No verdict logic, threshold, or floor was altered — only the set of repositories where the job is evaluated. Nothing is silently weakened: on a fork the job now reports `skipped`, an honest and visible state, rather than `failure` for a reason unrelated to the change under test.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new heuristic at a competing-signals decision point. `github.repository == 'JKHeadley/instar'` is an exact string comparison on a value supplied by the CI runtime — a binary, enumerable fact, not a judgment between conflicting live signals.

---

## 5. Interactions

Verified no job declares `needs: standards-coverage` (the only `needs:` edges in `ci.yml` are on `unit` and `lint`), so skipping it cannot cascade into skipped or blocked dependents. The `Migration consumer lockstep` step lives inside this job and is skipped with it on forks; it is subject to the same reasoning — it could not run there either, since the job aborted before reaching it.

The deleted fragments are paired with `upgrades/side-effects/migration-consumer-lockstep-orphaned-diff-base.md`, which is retained. Artifacts and fragments are paired by PR, not filename, so the retained artifact is not orphaned by the rename.

---

## 6. External surfaces

None. No surface visible to users or other agents. Both halves affect only CI on the project's own source tree.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Not applicable. Stateless CI configuration and documentation; no runtime state, no replication, no cross-machine read/write surface.

---

## 8. Rollback cost

Trivial and complete. Revert the single commit: the `if:` disappears and the job runs everywhere again (returning the fork to permanent red), and the two fragments return under their original names. No data migration, no agent state, no fleet-rollout concerns.

---

## Second-pass review (if required)

**Required** (block/allow surface). Flagged for review by the instar maintainer, with the §2 caveat as the specific point to check: whether repository-identity is the predicate they want long-term, or whether they would prefer a base-availability precondition once fork checkouts can fetch the canonical base.

---

## Evidence pointers

- Fork CI red on every push since 2026-08-15; one green run at 2026-08-14 (`gh run list --workflow CI`).
- Failure text captured from run `33434462124`: `protected merge base unavailable for canonical main 1a5c86656bca` / `measurement population is empty or unreadable (zero-of-zero is never clean)`; and run `33317218219`: `fatal: Not a valid object name f915bd96a85865f3402efae02523a24f739267ef^{commit}`.
- Upstream contrast: `JKHeadley/instar` run `33503434872` (2026-09-01) shows `standards-coverage` passing while only an unrelated unit shard fails — confirming the failure is fork-specific, not a defect in the check.
- Both offending fragments confirmed present only on `fork/main` (`git branch -r --contains`), i.e. fork-local, never upstream.
- `npx vitest run tests/unit/upgrade-guide-check.test.ts` — 7560 passed after the change (was 2 failing assertions before).
- Full pre-commit lint suite passed on the commit.
- Deliberately not addressed: `tests/integration/feedback-drain-performance.test.ts` EEXIST lock contention, reproduced on upstream `main` on 2026-09-01 and therefore an upstream flake, not a fork concern.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This corrects CI configuration and two filenames; it adds no self-triggered controller and modifies no LLM prompt, hook, skill, or standards text.
