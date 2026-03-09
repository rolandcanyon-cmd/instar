---
title: Serendipity Protocol
description: Sub-agents capture valuable out-of-scope discoveries without breaking focus.
---

When an agent is focused on a task, it often notices things outside its scope — a bug in a neighboring file, a pattern worth documenting, a security issue in code it's reading. Before Serendipity, those observations were lost. The agent either ignored them or got sidetracked.

The Serendipity Protocol gives every agent a structured, secure side-channel to say "I noticed something valuable" without breaking focus.

## How It Works

```
Sub-agent (worktree)              Main agent
┌─────────────────┐              ┌────────────────┐
│ Focused task     │              │                │
│  ...notices bug  │              │                │
│  → capture.sh   │──findings──→ │  .instar/state │
│  ...back to task │  (copy-back) │  /serendipity/ │
└─────────────────┘              │                │
                                 │  session start │
                                 │  "3 pending    │
                                 │   findings"    │
                                 │                │
                                 │  /triage →     │
                                 │  Evolution     │
                                 └────────────────┘
```

1. Sub-agent notices something valuable while working
2. Runs a one-line shell command to capture it
3. Finding gets validated, signed, and stored
4. When the worktree is torn down, findings copy to the main tree
5. Parent agent gets notified on next session start
6. Parent triages: promote to [Evolution](/features/evolution/) proposal, dismiss, or flag for review

## Capturing a Finding

Sub-agents use the helper script — they never construct JSON directly:

```bash
.instar/scripts/serendipity-capture.sh \
  --title "Off-by-one in retry logic" \
  --description "The retry counter starts at 1 but check uses >=" \
  --category bug \
  --rationale "Causes one extra API call under load" \
  --readiness idea-only
```

### Categories

| Category | When to use |
|----------|-------------|
| `bug` | Something is broken |
| `improvement` | Something could be better |
| `feature` | A new capability worth adding |
| `pattern` | A recurring pattern worth documenting |
| `refactor` | Code that should be restructured |
| `security` | A security concern |

### Readiness Levels

| Level | Meaning |
|-------|---------|
| `idea-only` | Just the observation, no implementation |
| `partially-implemented` | Some work done, not complete |
| `implementation-complete` | Code changes ready but untested |
| `tested` | Changes implemented and verified |

### Attaching Code Changes

If the sub-agent has a diff, save it as a patch file:

```bash
git diff > /tmp/fix.patch
.instar/scripts/serendipity-capture.sh \
  --title "Fix retry counter" \
  --description "..." \
  --category bug \
  --rationale "..." \
  --readiness implementation-complete \
  --patch-file /tmp/fix.patch
```

The patch file's SHA-256 hash is cryptographically bound to the finding via HMAC, so tampering is detectable.

## Security Model

The serendipity directory is treated as an **untrusted input boundary**. Sub-agents can suggest, but they can't act — the parent always reviews.

### HMAC Signing

Every finding is signed with HMAC-SHA256:
- **Key derivation**: `HMAC-SHA256(authToken, "serendipity-v1:" + sessionId)`
- **Signed payload**: Canonical JSON of `{id, createdAt, discovery, source, artifacts}`
- **What it proves**: The finding was created by a process with access to the local auth token during a specific session. It's integrity verification, not trust attestation.

### Secret Scanning

The capture script blocks (not warns) findings containing:
- AWS access keys (`AKIA...`)
- GitHub/GitLab tokens (`ghp_`, `glpat-`)
- Slack tokens (`xox[bpors]-`)
- OpenAI-style API keys (`sk-...`)
- Private keys (`-----BEGIN PRIVATE KEY-----`)
- Password assignments

Findings with detected secrets are rejected. The sub-agent must remove the secret and retry.

### Patch File Hardening

- Symlinks rejected (prevents sandbox escape)
- Size limited to 10KB
- Path traversal in diff headers (`../`) rejected (prevents Zip Slip equivalent)
- SHA-256 hash bound to HMAC signature

### Worktree Copy-Back

When findings are copied from worktrees to the main tree:
- Symlinks rejected
- Regular files only
- 100KB size limit per file
- Atomic copy (write to `.tmp`, then rename)
- Duplicate detection by filename (same finding ID = skip)

### Rate Limiting

Default 5 findings per session. Configurable via `serendipity.maxPerSession` in config. Counted per `CLAUDE_SESSION_ID`, not globally.

## Triage

The `/triage-findings` skill walks through pending findings:

1. **Verify** — Check HMAC signature and patch hash
2. **Assess** — Is it actionable? Is it a duplicate?
3. **Route** — Promote to Evolution proposal, dismiss, or flag for manual review
4. **Move** — Processed findings go to `.instar/state/serendipity/processed/`

Failed HMAC verification routes findings to `.instar/state/serendipity/invalid/`.

## API

```bash
# Stats: pending, processed, invalid counts
curl localhost:4040/serendipity/stats

# Full pending findings
curl localhost:4040/serendipity/findings
```

## Configuration

```json
{
  "serendipity": {
    "enabled": true,
    "maxPerSession": 5
  }
}
```

The protocol is opt-out — enabled by default with no configuration needed. Set `enabled: false` to disable.

## Session Integration

- **Session start**: Hook checks for pending findings and lists each with `[category] title`
- **Compaction recovery**: Shows pending finding count after identity restoration
- **CLAUDE.md**: Full protocol documentation included in agent instructions

## File Layout

```
.instar/
  scripts/
    serendipity-capture.sh    # Helper script (installed by instar init)
  state/
    serendipity/              # Pending findings
      srdp-a1b2c3d4.json     # Finding metadata + HMAC
      srdp-a1b2c3d4.patch    # Optional code diff
      processed/              # Triaged findings
      invalid/                # Failed HMAC verification
```
