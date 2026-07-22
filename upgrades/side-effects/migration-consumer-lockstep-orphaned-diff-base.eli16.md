# Migration-consumer-lockstep CI crash on orphaned diff base — Plain-English Overview

> The one-line version: a daily housekeeping git operation was accidentally crashing an unrelated CI check every day, and the fix makes that check skip gracefully instead of crashing.

## The problem in one breath

This fork rebases onto upstream `JKHeadley/instar` and force-pushes `main` every day (the daily-rebase job). A force-push rewrites history, so the commit that used to be the tip of `main` a moment earlier stops being reachable from any branch. One of the CI checks — "Migration consumer lockstep," which makes sure any changed migration contract still has its consumers updated — computes a `git diff` between that old tip and the new `HEAD`. When the old tip has just been orphaned by the rebase, `git diff` fails with `fatal: bad object <sha>`, and the check was letting that failure crash the whole Node script instead of handling it, taking the entire CI run down with it. This has been happening on nearly every daily rebase for weeks.

## What already exists

- **The migration-consumer-completeness lint** (`scripts/lint-migration-consumer-completeness.js`) — scans the repo for migration contract markers and, when given a "before" commit, diffs against it to see whether a changed contract left a consumer un-migrated. It already has a documented, working path for "no base was given at all" (skips the diff-driven check, still runs the static checks).
- **The daily-rebase job** — pulls `JKHeadley/main`, rebases the fork's `main` on top, and force-pushes. This is a normal, intentional, everyday operation for this fork — not something to change.
- **CI's use of `github.event.before`** — on every push, GitHub tells the workflow what the previous tip commit was, and the lint script was told to diff against that as its "base."

## What this adds

The lint script now wraps the `git diff` call in a try/catch. If the diff-base commit is unreachable (exactly the situation a force-push creates), it logs a clear warning and treats it exactly like the existing "no base at all" case — skipping the diff-driven portion of the check for that one run — instead of throwing an uncaught error that kills the whole CI job.

## The new pieces

- **Unreachable-base fallback** — one small addition to the existing `diffContext()` function. No new files, no new decision logic beyond "if git can't find this commit, don't crash, just skip that portion of the check." Everything else about the lint (the static contract-shape checks, the marker scan) runs exactly as before.

## The safeguards

**Prevents the rebase from ever silently breaking CI again.** The fix directly targets the exact failure signature seen in the last several days of failed runs (`fatal: bad object <orphaned sha>`), confirmed by reproducing it locally against the real orphaned SHA from a failed run.

**Doesn't weaken the check in the normal case.** When the diff base IS reachable (the overwhelming majority of runs — normal pushes, PRs), behavior is completely unchanged: the diff runs and is used exactly as before. This only changes behavior in the narrow window right after a force-push rewrites history.

**Known, accepted trade-off.** In the rare run where this fires, the diff-driven half of the migration-consumer check is skipped for that one run (the static checks still run). A real migration-consumer regression introduced in that exact window wouldn't be caught by that one CI run — but the next day's run (against a stable, reachable base) would catch it, and this is strictly better than today's behavior, which is "crash the entire CI job, catching nothing at all."

## What ships when

Single, small change: the try/catch in the lint script plus its test coverage (already existing tests all still pass) ship together in one commit — no phased rollout needed.
