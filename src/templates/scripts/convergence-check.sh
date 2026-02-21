#!/bin/bash
# Lightweight convergence check — heuristic content quality gate before messaging.
# No LLM calls. Fast. Catches the most common agent failure modes.
#
# Usage: echo "message content" | bash .instar/scripts/convergence-check.sh
# Exit codes: 0 = converged (safe to send), 1 = issues found (review needed)
#
# Inspired by Dawn's convergence-check.py (PROP-159) but simplified for
# generic agents. Checks 5 criteria via pattern matching:
#
# 1. capability_claims — Claims about what the agent can't do (may be wrong)
# 2. commitment_overreach — Promises the agent may not be able to keep
# 3. settling — Accepting empty/failed results without investigation
# 4. experiential_fabrication — Claiming to see/read/feel without verification
# 5. sycophancy — Reflexive agreement, excessive apology, capitulation
#
# This is Structure > Willpower: the check runs automatically before
# external messaging, not when the agent remembers to do it.

CONTENT=$(cat)
ISSUES=()
ISSUE_COUNT=0

# 1. CAPABILITY CLAIMS — Watch for "I can't" / "I don't have" / "not available"
if echo "$CONTENT" | grep -qiE "(unfortunately.{0,20}(i can.t|i.m unable|not (possible|available|supported))|i don.t have (the ability|access|a way)|this (isn.t|is not) (possible|available|supported))"; then
  ISSUES+=("CAPABILITY: You're claiming a limitation. Did you check /capabilities first? Many 'I can't' statements are wrong — verify before sending.")
  ISSUE_COUNT=$((ISSUE_COUNT + 1))
fi

# 2. COMMITMENT OVERREACH — Promises that may not survive session boundaries
if echo "$CONTENT" | grep -qiE "(i.ll (make sure|ensure|guarantee|always|never forget)|i (promise|commit to|will always)|you can count on me to|i.ll remember (to|this)|from now on i.ll)"; then
  ISSUES+=("COMMITMENT: You're making a promise that may not survive context compaction or session end. Can your infrastructure actually keep this commitment? If not, reframe as intent rather than guarantee.")
  ISSUE_COUNT=$((ISSUE_COUNT + 1))
fi

# 3. SETTLING — Accepting empty results without digging deeper
if echo "$CONTENT" | grep -qiE "(no (data|results|information) (available|found|exists)|nothing (to report|happened|was found)|there (is|are) no|could(n.t| not) find (any|the)|appears to be empty|no (relevant|matching|applicable))"; then
  ISSUES+=("SETTLING: You're reporting nothing found. Did you check multiple sources? Could the data source be stale or the search terms wrong? Empty results deserve investigation, not acceptance.")
  ISSUE_COUNT=$((ISSUE_COUNT + 1))
fi

# 4. EXPERIENTIAL FABRICATION — Claiming first-person experience without tool verification
if echo "$CONTENT" | grep -qiE "(i (can see|noticed|observed|felt|sensed|perceived) (that |the |a |an )|looking at (this|the|your)|from what i.ve (seen|read|observed)|i.ve (reviewed|examined|analyzed|inspected) (the|your|this))"; then
  ISSUES+=("EXPERIENTIAL: You're claiming a first-person experience. Did you actually access this data with a tool in THIS session, or are you completing a social script? Verify before claiming.")
  ISSUE_COUNT=$((ISSUE_COUNT + 1))
fi

# 5. SYCOPHANCY — Reflexive agreement, excessive apology
if echo "$CONTENT" | grep -qiE "(you.re (absolutely|totally|completely) right|i (completely|totally|fully) (agree|understand)|great (question|point|observation)|i apologize for|sorry.{0,20}(mistake|confusion|error|oversight)|that.s (a |an )?(excellent|great|wonderful|fantastic) (point|question|idea|suggestion))"; then
  ISSUES+=("SYCOPHANCY: You may be reflexively agreeing or over-apologizing. If you genuinely agree, state why. If you don't fully agree, say what you actually think. Politeness is not a substitute for honesty.")
  ISSUE_COUNT=$((ISSUE_COUNT + 1))
fi

# Output results
if [ "$ISSUE_COUNT" -gt "0" ]; then
  echo "=== CONVERGENCE CHECK: ${ISSUE_COUNT} ISSUE(S) FOUND ==="
  echo ""
  for ISSUE in "${ISSUES[@]}"; do
    echo "  - $ISSUE"
    echo ""
  done
  echo "Review and revise before sending. Re-run this check after revision."
  echo "=== END CONVERGENCE CHECK ==="
  exit 1
else
  exit 0
fi
