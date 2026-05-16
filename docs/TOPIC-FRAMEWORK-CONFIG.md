# Per-Topic Framework Configuration

> Provider-portability v1.0.0 capability — Tier 1.A.

Each Telegram topic can run sessions on a different framework. This lets you A/B between Claude Code (subscription) and Codex CLI in real conversation topics without changing the agent's overall framework.

## What this controls

When a message lands in a Telegram topic and a session needs to be spawned (fresh or after a death), Echo consults `topicFrameworks` to decide which CLI to launch. Per-topic absent → falls through to `INSTAR_FRAMEWORK` env var → defaults to `claude-code`.

## How to configure

Edit `.instar/config.json` and add a `topicFrameworks` block keyed by Telegram topic id:

```json
{
  "topicFrameworks": {
    "9984": "claude-code",
    "9985": "codex-cli",
    "9986": "claude-code"
  }
}
```

Values supported today:
- `"claude-code"` — Claude Code CLI in interactive subscription mode. OAuth token, billed against your main subscription. Equivalent to v0.x behavior.
- `"claude-code-agent-sdk"` — Claude Code CLI, but with API-key auth instead of OAuth. The session bills against the separate Agent SDK $200/mo Max 20x credit bucket (per Anthropic's June 2026 billing notice), not your subscription pool. Same binary, different billing.
- `"codex-cli"` — Codex CLI with `--sandbox workspace-write --ask-for-approval never` (agentic-but-safe).

Topic ids not present in the map use the agent-level default (`sessions.framework` or `INSTAR_FRAMEWORK` env, falling back to `claude-code`).

## What spawns

When a session spawns for topic 9985 in the example above, Echo runs (conceptually):

```
codex --sandbox workspace-write --ask-for-approval never
```

inside a fresh tmux session with `INSTAR_FRAMEWORK=codex-cli` exported. All sentinels (watchdog, orphan reaper, stall triage) recognize this is a Codex session and apply the Codex activity patterns.

## Resume semantics

- Claude: resumes pick up the same conversation (`--resume <id>`).
- Codex: resume is a subcommand (`codex resume <id>`), not a flag. The current launch path starts fresh and emits a console warning. Codex resume support lands when TopicResumeMap is generalized.

## Verifying

Boot the server and trigger a topic spawn (any message into the configured topic). The server log will print:

```
[SessionManager] Spawning interactive session "<name>" (framework: codex-cli)
```

If you see `(framework: claude-code)` when you expected codex, check:
1. The topic id is the EXACT id in the map (Telegram topic ids are integers; JSON keys are strings — JSON.stringify the id).
2. The framework binary is detected at boot. Logs will show `Intelligence: Codex CLI` if codex is found, or fall back if not.
3. `INSTAR_FRAMEWORK` env var didn't override.

## Configuring the Agent SDK credential

For `claude-code-agent-sdk` topics, the launch path needs an Anthropic API key (NOT an OAuth token) to bill against the Agent SDK pool. Configure it in `.instar/config.json`:

```json
{
  "sessions": {
    "credentials": {
      "anthropic-agent-sdk": {
        "kind": "api-key",
        "value": "sk-ant-api03-..."
      }
    }
  }
}
```

If the dedicated slot is missing, the legacy `sessions.anthropicApiKey` is used IF it's API-key-shaped (not `sk-ant-oat...`). If neither is set, the spawn proceeds with whatever `ANTHROPIC_API_KEY` is in the spawning process env and emits a console warning so you see the gap.

## Known limitations (v1.0.0)

- Codex sessions don't share Echo's Claude-specific hooks (`.claude/hooks/*`). Compaction recovery, identity injection, and grounding hooks are Claude Code-only. Codex topics get a vanilla Codex REPL — no Echo-specific intercepts.
- Codex resume is not yet wired (Codex CLI's resume is a subcommand, not a flag).
- Slack/WhatsApp/iMessage adapters still use the global framework — only Telegram topics have per-topic overrides today.
