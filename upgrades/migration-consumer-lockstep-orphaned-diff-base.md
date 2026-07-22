## What Changed

The CI "Migration consumer lockstep" check crashed instead of running whenever the branch's previous tip had been rewritten by a force-push (e.g. the fork's daily upstream rebase) before the workflow ran. The check computes `git diff --diff-base <previous-tip> HEAD`, but a rebase orphans the pre-rebase commit — it stops being reachable from any branch, so `git diff` fails with "fatal: bad object" and the script exits with an uncaught crash instead of a lint verdict. The script now treats an unreachable diff base the same way it already treats "no base at all": it logs a warning and skips the diff-driven portion of the check for that run, rather than failing the whole CI job.

## Evidence

Reproduced directly: workflow run 29839608759 on the instar fork failed at 2026-07-21 14:32 UTC with `fatal: bad object 4d8fb655583a25362546baadc4db4405810e328e` — confirmed via the GitHub API that this commit exists but is unreachable from any branch (`branches-where-head` returns empty), consistent with it being the pre-rebase tip of a same-day force-push. Re-ran the script locally against the exact orphaned SHA from the failed run: it now exits 0 with a "skipping diff-driven check" warning instead of crashing. All 9 existing unit tests for this script still pass, and both currently-supported invocations (`--staged`, and `--diff-base` with a valid, reachable base) were re-verified locally to behave exactly as before.

## What to Tell Your User

None user-visible today. This only affects an internal CI check that runs on every push/PR to the instar repository itself, not anything an end user interacts with.

## Summary of New Capabilities

None — this is a reliability fix to an existing internal CI check, not a new capability.
