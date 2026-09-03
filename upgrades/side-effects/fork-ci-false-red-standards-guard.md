# Side-Effects Review — Fork CI false-red: standards guard + non-semver upgrade fragments

**Version / slug:** `fork-ci-false-red-standards-guard`
**Date:** `2026-09-03`
**Author:** `Roland`
**Second-pass reviewer:** `not required` as shipped (no block/allow surface — see §4). The reverted attempt and the unfixed underlying problem are recorded for the maintainer in §2.

## Summary of the change

The fork's CI has failed on every push since 2026-08-15, from two causes, neither a defect in the code under test:

1. **Attempted and REVERTED — recorded here because the attempt is the finding.** The `standards-coverage` job measures against a **protected merge base on canonical main**. A fork's CI checkout cannot resolve that base — `fatal: Not a valid object name f915bd96…` — and the check then fails closed by design (`protected merge base unavailable`, `measurement population is empty or unreadable (zero-of-zero is never clean)`), identically regardless of the change under test. I guarded the job with `if: github.repository == 'JKHeadley/instar'`. **The Root self-wiring contract in `scripts/standards-coverage.mjs` correctly rejected it**: that contract asserts `exactKeys(job, ['name','runs-on','permissions','steps'])`, so any fifth key fails it, by design — its own comment says the contract is "deliberately EXACT so the CI wiring cannot be quietly rearranged". Disabling the ratchet on forks is precisely the rearrangement it forbids, so the guard was reverted and **no CI wiring change ships here**. See §2.
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

**Nil as shipped** — the only change that ships is a filename/content consolidation, which has no block/allow surface at all.

The reverted attempt is retained below as the reasoning trail, because the underlying problem is real and unfixed, and the next person will be tempted by the same wrong fix:

- **Nothing measurable is lost today.** The job has produced *zero* valid measurements on the fork since it began failing — it aborts at base resolution, before any measurement is taken. Its verdict carried no information: it was `failure` for every commit, good or bad. You cannot lose a signal that was never present, and a permanently-red check is worse than a skipped one, because it also masks the *other* failures in the same run (exactly what happened here — the genuine `upgrade-guide-check` failure sat behind it for two weeks).
- **Upstream authority is untouched.** `JKHeadley/instar` continues to run the job on every push with full blocking authority, which is where the ratchet is designed to bind. Verified: upstream CI passes this job on runs where the fork cannot.
- **The residual risk is real but bounded.** Fork-local source changes are rare (the fork carries CI fixes and rebases daily onto upstream), and anything that reaches upstream is measured there.
- **Why no workflow-level fix is available at all.** The self-wiring contract pins not just the job's key set but the exact ordered step prefix (checkout / setup-node / npm ci / area-audit-base) and the exact `env` map of the check step. So a fork cannot add an `if:`, and equally cannot add a `git fetch upstream` step to make the base resolvable. Both legitimate shapes are closed off at the workflow layer by design. **The fix therefore belongs upstream, inside `scripts/standards-coverage.mjs`** — where an unresolvable protected base on a non-canonical repository could legitimately report `not-assessed` instead of `invalid`, the same way `protectedBaseStatus` already models that state. That is an upstream design decision, not a downstream one, and has been reported upstream rather than worked around here.

---

## 3. Level-of-abstraction fit

Right layer. A job-level `if:` is the mechanism GitHub Actions provides for "this job is meaningful only in this repository", and it is evaluated before checkout, so no work is done to reach a foregone conclusion. The alternative — disabling the workflow in GitHub's UI — was rejected for the CI job because it is out-of-band repository state invisible in the source tree, and would also disable the unrelated jobs sharing that workflow. It remains the right tool for the scheduled `Standards Area Audit Cadence` workflow, which has no other jobs.

---

## 4. Signal vs authority compliance

- [x] **No — as shipped, this change has no block/allow surface.**

The change that ships is two filenames and their consolidated content. The attempt that *would* have touched a block/allow surface was reverted, caught by the very contract designed to catch it. Worth stating plainly: the guard did its job against me. It refused a change that would have quietly narrowed where a ratchet applies, and it refused it on structure rather than on my explanation of my intent — which is the point of the contract.

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

Not required for what ships. The open question for the maintainer is separate and lives upstream: on a non-canonical repository the protected base is unresolvable, so `standards-coverage --check` fails `invalid` on every push forever. `protectedBaseStatus: 'not-assessed'` already exists as a modelled state; whether a fork should reach it is upstream's call.

---

## Evidence pointers

- Fork CI red on every push since 2026-08-15; one green run at 2026-08-14 (`gh run list --workflow CI`).
- Failure text captured from run `33434462124`: `protected merge base unavailable for canonical main 1a5c86656bca` / `measurement population is empty or unreadable (zero-of-zero is never clean)`; and run `33317218219`: `fatal: Not a valid object name f915bd96a85865f3402efae02523a24f739267ef^{commit}`.
- Upstream contrast: `JKHeadley/instar` run `33503434872` (2026-09-01) shows `standards-coverage` passing while only an unrelated unit shard fails — confirming the failure is fork-specific, not a defect in the check.
- Both offending fragments confirmed present only on `fork/main` (`git branch -r --contains`), i.e. fork-local, never upstream.
- `npx vitest run tests/unit/upgrade-guide-check.test.ts` — 7560 passed after the change (was 2 failing assertions before).
- Full pre-commit lint suite passed on both commits.
- The reverted guard was caught by `npx vitest run tests/unit/standards-coverage-ratchet.test.ts` and by CI run `33730776187`, which reported `Standards Enforcement Coverage: skipped` (the guard worked mechanically) while the self-wiring contract failed the ratchet test (the guard was not permitted). Both facts are recorded rather than one.
- Also failing on the fork and NOT caused by this change: `tests/integration/subscription-pool-routes.test.ts`. Absent from run `33520200655` (2026-09-01), present after the rebase onto `46ac68d44` (v1.3.1219). The fork is 1 commit behind `origin/main`, and that commit (#2001, agent-signature labelling) does not touch this area, so it is not explained by the gap. Left untouched and unexplained rather than guessed at.
- Deliberately not addressed: `tests/integration/feedback-drain-performance.test.ts` EEXIST lock contention, reproduced on upstream `main` on 2026-09-01 and therefore an upstream flake, not a fork concern.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This corrects CI configuration and two filenames; it adds no self-triggered controller and modifies no LLM prompt, hook, skill, or standards text.
