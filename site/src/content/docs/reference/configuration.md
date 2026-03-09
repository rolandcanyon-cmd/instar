---
title: Configuration
description: Configuration reference for Instar agents.
---

All configuration lives in `.instar/config.json`, created during setup and editable at any time.

## Server

```json
{
  "server": {
    "port": 4040,
    "host": "127.0.0.1"
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `port` | 4040 | Server port |
| `host` | 127.0.0.1 | Bind address (localhost only by default) |

## Telegram

```json
{
  "telegram": {
    "botToken": "...",
    "chatId": -100...,
    "topicAutoCreate": true
  }
}
```

## WhatsApp

```json
{
  "whatsapp": {
    "enabled": true
  }
}
```

WhatsApp state is managed internally via the Baileys library.

## Scheduler

```json
{
  "scheduler": {
    "enabled": true,
    "maxConcurrentSessions": 3
  }
}
```

## Auth

```json
{
  "auth": {
    "token": "..."
  }
}
```

The auth token is used for API authentication. Generated during setup.

## Serendipity Protocol

```json
{
  "serendipity": {
    "enabled": true,
    "maxPerSession": 5
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable/disable the serendipity capture protocol |
| `maxPerSession` | `5` | Maximum findings a sub-agent can capture per session |

The protocol is opt-out — enabled by default. Findings are stored in `.instar/state/serendipity/`.

## Identity Files

These aren't in config.json but are critical configuration:

| File | Purpose |
|------|---------|
| `.instar/AGENT.md` | Agent identity -- who it is, its principles |
| `.instar/USER.md` | User context -- who it works with, preferences |
| `.instar/MEMORY.md` | Persistent learnings across sessions |
| `.instar/ORG-INTENT.md` | Organizational constraints (optional) |

## Jobs

Jobs are defined in `.instar/jobs.json`. See [Job Scheduler](/features/scheduler) for the format.

## Hooks

Behavioral hooks are installed in `.claude/settings.json` and scripts live in `.instar/hooks/` and `.claude/scripts/`. See [Hooks reference](/reference/hooks) for details.
