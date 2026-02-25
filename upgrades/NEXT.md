# Upgrade Guide: Promise Tracking & SessionMonitor

## What Changed

### Promise Tracking — No More Silent Agent Gaps

Previously, when an agent said "give me a couple minutes" and then went silent, the stall detection system didn't catch it. The agent's response cleared the stall tracker, and with no pending user message, no alarm fired. The agent could go silent indefinitely.

Now the system detects 13+ "work-in-progress" patterns (e.g., "give me a minute", "working on it", "investigating", "let me check") and starts a promise timer. If the agent doesn't follow through with a substantive response within the timeout (default: 10 minutes), the system triggers the triage nurse for recovery and notifies the user.

Promises auto-clear when the agent sends a real follow-up (long message >200 chars, or completion signals like "here's what I found", "done", "summary").

**New config option:**
```json
{
  "telegram": {
    "promiseTimeoutMinutes": 10
  }
}
```
Set to `0` to disable. Default: 10 minutes.

### SessionMonitor — Proactive Session Health Monitoring

A new monitoring layer that periodically checks all active sessions for health issues. Unlike StallTriageNurse (reactive — fires on unanswered messages) and SessionWatchdog (reactive — fires on stuck bash commands), the SessionMonitor is proactive. It catches dead, unresponsive, and idle sessions even when no user message triggered detection.

- Polls all active sessions every 60 seconds
- Detects three unhealthy states: dead (session stopped), unresponsive (user message unanswered >10 min), idle (no tmux output for 15+ min)
- Coordinates with StallTriageNurse for automated recovery
- 30-minute notification cooldown prevents alert spam — responsive but not overbearing

**New config section:**
```json
{
  "monitoring": {
    "sessionMonitor": {
      "enabled": true,
      "pollIntervalSec": 60,
      "idleThresholdMinutes": 15,
      "notificationCooldownMinutes": 30
    }
  }
}
```

Enabled by default when Telegram is configured. No action needed.

## What to Tell Your User

- **Promise tracking**: "If I say 'give me a minute' and then go silent, the system will now detect this and either recover me or let you know what happened. No more unexplained silences after I promise to follow up."
- **Session monitoring**: "There's now a background health monitor watching all active sessions. If a session goes idle, becomes unresponsive, or dies while you're waiting, you'll get a proactive update instead of silence."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Promise tracking | Automatic — detects "give me a minute" type messages and monitors for follow-through |
| Promise timeout config | Set `telegram.promiseTimeoutMinutes` in instar.json (default: 10, 0 to disable) |
| SessionMonitor | Automatic — polls all sessions every 60s for health issues |
| SessionMonitor config | Set `monitoring.sessionMonitor` in instar.json for poll interval, idle threshold, cooldown |
