# instar-skills

A collection of [Agent Skills](https://agentskills.io) for AI coding agents. Some work with any Claude Code project out of the box. Others unlock the full power of [Instar](https://instar.sh) — persistent autonomy infrastructure for AI agents.

---

## What are Agent Skills?

Agent Skills are folders containing `SKILL.md` files. Compatible agents (Claude Code, Codex, Cursor, VS Code, Amp, goose, and 30+ others) discover and load these files automatically, gaining new capabilities on demand.

The [Agent Skills open standard](https://agentskills.io/specification) works across all major AI coding tools.

---

## Standalone Skills (No Dependencies)

These work with **any Claude Code project** — no Instar required. Drop them in and get immediate value.

### [agent-identity](./agent-identity/SKILL.md)

Set up persistent agent identity files (AGENT.md, USER.md, MEMORY.md) that survive across sessions. Teaches the agent who it is and how to orient after context compaction.

### [agent-memory](./agent-memory/SKILL.md)

Cross-session memory patterns using MEMORY.md. How to organize, maintain, and leverage accumulated knowledge. The agent remembers what it learned last week.

### [smart-web-fetch](./smart-web-fetch/SKILL.md)

Token-efficient web fetching. Checks llms.txt first, then Cloudflare markdown, then falls back to HTML. 60-80% fewer tokens on documentation and blog pages. Installs a single Python script.

### [command-guard](./command-guard/SKILL.md)

Safety hooks that block destructive commands (`rm -rf`, force push, database drops) before they execute. Installs a Claude Code PreToolUse hook — structural safety, not behavioral.

---

## Instar-Powered Skills

These unlock capabilities that require a persistent server — job scheduling, session management, Telegram messaging. **If Instar isn't installed, the skill guides the user through setup.** No hard walls.

### [instar-scheduler](./instar-scheduler/SKILL.md)

Schedule recurring agent tasks on cron. Each job spawns a real Claude Code session with full tool access. Priority levels, model tiers, quota awareness.

### [instar-session](./instar-session/SKILL.md)

Spawn, monitor, and communicate with persistent Claude Code sessions running in tmux. Background tasks, parallel work, long-running operations.

### [instar-telegram](./instar-telegram/SKILL.md)

Two-way Telegram messaging. Each job gets its own forum topic. Your Telegram group becomes a living dashboard. Message your agent from your phone, anywhere.

### [instar-identity](./instar-identity/SKILL.md)

The full identity infrastructure — hooks that re-inject identity on every session start, after compaction, and before external messaging. Structure over willpower.

### [instar-feedback](./instar-feedback/SKILL.md)

Structured feedback that flows agent-to-agent. Your agent reports issues directly to the AI that maintains Instar. One agent's growing pain becomes every agent's growth.

---

## Installing Skills

### Copy into your project

```bash
# Copy individual skills
cp -r /path/to/instar/skills/smart-web-fetch .claude/skills/
cp -r /path/to/instar/skills/agent-identity .claude/skills/

# Or copy all standalone skills
for skill in agent-identity agent-memory smart-web-fetch command-guard; do
  cp -r /path/to/instar/skills/$skill .claude/skills/
done
```

Skills in `.claude/skills/` are auto-discovered by Claude Code as slash commands.

### Symlink (same machine)

```bash
ln -s /path/to/instar/skills/smart-web-fetch .claude/skills/smart-web-fetch
```

---

## How the Funnel Works

The standalone skills provide real value with zero friction. When a developer wants more — "run this on a schedule", "message me when it's done", "keep working while I sleep" — the Instar-powered skills are right there, and they handle the onboarding:

1. Developer installs `agent-identity` — works immediately, loves it
2. Developer wants identity to survive restarts automatically — finds `instar-identity`
3. Skill detects Instar isn't installed — explains the value, offers `npx instar`
4. Developer installs Instar — 2-minute setup, immediate upgrade
5. All Instar skills now work. Agent has a persistent body.

No walls. No friction. Value at every step.

---

## License

MIT — same as [Instar](https://instar.sh).

[instar.sh](https://instar.sh) · [npm](https://www.npmjs.com/package/instar) · [GitHub](https://github.com/JKHeadley/instar)
