# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

**A new way sessions die is now detected and (optionally) auto-recovered.** When
a tool call is cancelled inside a *parallel* tool batch while extended thinking
is on, Claude Code corrupts the thinking block on the latest assistant turn —
and from then on the Anthropic API rejects every resume with
`400 … thinking blocks in the latest assistant message cannot be modified`. The
session fast-fails instantly on every message ("Cooked for 0s"): permanently
dead, yet still emitting output. Because it's not *silent* and hasn't lost its
socket, neither the ActiveWorkSilenceSentinel nor the SocketDisconnectSentinel
catches it — the user just sees standby/sentinel replies forever while the real
session is a corpse. (Live incident: a session on a real topic fast-failed every
"How is this looking?" for ~30 minutes.)

The new **ContextWedgeSentinel** (a 4th member of the silently-stopped family)
recognizes this exact wedge: it matches the error as the *live session tail* and
waits a 45s confirm window so a session merely *discussing* the bug is never
flagged. A gentle nudge can't fix this one (re-engaging re-sends the corrupted
turn), so recovery is a **fresh respawn** — kill the session and clear the
topic's saved resume UUID so the bridge spawns a brand-new conversation instead
of `--resume`-ing the corrupted transcript (which would just re-wedge on the
next message — the central correctness property). This reuses the existing
rate-guarded `SessionRefresh` via a new `fresh` mode.

Detection + audit are **default-ON housekeeping** (they write to
`logs/sentinel-events.jsonl` and kill nothing). The destructive auto-respawn is
**opt-in** (`monitoring.contextWedgeSentinel.autoRecovery`, default off + dry-run)
and rides the Graduated Feature Rollout track. The sentinel also feeds the
SessionReaper kill-veto so the reaper never reaps a session mid-recovery. New
config kill switch `monitoring.contextWedgeSentinel.enabled` (default true).

## What to Tell Your User

- I can now spot a specific way a session silently dies — it gets stuck on a
  "can't modify the thinking block" error and fails instantly on every message
  while still looking busy — which used to leave you seeing only standby replies.
- By default I just notice it and log it (nothing is killed). You can opt in to
  having me automatically restart a stuck session cleanly; when that's on I throw
  away the corrupted conversation and start fresh so it can't get re-stuck.
- Nothing you see changes by default. If you ever want the auto-restart on, it's
  one config switch, and it's on a track that will nag toward on-by-default once
  it's proven itself.

## Summary of New Capabilities

- **ContextWedgeSentinel** — detects the thinking-block-400 fast-fail wedge as a
  non-progressing session tail (45s confirm window); audits every transition to
  `logs/sentinel-events.jsonl`.
- **SessionRefresh `fresh` mode** — kill + respawn that clears the topic's resume
  UUID, so recovery never reloads a corrupted transcript (no re-wedge loop).
- **Opt-in auto-recovery** — `monitoring.contextWedgeSentinel.autoRecovery`
  (default off + dry-run), on the Graduated Feature Rollout track; promotion to
  default-on propagates fleet-wide on update with no migration.
- Escalation (when a confirmed wedge isn't auto-recovered) routes through the
  existing tone-gated SentinelNotifier, gated by `sentinelTelegramEscalation`
  (default off, coalesced).
