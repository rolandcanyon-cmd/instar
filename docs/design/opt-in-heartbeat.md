# Opt-In Heartbeat — Design Spec (v0.14)

## Overview

A privacy-first, opt-in telemetry system that lets Instar agents send anonymous usage heartbeats. Default OFF. No PII. No conversation content. Agent owners explicitly enable it.

## What Gets Sent

```json
{
  "v": 1,
  "id": "sha256(machineId + installDir)",
  "ts": "2026-03-10T05:00:00Z",
  "instar": "0.14.0",
  "node": "22.x",
  "os": "darwin-arm64",
  "agents": 2,
  "uptime_hours": 168,
  "jobs_run_24h": 12,
  "sessions_spawned_24h": 8,
  "skills_invoked_24h": 45
}
```

### What is NOT sent
- Agent names, prompts, or configuration
- Conversation content or memory data
- File paths, environment variables, or secrets
- IP addresses (not logged server-side)
- Any data when telemetry is disabled (default)

## Configuration

```json
// .instar/config.json
{
  "telemetry": {
    "enabled": false,
    "level": "basic"
  }
}
```

Levels:
- `"basic"` — version, OS, agent count, uptime only
- `"usage"` — basic + jobs run, sessions spawned, skills invoked (aggregate counts only)

## Opt-In Flow

On first run of v0.14+, if telemetry config is absent:
```
Instar can send anonymous usage stats to help improve the project.
No conversation content, agent names, or personal data is ever sent.
See https://instar.sh/telemetry for full details.

Enable anonymous telemetry? [y/N]:
```

Default is No. User can also set via:
```bash
instar config set telemetry.enabled true
instar config set telemetry.level usage
```

## Collection Endpoint

- `POST https://telemetry.instar.sh/v1/heartbeat`
- No authentication required
- No cookies or tracking
- Response: `204 No Content`
- Timeout: 3 seconds (fire-and-forget, never blocks agent operation)

## Server-Side

Simple collection service:
- Append-only JSONL storage
- No IP logging (reverse proxy strips before app)
- Daily aggregation job produces anonymous statistics
- Public dashboard at `https://instar.sh/stats` showing aggregate trends

## Implementation Plan

1. Add `TelemetryConfig` to config schema
2. Add `TelemetryCollector` class in `src/monitoring/TelemetryCollector.ts`
   - Follows existing `RelayMetrics` pattern
   - Collects counters from JobScheduler, SessionManager
   - Periodic flush (every 6 hours when enabled)
3. Add opt-in prompt to CLI first-run flow
4. Add `instar config set/get` subcommands for telemetry
5. Deploy collection endpoint (Cloudflare Worker or simple Express)
6. Build public stats dashboard

## Privacy Guarantees

- **Hashed installation ID**: Cannot be reversed to identify a machine
- **No IP logging**: Stripped at reverse proxy layer
- **Aggregate only**: Individual heartbeats are never exposed publicly
- **Deletion**: `instar config set telemetry.enabled false` stops all collection immediately
- **Open source**: Collection endpoint code is public and auditable
- **Offline-first**: Telemetry failure never affects agent operation
