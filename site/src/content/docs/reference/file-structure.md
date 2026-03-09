---
title: File Structure
description: What Instar creates and where everything lives.
---

Everything is file-based. No external database, no cloud dependencies.

## Directory Layout

```
.instar/
  config.json             # Server, scheduler, messaging config
  jobs.json               # Scheduled job definitions
  users.json              # User profiles and permissions
  AGENT.md                # Agent identity (who am I?)
  USER.md                 # User context (who am I working with?)
  MEMORY.md               # Persistent learnings across sessions
  hooks/                  # Behavioral scripts
    dangerous-command-guard.py
    external-operation-gate.js
    grounding-before-messaging.sh
    session-start.sh
    compaction-recovery.sh
    deferral-detector.js
    post-action-reflection.js
  state/                  # Runtime state
    sessions/             # Active session tracking
    jobs/                 # Job execution history
    evolution/            # Evolution queue, learnings, gaps, actions (JSON)
    serendipity/          # Pending serendipity findings (JSON + patches)
      processed/          # Triaged findings (promoted or dismissed)
      invalid/            # Failed HMAC verification
    journal/              # Decision journal entries (JSONL)
  context/                # Tiered context segments (auto-generated)
  relationships/          # Per-person relationship files (JSON)
  memory.db               # SQLite: topic memory + full-text search index
  logs/                   # Server logs

.claude/                  # Claude Code configuration
  settings.json           # Hook registrations
  scripts/                # Health watchdog, Telegram relay, smart-fetch

.instar/scripts/          # Agent infrastructure scripts
  serendipity-capture.sh  # Sub-agent finding capture (HMAC, validation, atomic write)
  skills/                 # Built-in + agent-created skills
```

## Key Files

| File | Format | Purpose |
|------|--------|---------|
| `config.json` | JSON | All server and integration configuration |
| `jobs.json` | JSON | Job definitions with cron schedules |
| `users.json` | JSON | User profiles (name, Telegram ID, email) |
| `AGENT.md` | Markdown | Agent identity, loaded into every session |
| `USER.md` | Markdown | User context, loaded into every session |
| `MEMORY.md` | Markdown | Accumulated learnings, always in context |
| `memory.db` | SQLite | Derived from JSONL -- deletable and rebuildable |

## State Files

All runtime state lives in `.instar/state/` as JSON files the agent can read and modify directly. This is deliberate -- the agent has full access to its own state.

## Why File-Based?

- **Transparency** -- Everything is inspectable with standard tools
- **Agent access** -- The agent can read and modify its own state
- **Portability** -- Copy the directory to move the agent
- **Simplicity** -- No database server to manage
- **Git-friendly** -- State can be version-controlled and synced
