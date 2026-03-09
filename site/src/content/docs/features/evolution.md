---
title: Evolution System
description: Four subsystems for structured agent growth.
---

Self-evolution isn't just "the agent can edit files." It's a structured system with four subsystems that turn running into growing.

## Evolution Queue

Staged self-improvement proposals. The agent identifies something that could be better, proposes a change, and a review job evaluates and implements it.

Not impulsive self-modification -- deliberate, staged improvement with a paper trail.

```bash
# List proposals
curl localhost:4040/evolution/proposals

# Create a proposal
curl -X POST localhost:4040/evolution/proposals \
  -H 'Content-Type: application/json' \
  -d '{"title": "Add email digest job", "description": "...", "type": "feature"}'
```

## Learning Registry

Structured, searchable insights. When the agent discovers a pattern, solves a tricky problem, or learns a user preference, it records it.

Future sessions can query these learnings. An insight-harvest job synthesizes patterns across learnings into evolution proposals.

```bash
curl localhost:4040/evolution/learnings
```

## Capability Gap Tracker

The agent tracks what it's missing. When it can't fulfill a request, encounters a limitation, or notices a workflow gap, it records the gap with severity and a proposed solution.

This is the difference between "I can't do that" and "I can't do that *yet*, and here's what I need."

```bash
curl localhost:4040/evolution/gaps
```

## Action Queue

Commitment tracking with stale detection. When the agent promises to follow up, creates a TODO, or identifies work that needs doing, it gets tracked. A commitment-check job surfaces overdue items.

```bash
curl localhost:4040/evolution/actions
curl localhost:4040/evolution/actions/overdue
```

## Serendipity Integration

The [Serendipity Protocol](/features/serendipity/) feeds directly into evolution. When sub-agents capture findings during focused tasks, the `/triage-findings` skill reviews them and promotes actionable ones to evolution proposals. This means every task — even a narrow sub-agent task — can contribute to the agent's growth.

Serendipity findings are triaged with the same approve/dismiss/defer model as evolution proposals, but carry additional metadata: the discovering session, agent type, and optionally a code patch.

## Built-in Skills

| Skill | Purpose |
|-------|---------|
| `/evolve` | Submit an evolution proposal |
| `/learn` | Record a learning |
| `/gaps` | Report a capability gap |
| `/commit-action` | Track a commitment |
| `/triage-findings` | Review and route serendipity findings |

## Default Jobs

Three jobs drive the evolution cycle automatically:

| Job | Schedule | Purpose |
|-----|----------|---------|
| evolution-review | Every 6h | Review proposals, implement approved ones |
| insight-harvest | Every 8h | Synthesize learnings into proposals |
| commitment-check | Every 4h | Surface overdue action items |

## Post-Action Reflection

A behavioral hook nudges the agent to pause after significant actions (commits, deploys) and consider what it learned. This feeds the learning registry and keeps evolution grounded in experience.

## All State Is File-Based

Everything lives in `.instar/state/evolution/` as JSON files. No database, no external dependencies. The agent can read and modify its own evolution state.
