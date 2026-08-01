<!-- internal-only -->

## What Changed

The CI "Standards Enforcement Coverage" job's "Resolve protected-base area ledger" step crashed instead of running whenever the branch's previous tip had been rewritten by a force-push (e.g. the fork's daily upstream rebase) before the workflow ran. The step ran `git cat-file -e "$BASE_SHA^{commit}"` against the previous push's tip commit, but a rebase orphans that commit — it stops being reachable from any branch, so `git cat-file` fails with "fatal: Not a valid object name" and exit code 128, crashing the whole job. The step now treats an unreachable base the same way the sibling "Migration consumer lockstep" check already treats one (fixed 2026-07-22 in the same job): it logs a warning and skips the area-ledger diff for that run, setting `required=0`, instead of failing the whole CI job.

## Evidence

Reproduced directly: workflow run 30704008579 on the instar fork failed at 2026-08-01 14:33 UTC with `fatal: Not a valid object name 896b64acb092638458e692c8e133d37b6308a3be^{commit}` in the "Resolve protected-base area ledger" step, immediately following that day's daily-rebase force-push to main. `required=0` is an existing, already-exercised code path (used whenever the ledger file doesn't exist at the base commit — see `scripts/standards-coverage.mjs`'s handling of `STANDARDS_AREA_AUDIT_BASE_REQUIRED`), so this reuses established behavior rather than adding a new one. `python3 -c "import yaml..."`-equivalent (js-yaml) parse of `.github/workflows/ci.yml` confirms valid YAML after the edit.

## What to Tell Your User

None — this only affects an internal CI check that runs on every push/PR to the instar repository itself.

## Summary of New Capabilities

None — this is a reliability fix to an existing internal CI check, not a new capability.
