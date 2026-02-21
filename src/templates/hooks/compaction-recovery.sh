#!/bin/bash
# Compaction recovery — INJECTS identity when Claude's context compresses.
# Without this, the agent loses its identity every 30-60 minutes.
#
# CRITICAL DESIGN: This hook OUTPUTS file content directly, not pointers.
# After compaction, the agent is confused — asking it to read files is
# asking the confused agent to help itself. Structure > Willpower:
# the hook does the work, not the agent.
#
# The 164th Lesson (Dawn): Advisory hooks are insufficient.
# Grounding must be automatic — content injected, not pointed to.
#
# Installed by instar during setup. Runs as a Claude Code Notification hook
# matched on "compaction".

INSTAR_DIR="${CLAUDE_PROJECT_DIR:-.}/.instar"

echo "=== COMPACTION RECOVERY — IDENTITY RESTORATION ==="
echo ""

# Phase A: Core Identity (inject AGENT.md content directly)
if [ -f "$INSTAR_DIR/AGENT.md" ]; then
  echo "--- YOUR IDENTITY (from .instar/AGENT.md) ---"
  cat "$INSTAR_DIR/AGENT.md"
  echo ""
  echo "--- END IDENTITY ---"
  echo ""
fi

# Phase B: Memory (inject MEMORY.md content directly)
if [ -f "$INSTAR_DIR/MEMORY.md" ]; then
  # Only inject if MEMORY.md has actual content (more than the template skeleton)
  MEMORY_LINES=$(wc -l < "$INSTAR_DIR/MEMORY.md" | tr -d ' ')
  if [ "$MEMORY_LINES" -gt "15" ]; then
    echo "--- YOUR MEMORY (from .instar/MEMORY.md) ---"
    cat "$INSTAR_DIR/MEMORY.md"
    echo ""
    echo "--- END MEMORY ---"
    echo ""
  else
    echo "Memory file exists at .instar/MEMORY.md (minimal content — check if needed)."
    echo ""
  fi
fi

# Phase C: User context (inject USER.md content directly)
if [ -f "$INSTAR_DIR/USER.md" ]; then
  echo "--- YOUR USER (from .instar/USER.md) ---"
  cat "$INSTAR_DIR/USER.md"
  echo ""
  echo "--- END USER ---"
  echo ""
fi

# Phase D: Active dispatch context (behavioral lessons from Dawn)
if [ -f "$INSTAR_DIR/state/dispatch-context.md" ]; then
  DISPATCH_LINES=$(wc -l < "$INSTAR_DIR/state/dispatch-context.md" | tr -d ' ')
  if [ "$DISPATCH_LINES" -gt "2" ]; then
    echo "--- ACTIVE DISPATCHES (behavioral lessons) ---"
    cat "$INSTAR_DIR/state/dispatch-context.md"
    echo ""
    echo "--- END DISPATCHES ---"
    echo ""
  fi
fi

# Phase E: Job-specific grounding (if a job slug is detectable)
if [ -f "$INSTAR_DIR/state/active-job.json" ]; then
  JOB_SLUG=$(grep -o '"slug":"[^"]*"' "$INSTAR_DIR/state/active-job.json" 2>/dev/null | head -1 | cut -d'"' -f4)
  if [ -n "$JOB_SLUG" ] && [ -f "$INSTAR_DIR/grounding/jobs/${JOB_SLUG}.md" ]; then
    echo "--- JOB CONTEXT: ${JOB_SLUG} ---"
    cat "$INSTAR_DIR/grounding/jobs/${JOB_SLUG}.md"
    echo ""
    echo "--- END JOB CONTEXT ---"
    echo ""
  fi
fi

# Relationships summary
if [ -d "$INSTAR_DIR/relationships" ]; then
  REL_COUNT=$(ls -1 "$INSTAR_DIR/relationships"/*.json 2>/dev/null | wc -l | tr -d ' ')
  if [ "$REL_COUNT" -gt "0" ]; then
    echo "You have ${REL_COUNT} tracked relationships in .instar/relationships/."
    echo ""
  fi
fi

# Server health reminder
CONFIG_FILE="$INSTAR_DIR/config.json"
if [ -f "$CONFIG_FILE" ]; then
  PORT=$(grep -o '"port":[0-9]*' "$CONFIG_FILE" | head -1 | cut -d':' -f2)
  if [ -n "$PORT" ]; then
    echo "Server: curl http://localhost:${PORT}/health | Capabilities: curl http://localhost:${PORT}/capabilities"
  fi
fi

echo ""
echo "=== RECOVERY COMPLETE — You are grounded. Continue your work. ==="
