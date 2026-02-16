# CLAUDE.md — claude-agent-kit

## What This Project Is

A toolkit that bootstraps persistent agent infrastructure into any Claude Code project. Transforms Claude Code from a reactive CLI tool into a proactive, persistent agent with scheduled jobs, multi-user messaging, and system monitoring.

Born from the Dawn/Portal project — extracting battle-tested infrastructure patterns into a reusable, project-agnostic toolkit.

## Quick Reference

```bash
pnpm build            # Build TypeScript
pnpm dev              # Watch mode build
pnpm test             # Unit tests
pnpm test:watch       # Watch mode tests
pnpm test:integration # Integration tests (spawns real sessions)
```

## Architecture

```
src/
  core/           # Session management, state, config auto-detection
  scheduler/      # Cron-based job scheduling with quota awareness
  monitoring/     # Quota tracking, memory pressure, health checks
  messaging/      # Messaging adapter interface (Telegram, Slack, etc.)
  users/          # Multi-user identity resolution and permissions
  server/         # HTTP server for health, status, and messaging APIs
  commands/       # CLI command implementations
  templates/      # Templates for `agent-kit init`
tests/
  unit/           # Pure logic tests (no tmux/sessions)
  integration/    # Full system tests (may spawn real sessions)
  fixtures/       # Test data and mock repos
```

## Development Workflow

### Testing Against Real Repos

This toolkit is meant to be tested against real Claude Code projects. The flow:

1. Make changes in this repo
2. Build: `pnpm build`
3. Test against a target repo:
   ```bash
   # From target repo
   node /path/to/claude-agent-kit/dist/cli.js init
   node /path/to/claude-agent-kit/dist/cli.js status
   ```
4. Or link globally during development:
   ```bash
   # From this repo
   pnpm link --global
   # From target repo
   agent-kit init
   ```

### Test Targets

- `tests/fixtures/test-repo/` — Minimal fixture for unit/integration tests
- `/Users/justin/Documents/Projects/ai-guy/` — Real project (AI Guy chatbot)
- `/Users/justin/Documents/Projects/sagemind/` — Real project (SageMind with multiple users)

### Key Design Decisions

1. **File-based state** — No database dependency. Everything is JSON files.
2. **tmux for sessions** — Battle-tested, survives terminal disconnects, scriptable.
3. **Adapter pattern for messaging** — Telegram first, but the interface supports any platform.
4. **User identity is channel-based** — A user is known by their channel identifiers (Telegram topic, email, etc.)
5. **Jobs are declarative** — JSON definitions with cron expressions, not code.

## Key Patterns from Dawn

These patterns were earned through real failures. Don't weaken them:

- **tmux trailing colon**: Use `=session:` (trailing colon) for pane-level commands. `=session` (no colon) FAILS SILENTLY for send-keys/capture-pane on tmux 3.6a.
- **Nullish coalescing for numbers**: `maxParallelJobs ?? 2`, NOT `maxParallelJobs || 2`. Zero is falsy.
- **Protected sessions**: Always maintain a list of sessions that the reaper should never kill.
- **Completion detection**: Check tmux output for patterns, don't rely on process exit.
