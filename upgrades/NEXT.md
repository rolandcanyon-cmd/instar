# Upgrade Guide: Promise Tracking & SessionMonitor

## What changed

### Promise Tracking (TelegramAdapter)
When an agent sends a "work-in-progress" message like "give me a couple minutes" and then goes silent, the system now detects this and takes action. Previously, the agent's response would clear stall tracking, leaving a gap where the agent could go silent indefinitely without detection.

**New config option:**
```json
{
  "telegram": {
    "promiseTimeoutMinutes": 10
  }
}
```
Set to `0` to disable. Default: 10 minutes.

### SessionMonitor (new proactive health monitor)
A new monitoring layer that periodically checks all active sessions for health issues. Unlike StallTriageNurse (reactive — fires on unanswered messages), the SessionMonitor is proactive — it catches idle, unresponsive, and dead sessions even when no user message triggered detection.

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

## Migration
No breaking changes. Both features activate automatically with sensible defaults.
