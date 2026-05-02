# Convergence Report — Scope pre-push gate section 5 to non-CI environments

## ELI10 Overview

The instar repo has a safety gate that runs before any developer pushes code: it checks that the developer has written a "side-effects review artifact" — a structured document explaining what their change could break or affect. This gate is enforced on the developer's machine before code reaches GitHub.

The problem: the same gate script also runs inside GitHub's automated tests (CI). When contributors send in pull requests on branches they created before that safety document existed on main, the test fails even though the contributor did nothing wrong — their branch simply predates the document.

This fix narrows the check: skip it in GitHub's automated test environment (CI), but still enforce it when developers push from their own machines. The two-line change adds an environment variable check (`if (!process.env.CI)`) and suppresses noisy error output from a git fallback command.

The main tradeoff: a developer who knows about the fix could set `CI=true` on their own machine to also bypass the check. The document explains why this is an accepted risk given the small team size and existing safeguards.

## Original vs. Converged

The original spec had a clear problem statement but was silent on three concerns reviewers raised:

1. **CI=true is user-settable.** A developer could export `CI=true` locally and bypass the check. The converged spec explicitly acknowledges this, explains why it's accepted (the pre-commit hook is still the primary enforcement, and deliberate bypass requires clear intent), and notes that a more robust fix (`GITHUB_ACTIONS=true`) was considered and deferred as over-engineering.

2. **Does the signal-vs-authority principle apply?** The instar architectural principle separates "detectors" from "authorities" for decisions about agent behavior and message routing. Reviewers asked whether this change violates that principle. The converged spec clarifies: the principle applies to judgment calls about what a message *means* or what an agent *intends*. This check is a structural file-existence test for developer process compliance — no judgment, no ambiguity about intent, completely deterministic. The principle does not apply.

3. **What if someone bypasses both local hooks?** `--no-verify` on commit + `CI=true` on push = no structural enforcement before the PR arrives. The converged spec names this explicitly and accepts it: the gate is defense-in-depth, PR review is the remaining catch, and the team size makes this an acceptable risk profile.

## Iteration Summary

| Iteration | Reviewers | Material findings | Spec changes |
|-----------|-----------|-------------------|--------------|
| 1 | Security, Scalability, Adversarial, Integration | 3 material | Added "Known limitations" section addressing CI=true spoofing, two-point bypass, and signal-vs-authority clarification |
| 2 | Convergence check (all perspectives) | 0 material | None — converged |

## Full Findings Catalog

### Iteration 1 — Security reviewer

| Severity | Finding | Resolution |
|----------|---------|------------|
| HIGH | `CI=true` spoofable locally — bypass vector | Acknowledged in spec; accepted as known limitation with rationale |
| MEDIUM | Enforcement gap for cloud IDEs / non-local push environments | Accepted — pre-commit hook and PR review are the remaining catches |
| LOW | Stderr suppression hides diagnostic context | Non-material; only affects shallow-clone git error noise |
| MEDIUM | Audit trail gap for CI-tested code | Accepted — pre-commit hook trace files remain the audit trail |

### Iteration 1 — Scalability reviewer

| Severity | Finding | Resolution |
|----------|---------|------------|
| NONE | Concurrent execution safe | Confirmed, no action |
| MEDIUM | `2>/dev/null` stderr loss | Non-material; the suppression only affects the known shallow-clone fallback |
| MEDIUM | NFS/network stalling in `fs.readdirSync` | Pre-existing, not introduced by this change |
| LOW | fail-open asymmetry between sections | Pre-existing, acceptable |

### Iteration 1 — Adversarial reviewer

| Severity | Finding | Resolution |
|----------|---------|------------|
| HIGH | `CI=true` spoofing (same as security) | Addressed in spec |
| HIGH | Self-reinforcing degradation loop | Pre-existing risk; accepted |
| HIGH | Signal-vs-authority violation claimed | Spec clarified: principle does not apply to structural process checks |
| MEDIUM | PR review as soft catch | Explicitly acknowledged in spec |
| MEDIUM | `--no-verify + CI=true` two-point bypass | Explicitly acknowledged in spec |
| MEDIUM | Fallback logic ambiguity | Non-material; pre-existing |

### Iteration 1 — Integration reviewer

| Severity | Finding | Resolution |
|----------|---------|------------|
| MEDIUM | Test doesn't explicitly set `CI=true` | Non-material; test passes because artifact is present on main |
| MEDIUM | Fork contributor blocked by local pre-push hook | Pre-existing; not introduced by this change |
| LOW | Non-GitHub CI systems may not set `CI` | Acceptable; only GitHub Actions is configured |
| LOW | Release-cut doesn't migrate side-effects artifact | Pre-existing; out of scope |

### Iteration 2 — Convergence check

Zero new material findings. Two cosmetic issues noted (vague test reference, section 5 purpose not in problem statement) — both non-material. **Converged.**

## Convergence verdict

Converged at iteration 2 (one review round + convergence check). No material findings in the final round. The spec clearly addresses all concerns raised by the four-reviewer parallel audit. The change is a narrowly scoped fix for a real CI false-positive, with known tradeoffs explicitly documented and accepted. Spec is ready for user review and approval.
