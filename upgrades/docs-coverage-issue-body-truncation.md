## What Changed

The weekly docs coverage audit workflow started failing every run once the tracked doc tree grew large enough that the generated coverage report, pasted whole into a GitHub issue comment, exceeded GitHub's fixed size limit for an issue or comment body. The workflow now caps how much of the report it pastes into the issue and points readers at the uploaded report file for the rest, so the weekly run succeeds and keeps posting its update instead of failing silently every Monday.

## Evidence

Reproduced directly: workflow run 29250327344 on the instar fork failed at 2026-07-13 12:34 UTC with an error naming the exact size limit exceeded. Confirmed the same run also failed the two prior weeks (2026-06-29, 2026-07-06) with a related but distinct cause. After the change, the workflow completes successfully — verified by re-running the same job to a green result.

## What to Tell Your User

None user-visible today. This only affects the background weekly documentation-coverage check that runs against the project's own source tree, not anything the user interacts with directly.

## Summary of New Capabilities

None — this is a reliability fix to an existing internal maintenance workflow, not a new capability.
