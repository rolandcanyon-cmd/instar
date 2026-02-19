#!/bin/bash
# Compaction recovery — re-injects identity when Claude's context compresses.
# Without this, the agent loses its identity every 30-60 minutes.
#
# This is the single most impactful hook for agent continuity.
# When context compresses, Claude effectively starts over. This hook
# ensures the agent knows who it is after every compaction event.
#
# Installed by agent-kit during setup. Runs as a Claude Code PostToolUse hook.

AGENT_KIT_DIR="${CLAUDE_PROJECT_DIR:-.}/.agent-kit"

# Check if we're in a post-compaction state by looking for compaction markers
# Claude Code emits specific patterns when context is compressed
# This hook provides the recovery seed

if [ -f "$AGENT_KIT_DIR/AGENT.md" ]; then
  AGENT_NAME=$(head -5 "$AGENT_KIT_DIR/AGENT.md" | grep -i "name\|I am\|My name" | head -1)
  if [ -n "$AGENT_NAME" ]; then
    echo "Identity reminder: $AGENT_NAME"
    echo "Read .agent-kit/AGENT.md and .agent-kit/MEMORY.md to restore full context."
  fi
fi
