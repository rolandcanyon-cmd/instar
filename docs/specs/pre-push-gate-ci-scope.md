---
title: "Scope pre-push gate section 5 to non-CI environments"
slug: "pre-push-gate-ci-scope"
author: "echo"
created: "2026-04-17"
review-convergence: "2026-04-17T03:15:00.000Z"
review-iterations: 1
review-completed-at: "2026-04-17T03:15:00.000Z"
review-report: "docs/specs/reports/pre-push-gate-ci-scope-convergence.md"
approved: true
approved-by: "echo-autonomous"
approved-at: "2026-04-17T03:15:00.000Z"
---

# Scope pre-push gate section 5 to non-CI environments

## Problem statement

Three contributor PRs are failing CI on `tests/unit/pre-push-gate.test.ts`. The test runs the actual gate script against the branch working tree. Section 5 of `scripts/pre-push-gate.js` checks for a side-effects review artifact matching the current package version in `upgrades/side-effects/`. Contributor branches cut before the artifact was added to main don't have it, so CI rejects them with a false positive.

Additionally, section 3's `HEAD~1` git fallback leaks stderr into the test process in shallow-clone CI environments (GitHub Actions uses `fetch-depth: 1` by default), producing noisy test output even though the exception is caught.

## Root cause

Section 5's own comment says it enforces the process "at push time." CI is not push time — it's post-push. The check was designed to run on the developer's machine before a push reaches GitHub; running it in GitHub Actions creates a category mismatch that produces false failures on valid contributor branches.

## Fix

1. Wrap section 5 in `if (!process.env.CI)` — `CI=true` is set automatically by GitHub Actions for all workflow runs.
2. Add `2>/dev/null` to the `HEAD~1` stderr fallback in section 3 to suppress leakage.

## Acceptance criteria

- `tests/unit/pre-push-gate.test.ts` passes in CI (all 6 tests green).
- `CI=true node scripts/pre-push-gate.js` exits 0 even when no fresh side-effects artifact is present.
- Without `CI`, the gate still enforces section 5 (verified by existing local test).
- No other tests regress.

## Files changed

- `scripts/pre-push-gate.js` — the two targeted changes above.

## Rollback

Pure code change. Revert and ship a patch. No persistent state, no migration.

## Known limitations (raised by reviewer round 1)

### CI=true spoofing
A developer can set `CI=true` locally (`CI=true git push`) to bypass section 5 without being in an actual CI environment. This is a real gap. The decision to accept it: (a) the pre-commit hook remains the primary enforcement point and requires deliberate `--no-verify` to bypass; (b) the `CI=true` bypass requires intent — it's not an accidental omission; (c) the pre-push gate is defense-in-depth, not a hard security boundary. If a developer intentionally bypasses both hooks, PR review is the remaining catch. This is acceptable given the scope of the instar development team.

If this attack surface becomes a real concern, a mitigation is to check `GITHUB_ACTIONS=true` (a GitHub-specific env var, not `CI`) or to require multiple consistent GitHub Actions env vars. Not implementing this now — over-engineering for the current threat model.

### --no-verify + CI=true two-point bypass
`git commit --no-verify` disables the pre-commit hook; `CI=true git push` disables section 5 of the pre-push gate. Both together mean an artifact-less change reaches CI with no structural enforcement remaining. PR review is the only remaining catch and it's human-dependent. This is acknowledged. The gate's role is raising the bar, not being the sole enforcement layer.

### Signal-vs-authority applicability
Multiple reviewers raised this. The signal-vs-authority principle (docs/signal-vs-authority.md) applies to decision points that gate **agent behavior, message flow, or information routing** — what the doc calls "judgment decisions: blocking based on what a message means or what the agent's intent appears to be." The pre-push gate enforces **developer process compliance** against explicit structural criteria (file existence, git state). It is not making a judgment call about agent intent or message content. The principle does not apply here. The `!process.env.CI` guard is a scope restriction on a structural file-existence check, not a brittle detector holding authority over message flow.
