# Example: Scheduled Job

A minimal Instar agent that runs a scheduled job on a cron schedule.

## Files

### `AGENT.md`

```markdown
# Daily Reporter

I am a daily reporter agent. I summarize activity and report findings.

## Core Behavior
- Run scheduled jobs reliably
- Produce clear, concise summaries
- Log results for review
```

### `jobs.json`

```json
[
  {
    "slug": "daily-summary",
    "name": "Daily Summary",
    "description": "Summarize yesterday's activity",
    "schedule": "0 9 * * *",
    "priority": "normal",
    "prompt": "Review the project directory and summarize what changed in the last 24 hours. Write a brief summary to data/summaries/ with today's date as the filename."
  }
]
```

## Setup

1. Create a project directory and add `AGENT.md` and `jobs.json` as shown above
2. Run `instar server start`
3. The job runs daily at 9:00 AM

## Key Concepts

- **`schedule`** uses standard cron syntax (`minute hour day month weekday`)
- **`priority`** can be `low`, `normal`, `high`, or `critical` — higher priority jobs run first when multiple are queued
- **`prompt`** is what gets sent to Claude Code when the job fires

## Customization Ideas

- Change the schedule to run hourly: `"0 * * * *"`
- Add a second job for weekly reviews
- Use `"model": "sonnet"` for cost-efficient recurring jobs

> **Full docs:** [Scheduler](https://instar.sh/features/scheduler/) · [Configuration](https://instar.sh/reference/configuration/)
