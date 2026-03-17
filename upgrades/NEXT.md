# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Three fixes for Threadline agent-to-agent messaging reliability:

**Local-first delivery for co-located agents.** The `relay-send` endpoint now detects when the target agent is on the same machine (via `known-agents.json`) and delivers directly via their `/messages/relay-agent` HTTP endpoint using agent tokens from `~/.instar/agent-tokens/`. This bypasses the cloud relay entirely for same-machine agents, eliminating stale WebSocket connection issues that caused "delivered" messages to silently fail after server restarts. Falls back to relay if local delivery fails.

**Cold-spawn prompt fix.** The ThreadlineRouter's spawn prompt now correctly instructs sessions to use the `threadline_send` MCP tool for replies, replacing a reference to the nonexistent `/msg reply` command. The SpawnRequestManager and MessageFormatter prompts were also updated. Template variable substitution switched from `replace()` to `replaceAll()` so all occurrences of `{remote_agent}` and `{thread_id}` are properly substituted.

**Relay auth rate-limit backoff.** When the relay rejects an auth attempt with "Too many auth attempts," the RelayClient now bumps its reconnect attempt counter to enforce a ~32-second backoff before retrying, preventing retry storms during rapid server restarts.

Also includes: CLI commands for inspecting job execution history and continuity data (`instar job history`, `instar job handoff`), handoff notes for cross-execution continuity, usage-based reflection metrics, test infrastructure improvements, and a separate publish workflow for the threadline-mcp subpackage.

## What to Tell Your User

- **Reliable agent-to-agent messaging**: "Agents on the same machine can now talk to each other reliably. Messages are delivered directly without going through the cloud relay, so no more silent failures after server restarts."
- **Agents can reply**: "When one agent messages another, the receiving agent now knows how to reply properly. Previously, replies were silently dropped because the session was told to use a command that didn't exist."
- **Job inspection tools**: "You can now check what your agent has been working on between sessions. The new job history and handoff commands show execution records and continuity notes."
- **Reflection monitoring**: "Your agent now tracks reflection frequency, so you can see how often it pauses to learn from its work."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Threadline local delivery | Automatic for same-machine agents |
| Threadline reply fix | Automatic in spawned sessions |
| Relay auth backoff | Automatic on rate-limited connections |
| Job execution history | `instar job history [job-slug]` |
| Job handoff inspection | `instar job handoff [job-slug]` |
| Usage-based reflection metrics | Automatic |
