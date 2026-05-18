#!/usr/bin/env bash
# Interactive-pool feasibility prototype.
#
# Question: can we drive a long-lived `claude` REPL via tmux send-keys
# reliably enough to serve as a substrate for Instar's intelligence calls?
#
# Approach:
#   - Spawn one bare `claude` REPL in a detached tmux session
#   - Send N prompts in sequence, capturing each response
#   - Measure: latency, output capture reliability, multi-prompt session stability
#
# Output goes to ./results/run-<timestamp>/ with one file per prompt plus a summary.

set -euo pipefail

PROTO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_BIN="/opt/homebrew/bin/claude"
TMUX_SESSION="prototype-interactive-pool-$$"
RUN_DIR="$PROTO_DIR/results/run-$(date +%Y%m%d-%H%M%S)"
STABILITY_SECONDS=4    # consecutive seconds of no output change before we call response complete
POLL_INTERVAL=1
MAX_WAIT_SECONDS=120   # hard ceiling per prompt
IDLE_MARKERS=("? for shortcuts" "bypass permissions on" "shift+tab to cycle")

mkdir -p "$RUN_DIR"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$RUN_DIR/run.log"; }

cleanup() {
  log "Cleaning up tmux session $TMUX_SESSION"
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
}
trap cleanup EXIT

# ── Step 1: spawn the REPL ─────────────────────────────────────────────────────
log "Spawning bare claude REPL in tmux session $TMUX_SESSION"
# CLAUDECODE= clears the nested-session marker; CLAUDE_SESSION_ID= scrubbed too.
tmux new-session -d -s "$TMUX_SESSION" \
  -e "CLAUDECODE=" \
  -e "CLAUDE_SESSION_ID=" \
  -x 200 -y 50 \
  "$CLAUDE_BIN --dangerously-skip-permissions"

# ── Step 2: wait for the REPL to be ready ──────────────────────────────────────
log "Waiting up to 30s for REPL to reach idle prompt"
ready=false
for i in $(seq 1 30); do
  sleep 1
  pane=$(tmux capture-pane -t "$TMUX_SESSION" -p -S -50 2>/dev/null || echo "")
  for marker in "${IDLE_MARKERS[@]}"; do
    if grep -qF "$marker" <<<"$pane"; then
      ready=true
      log "REPL ready after ${i}s (saw marker: $marker)"
      break 2
    fi
  done
done

if ! $ready; then
  log "ERROR: REPL did not reach idle prompt in 30s. Dumping pane:"
  tmux capture-pane -t "$TMUX_SESSION" -p -S -100 > "$RUN_DIR/startup-failure.txt"
  exit 2
fi

# Snapshot the pane at idle so we can diff against it later
tmux capture-pane -t "$TMUX_SESSION" -p -S -200 > "$RUN_DIR/00-startup-idle.txt"

# ── Step 3: prompt-run loop ────────────────────────────────────────────────────
PROMPTS=(
  "What is 2 plus 2? Reply with just the number."
  "List three primary colors, one per line, no other text."
  "Write a haiku about provider portability."
  "Give me the capital of France. Just the name."
  "Output a JSON object with keys 'a' and 'b' set to integers 1 and 2."
  "Count from 5 to 1 backwards."
  "What's the boiling point of water in Celsius? Number only."
  "Generate a random UUID v4."
  "Reverse the string 'instar' for me."
  "Translate 'hello' to French."
)

send_prompt() {
  local idx="$1" prompt="$2"
  local prefix
  prefix=$(printf "%02d" "$idx")
  log "=== Prompt $prefix ==="
  log "Sending: $prompt"

  # Snapshot output buffer length BEFORE sending
  local before_file="$RUN_DIR/${prefix}-before.txt"
  tmux capture-pane -t "$TMUX_SESSION" -p -S -500 > "$before_file"
  local before_lines
  before_lines=$(wc -l < "$before_file")

  local start_ts end_ts
  start_ts=$(date +%s)

  # Send the prompt then Enter. Two-step so paste-bracketing doesn't eat the Enter.
  tmux send-keys -t "$TMUX_SESSION" -l "$prompt"
  sleep 0.5
  tmux send-keys -t "$TMUX_SESSION" Enter

  # Poll for output stability
  local last_size=0 current_size=0 stable_for=0
  local elapsed=0
  while [ "$elapsed" -lt "$MAX_WAIT_SECONDS" ]; do
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
    current_size=$(tmux capture-pane -t "$TMUX_SESSION" -p -S -1000 | wc -c)
    if [ "$current_size" = "$last_size" ]; then
      stable_for=$((stable_for + POLL_INTERVAL))
      if [ "$stable_for" -ge "$STABILITY_SECONDS" ]; then
        # Verify we're back at idle prompt
        local pane_now
        pane_now=$(tmux capture-pane -t "$TMUX_SESSION" -p -S -50)
        for marker in "${IDLE_MARKERS[@]}"; do
          if grep -qF "$marker" <<<"$pane_now"; then
            log "Response complete after ${elapsed}s (stable for ${stable_for}s, idle marker present)"
            break 2
          fi
        done
        # No idle marker yet — keep waiting but reset stability count
        log "Stable but no idle marker visible — resetting and waiting more"
        stable_for=0
      fi
    else
      stable_for=0
      last_size="$current_size"
    fi
  done

  end_ts=$(date +%s)
  local duration=$((end_ts - start_ts))

  # Capture the after-state and diff
  local after_file="$RUN_DIR/${prefix}-after.txt"
  tmux capture-pane -t "$TMUX_SESSION" -p -S -1000 > "$after_file"

  # Extract response: everything new since before snapshot
  diff "$before_file" "$after_file" | grep -E '^>' | sed 's/^> //' > "$RUN_DIR/${prefix}-response.txt" || true

  local resp_size
  resp_size=$(wc -c < "$RUN_DIR/${prefix}-response.txt")

  log "Prompt $prefix completed in ${duration}s, response bytes: $resp_size"

  if [ "$elapsed" -ge "$MAX_WAIT_SECONDS" ]; then
    log "WARN: Hit max wait ($MAX_WAIT_SECONDS s) without idle marker"
  fi

  # Add to summary
  printf '%s\t%ss\t%s bytes\n' "$prefix" "$duration" "$resp_size" >> "$RUN_DIR/summary.tsv"
}

echo -e "idx\tduration\tresponse_size" > "$RUN_DIR/summary.tsv"

for i in "${!PROMPTS[@]}"; do
  send_prompt "$i" "${PROMPTS[$i]}"
done

log "=== Run complete ==="
log "Results: $RUN_DIR"
log "Summary:"
cat "$RUN_DIR/summary.tsv" | tee -a "$RUN_DIR/run.log"
