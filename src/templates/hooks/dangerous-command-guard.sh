#!/bin/bash
# Dangerous command guard — blocks destructive operations.
# Part of agent-kit's "Security Through Identity" model.
#
# Installed by agent-kit during setup. Runs as a Claude Code PreToolUse hook on Bash.

# The command being executed is passed via TOOL_INPUT
INPUT="$1"

# Patterns that should be blocked without explicit user confirmation
DANGEROUS_PATTERNS=(
  "rm -rf /"
  "rm -rf ~"
  "rm -rf \."
  "git push --force"
  "git push -f"
  "git reset --hard"
  "git clean -fd"
  "DROP TABLE"
  "DROP DATABASE"
  "TRUNCATE"
  "DELETE FROM"
  "> /dev/sda"
  "mkfs\."
  "dd if="
  ":(){:|:&};:"
)

for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
    echo "BLOCKED: Potentially destructive command detected: $pattern"
    echo "If you genuinely need to run this command, ask the user for explicit confirmation first."
    exit 2
  fi
done
