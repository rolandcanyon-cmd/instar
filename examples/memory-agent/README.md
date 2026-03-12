# Example: Memory-Persistent Agent

An Instar agent that remembers across sessions using built-in memory infrastructure.

## Files

### `AGENT.md`

```markdown
# Research Partner

I am a research partner who tracks ongoing projects and remembers past discussions.

## Core Behavior
- Remember what we've discussed across sessions
- Track project status and decisions
- Build on previous conversations rather than starting fresh

## Memory Practices
- After significant conversations, note key decisions and context
- Reference past discussions when relevant
- Maintain continuity of ongoing projects
```

### `MEMORY.md`

```markdown
# Memory

This file persists across sessions. I update it with important context.

## Active Projects
<!-- Updated as projects are discussed -->

## Key Decisions
<!-- Important decisions and their rationale -->

## People & Context
<!-- Who I interact with and relevant background -->
```

### `jobs.json`

```json
[
  {
    "slug": "reflection",
    "name": "Daily Reflection",
    "description": "Review recent conversations and update memory",
    "schedule": "0 22 * * *",
    "priority": "normal",
    "prompt": "Review today's conversations in the message history. Update MEMORY.md with any important context, decisions, or project updates. Be selective — only note things that will matter in future sessions."
  }
]
```

## Setup

1. Create a project directory with `AGENT.md`, `MEMORY.md`, and `jobs.json`
2. Run `instar server start`
3. Interact with your agent (via Telegram, terminal, etc.)
4. The nightly reflection job updates `MEMORY.md` with important context

## How Memory Works in Instar

Instar provides multiple layers of memory:

| Layer | Mechanism | Scope |
|-------|-----------|-------|
| **MEMORY.md** | File on disk, always loaded | Global across all sessions |
| **Conversational memory** | SQLite with FTS5, per-topic | Per conversation thread |
| **Rolling summaries** | Auto-generated conversation digests | Per conversation thread |
| **Evolution system** | Learnings, proposals, gap tracking | Agent-wide growth |

The simplest starting point is `MEMORY.md` — Claude Code loads it automatically at session start. The conversational memory and evolution systems are built into Instar and work without extra configuration.

## Tips

- Start with a nearly empty `MEMORY.md` and let the agent fill it organically
- The reflection job is optional — the agent also updates memory during conversations
- Use the `agent-memory` skill for more structured memory patterns

> **Full docs:** [Memory](https://instar.sh/features/memory/) · [Evolution](https://instar.sh/features/evolution/) · [agent-memory skill](https://github.com/SageMindAI/instar/tree/main/skills/agent-memory)
