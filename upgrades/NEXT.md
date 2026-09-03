# Pending release notes

Fork-local CI reliability fixes awaiting a release version. Each entry below was
previously carried as its own descriptively-named fragment; the upgrade-guide
check requires every non-`NEXT`, non-`.eli16` file in this directory to be named
for a semver release, and these fixes ship only on the fork, so they have no
upstream release number to take. They are consolidated here until they do.

## What Changed

**Docs coverage audit no longer fails on an oversized issue body.** The weekly
docs coverage audit workflow started failing every run once the tracked doc tree
grew large enough that the generated coverage report, pasted whole into a GitHub
issue comment, exceeded GitHub's fixed size limit for an issue or comment body.
The workflow now caps how much of the report it pastes into the issue and points
readers at the uploaded report file for the rest, so the weekly run succeeds and
keeps posting its update instead of failing silently every Monday.

**Migration consumer lockstep no longer crashes on an orphaned diff base.** The
CI "Migration consumer lockstep" check crashed instead of running whenever the
branch's previous tip had been rewritten by a force-push (e.g. the fork's daily
upstream rebase) before the workflow ran. The check computes
`git diff --diff-base <previous-tip> HEAD`, but a rebase orphans the pre-rebase
commit — it stops being reachable from any branch, so `git diff` fails with
"fatal: bad object" and the script exits with an uncaught crash instead of a lint
verdict. The script now treats an unreachable diff base the same way it already
treats "no base at all": it logs a warning and skips the diff-driven portion of
the check for that run, rather than failing the whole CI job.

## Evidence

**Docs coverage.** Reproduced directly: workflow run 29250327344 on the instar
fork failed at 2026-07-13 12:34 UTC with an error naming the exact size limit
exceeded. Confirmed the same run also failed the two prior weeks (2026-06-29,
2026-07-06) with a related but distinct cause. After the change, the workflow
completes successfully — verified by re-running the same job to a green result.

**Migration consumer lockstep.** Reproduced directly: workflow run 29839608759 on
the instar fork failed at 2026-07-21 14:32 UTC with
`fatal: bad object 4d8fb655583a25362546baadc4db4405810e328e` — confirmed via the
GitHub API that this commit exists but is unreachable from any branch
(`branches-where-head` returns empty), consistent with it being the pre-rebase tip
of a same-day force-push. Re-ran the script locally against the exact orphaned SHA
from the failed run: it now exits 0 with a "skipping diff-driven check" warning
instead of crashing. All 9 existing unit tests for this script still pass, and both
currently-supported invocations (`--staged`, and `--diff-base` with a valid,
reachable base) were re-verified locally to behave exactly as before.

## What to Tell Your User

Nothing user-visible. Both entries affect internal CI and maintenance workflows
that run against the project's own source tree, not anything the user interacts
with directly.

## Summary of New Capabilities

None — both are reliability fixes to existing internal checks, not new
capabilities.
