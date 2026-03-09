#!/bin/bash
# Session Start — INJECTS working memory context at the beginning of every session.
# Bootstraps the agent with relevant knowledge from all memory layers before
# any work begins. This is the "right context at the right moment" — not a dump
# of everything, but a query-driven surface of what's most relevant now.
#
# DESIGN: Runs as a Claude Code UserPromptSubmit hook on first message.
# Outputs context directly (not pointers) — the agent reads it automatically.
#
# Phase 4 of PROP-memory-architecture: Working Memory Assembly.
#
# Installed by instar during setup. Runs as a Claude Code session-start hook.

INSTAR_DIR="${CLAUDE_PROJECT_DIR:-.}/.instar"
CONFIG_FILE="$INSTAR_DIR/config.json"

# Extract prompt from environment or first argument for query building
PROMPT="${CLAUDE_USER_PROMPT:-$1}"

if [ ! -f "$CONFIG_FILE" ]; then
  exit 0
fi

PORT=$(grep -o '"port":[0-9]*' "$CONFIG_FILE" | head -1 | cut -d':' -f2)
if [ -z "$PORT" ]; then
  exit 0
fi

AUTH_TOKEN=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('authToken',''))" 2>/dev/null)

# Check if server is alive
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  "http://localhost:${PORT}/health" 2>/dev/null)
if [ "$HEALTH" != "200" ]; then
  exit 0
fi

# Reset scope coherence state — prevents accumulated counts from prior sessions
# leaking into this session and causing false-positive hook triggers.
curl -s -X POST "http://localhost:${PORT}/scope-coherence/reset" -o /dev/null 2>/dev/null || true

# Check for pending serendipity findings
SERENDIPITY_DIR="$INSTAR_DIR/state/serendipity"
if [ -d "$SERENDIPITY_DIR" ]; then
  PENDING_COUNT=$(find "$SERENDIPITY_DIR" -maxdepth 1 -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$PENDING_COUNT" -gt 0 ]; then
    echo "=== SERENDIPITY: ${PENDING_COUNT} pending finding(s) ==="
    echo "Sub-agents captured discoveries during prior tasks."
    echo "Review with: ls $SERENDIPITY_DIR/*.json"
    for f in "$SERENDIPITY_DIR"/*.json; do
      [ -f "$f" ] || continue
      TITLE=$(python3 -c "import json; print(json.load(open('$f')).get('discovery',{}).get('title','(untitled)'))" 2>/dev/null || echo "(parse error)")
      CAT=$(python3 -c "import json; print(json.load(open('$f')).get('discovery',{}).get('category','?'))" 2>/dev/null || echo "?")
      echo "  - [$CAT] $TITLE"
    done
    echo "=== END SERENDIPITY ==="
    echo ""
  fi
fi

# Build working memory query from prompt
PROMPT_ENCODED=$(python3 -c "
import sys, urllib.parse
prompt = '''${PROMPT}'''[:500]
print(urllib.parse.quote(prompt))
" 2>/dev/null)

# Get active job slug for job-specific context
JOB_SLUG=""
if [ -f "$INSTAR_DIR/state/active-job.json" ]; then
  JOB_SLUG=$(grep -o '"slug":"[^"]*"' "$INSTAR_DIR/state/active-job.json" 2>/dev/null | head -1 | cut -d'"' -f4)
fi

# Build query URL
QUERY_URL="http://localhost:${PORT}/context/working-memory?limit=10"
if [ -n "$PROMPT_ENCODED" ]; then
  QUERY_URL="${QUERY_URL}&prompt=${PROMPT_ENCODED}"
fi
if [ -n "$JOB_SLUG" ]; then
  JOB_SLUG_ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${JOB_SLUG}'))" 2>/dev/null)
  QUERY_URL="${QUERY_URL}&jobSlug=${JOB_SLUG_ENCODED}"
fi

WORKING_MEM=$(curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" "$QUERY_URL" 2>/dev/null)

if [ -z "$WORKING_MEM" ]; then
  exit 0
fi

python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    ctx = data.get('context', '').strip()
    tokens = data.get('estimatedTokens', 0)
    sources = data.get('sources', [])

    if not ctx or tokens == 0:
        sys.exit(0)

    source_summary = ', '.join(
        f'{s[\"count\"]} {s[\"name\"]}' for s in sources if s.get('count', 0) > 0
    )
    print('=== SESSION CONTEXT — WORKING MEMORY ===')
    print(f'[{tokens} tokens from: {source_summary}]')
    print()
    print(ctx)
    print()
    print('=== END SESSION CONTEXT ===')
except Exception:
    sys.exit(0)
" <<< "$WORKING_MEM" 2>/dev/null

exit 0
