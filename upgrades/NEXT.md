# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The health endpoint's systemReview section now includes a failedProbes array with per-probe details (probeId, name, tier, error, remediation) so agents can drill into failures without a second API call. A detailsUrl field points to /system-reviews/latest for the full report.

Two new aliases were added for discoverability:
- GET /health/probes — returns all probe results (pass and fail) with timestamps, stats, and skipped list.
- GET /system-review (singular) — alias for /system-reviews/latest, matching the natural URL shape agents try first.

Previously when the health endpoint reported 3 of 16 probes failed, there was no way to see WHICH probes failed from the health response itself. Agents had to know the exact plural endpoint name to drill in. This closes that gap — failures are now self-describing at the top-level health call, and the common URL shapes agents naturally try now work.

## What to Tell Your User

- **Clearer health drill-down**: "When I check my own system health and see failures, I can now immediately see which checks failed and what to do about them — no more guessing."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Per-probe failure details in health | GET /health then read systemReview.failedProbes |
| Full probe list (pass and fail) | GET /health/probes |
| Latest review alias | GET /system-review |
