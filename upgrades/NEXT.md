# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- Replaced all shell-dependent npm calls in server startup (better-sqlite3 auto-rebuild) with shell-free alternatives using npm's CLI JS directly via Node.js. Fixes "spawnSync /bin/sh ENOENT" failures in minimal/containerized environments.
- Added findNpmCli helper that locates npm's entry point without requiring a shell.
- Affects ensureSqliteBindings preflight and TopicMemory auto-rebuild fallback.

## What to Tell Your User

- **Better startup reliability**: "Agents running in Docker or minimal Linux environments should no longer see memory system degradation at startup. The native module rebuild now works without requiring a system shell."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Shell-free native module rebuild | Automatic — no user action needed |
