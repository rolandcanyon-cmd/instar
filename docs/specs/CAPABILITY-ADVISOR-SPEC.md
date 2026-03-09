# Capability Advisor Spec: Intelligent Default Activation & Proactive Feature Discovery

> *A coherent agent is self-aware enough to know what it's missing.*

**Status**: Draft v2 (post-review iteration)
**Author**: Dawn + Justin
**Date**: 2026-03-09
**Review**: 11 independent reviews (8 internal specialists + 3 external models). See `.claude/skills/specreview/output/20260308-202012/synthesis.md` and `.claude/skills/crossreview/output/20260308-202136/synthesis.md`
**Related specs**: CAPABILITY-MAP-SPEC.md, SYSTEM-REVIEWER-SPEC.md, GUIDED-SETUP-SPEC.md

---

## Problem

Instar ships with powerful features that most agents never discover. Today, 7 features are disabled by default — some for good reason (they require specific infrastructure), others by historical accident (they were added conservatively and never re-evaluated). The result:

1. **Agents run degraded without knowing it.** The job scheduler is off, so jobs.json is a dead file. Memory search is off, so memory accumulates but can't be queried. The watchdog is off, so stuck sessions persist until a human notices.

2. **Users don't know what they're missing.** Config flags like `monitoring.triage.enabled` aren't discoverable through normal usage. You have to read docs, find the flag, and know what it does. This is the opposite of "convention over configuration."

3. **There's no feedback loop.** When an agent experiences a problem that a disabled feature would solve (repeated stalled sessions → StallTriageNurse), nothing connects the symptom to the remedy. The agent suffers; the feature exists; they never meet.

### Current Disabled-by-Default Features (Audit, 2026-03-09)

| # | Feature | Config Path | Default | Why Disabled | Should Be? |
|---|---------|-------------|---------|--------------|------------|
| 1 | Job Scheduler | `scheduler.enabled` | `false` | Historical conservatism | **NO — flip for fresh installs; use Advisor for upgrades** |
| 2 | Git State Tracking | `gitState.enabled` | `false` | Requires git setup | **NO — auto-enable if .git/ exists** |
| 3 | Memory Search Index | `memorySearch.enabled` | `false` | Optional dependency | **NO — core to coherence** |
| 4 | Session Watchdog | `monitoring.watchdog.enabled` | `false` | Added conservatively | **NO — flip to enabled** |
| 5 | Stall Triage Nurse | `monitoring.triage.enabled` | `false` | Uses LLM tokens | **NO — enabled with tiered privacy model** |
| 6 | Replay Protection | `replayProtection.enabled` | `false` | Multi-agent only | YES — correct |
| 7 | Multi-Machine Failover | `multiMachine.enabled` | `false` | Multi-machine only | YES — correct |

This spec addresses both sides: (A) flip defaults for features that should be on, and (B) build a capability advisor that helps agents discover the features that remain opt-in.

---

## Design Principles

### 1. Smart Defaults Over Documentation

If a feature has no downside when enabled and the infrastructure it requires is present, it should be on by default. No user should need to read docs to get basic functionality. The right experience is: install Instar, and everything that can work does work.

### 2. Conditional Activation

Some features depend on infrastructure being present. Rather than a binary on/off, use **conditional defaults**: "enabled if X exists." This follows the precedent of `gitBackup` (auto-enables when `.git/` exists) and `publishing` (auto-enables when Telegram is configured).

### 3. Graceful Degradation With Visibility

When a feature is auto-enabled but its optional dependency is missing (e.g., `better-sqlite3` for memory search), the system should log a clear message and degrade — not crash. **Critically, degraded state must be visible**: return `{results: [], degraded: true, reason: "..."}` rather than bare empty results. The caller must be able to distinguish "no results" from "search is broken." (Review finding: 3+ reviewers flagged silent degradation as a false-confidence risk.)

### 4. Symptom → Remedy Connection

The capability advisor connects observed problems to available solutions. It doesn't just say "you have disabled features." It tells the agent "your sessions keep stalling — I have more powerful diagnostics available that could help."

### 5. Quiet Until Useful

The advisor never spams. It recommends a feature once, with evidence. If the user doesn't enable it, it backs off. The goal is helpful nudges, not nagging.

### 6. The Agent Is the Interface

**Recommendations are always conversational, never CLI commands.** The agent talks to users in natural language. When the advisor detects a feature that would help, the agent says something like "I noticed your sessions keep stalling. I have more powerful recovery tools available — want me to turn them on?" The user says "yes" and the agent acts. The user never sees `instar config set` — that's the agent's internal tool, not the user's interface.

This applies everywhere: Telegram messages, dashboard UI, session interactions. The agent is the translator between technical capability and human intent.

### 7. Progressive Power Disclosure

Features that have privacy or cost implications use a tiered model. The safe tier is enabled by default; more powerful tiers are visible and available through the advisor. Each tier makes the next tier's existence known through real evidence ("I couldn't diagnose this stall with my current tools — I have deeper diagnostics available").

### 8. Consistent Config Resolution

All feature defaults use a unified resolution pattern to prevent semantic drift during implementation:

```typescript
// Pattern A: Always enabled (unless explicitly disabled)
// Used for: watchdog, session monitor, feedback
enabled: fileConfig.feature?.enabled !== false

// Pattern B: Enabled by default (can be overridden)
// Used for: scheduler, memory search, triage
enabled: fileConfig.feature?.enabled ?? true

// Pattern C: Conditional on environment
// Used for: gitState (requires .git/), publishing (requires telegram)
enabled: fileConfig.feature?.enabled ?? environmentCheck()
```

Each feature in this spec declares which pattern it uses. Implementation MUST use the declared pattern, not improvise.

---

## Part A: Default Activation Changes

### A.1 Job Scheduler — Smart Activation

**Resolution pattern**: B (enabled by default)

**Change for fresh installs**: `scheduler.enabled` defaults to `true` (was `false`). This aligns the global default in `Config.ts:265` with what `instar init` already does (`init.ts:761`).

**Change for existing installs (CRITICAL — review consensus from 8/11 reviewers)**:

The scheduler default flip is the most impactful change in this spec. Agents with populated `jobs.json` that never ran the scheduler will suddenly start executing those jobs. This is dangerous.

**Migration safety**: The PostUpdateMigrator MUST write `"scheduler": { "enabled": false }` explicitly into the config of any existing agent that does not already have an explicit `scheduler.enabled` value. This preserves the pre-upgrade behavior. The Capability Advisor then detects the pattern (Pattern 7: "You have 5 jobs defined but the scheduler is disabled") and conversationally recommends enabling it.

This approach is self-consistent: the advisor's existence makes the aggressive default flip for existing installs unnecessary.

```typescript
// Config.ts — change
enabled: fileConfig.scheduler?.enabled ?? true,  // was: ?? false

// PostUpdateMigrator — NEW for this version
if (!hasExplicitConfig('scheduler.enabled')) {
  writeExplicitConfig('scheduler.enabled', false);
  log('Scheduler default changed to enabled. Your existing config preserved as disabled.');
  log('The Capability Advisor will recommend enabling it when appropriate.');
}
```

### A.2 Session Watchdog — Always Enabled

**Resolution pattern**: A (enabled unless explicitly disabled)

**Change**: `monitoring.watchdog.enabled` defaults to `true` (was `undefined`/falsy)

**Rationale**: If you're running sessions, you want stuck command detection. The watchdog is passive — it only activates when something is actually stuck. There is no cost to having it on. The escalation path (Ctrl+C → SIGTERM → SIGKILL → session kill) is safe and graduated.

**Migration**: Existing agents that don't mention `monitoring.watchdog` in their config now get watchdog protection automatically. Agents that explicitly set `monitoring.watchdog.enabled: false` are unaffected.

```typescript
// server.ts — change
if (config.monitoring.watchdog?.enabled !== false) {  // was: if (config.monitoring.watchdog?.enabled)
```

### A.3 Git State Tracking — Enabled If .git/ Exists

**Resolution pattern**: C (conditional on environment)

**Change**: `gitState.enabled` defaults to `true` when the project directory contains a `.git/` directory.

**Rationale**: Git state tracking versions configuration and state changes. If the project is already in a git repository, the user has opted into version control. Tracking config/state changes in that same repo is a natural extension. This mirrors the existing `gitBackup` pattern.

**Edge cases**:
- `.git/` is a file (git worktree or submodule): treat as git-enabled
- `.git/` exists but is bare or corrupted: gitState initialization will fail gracefully and set `degraded: true`

```typescript
// Config.ts — change
const hasGit = fs.existsSync(path.join(resolvedProjectDir, '.git'));
const gitState = {
  enabled: fileConfig.gitState?.enabled ?? hasGit,
  ...fileConfig.gitState,
};
```

### A.4 Memory Search Index — Always Enabled

**Resolution pattern**: B (enabled by default)

**Change**: `memorySearch.enabled` defaults to `true` (was `false`)

**Rationale**: Memory search is fundamental to agent coherence. An agent that accumulates memories but can't search them is not coherent — it's just hoarding text. This is not a nice-to-have; it's core infrastructure for self-knowledge.

**Graceful degradation with visibility**: If `better-sqlite3` is not installed, the MemoryIndex should:
1. Log a clear, actionable warning: `"Memory search enabled but better-sqlite3 not installed. Running in degraded mode."`
2. Set an internal `degraded: true` flag
3. Return structured degraded results: `{ results: [], degraded: true, reason: "better-sqlite3 not installed" }` — **NOT bare empty arrays**
4. Surface the degradation in the system reviewer health check
5. The capability advisor detects this and conversationally recommends installing the dependency

```typescript
// MemoryIndex.ts — change
const DEFAULT_CONFIG: MemorySearchConfig = {
  enabled: true,  // was: false
  // ...
};

// Search return type — CHANGED
interface MemorySearchResult {
  results: MemoryEntry[];
  degraded: boolean;
  reason?: string;  // Present when degraded
}
```

### A.5 Stall Triage Nurse — Tiered Privacy Model

**Resolution pattern**: A (enabled unless explicitly disabled)

**Change**: `monitoring.triage.enabled` defaults to `true` with a tiered power model.

The triage nurse already has a layered architecture:
- Layer 1: Dead/missing session → restart immediately (NO LLM, NO external calls)
- Layer 2: Heuristic pattern matching on terminal output (NO LLM, NO external calls)
- Layer 3: Process-tree analysis of child processes (NO LLM, NO external calls)
- Layer 4: LLM-powered diagnosis (external API call — privacy-relevant)

Layers 1-3 handle ~80% of stalls without any external data transmission. Layer 4 is the most powerful but has privacy implications.

**Three tiers**:

| Tier | Config | Default | What It Does | External Calls |
|------|--------|---------|-------------|----------------|
| **Safe** | `triage.enabled: true` | YES (default) | Heuristic-only recovery (layers 1-3) | None |
| **Full Power** | `triage.llmDiagnostics: true` | No | Adds LLM diagnosis with data minimization | Yes — terminal signatures + metadata only |
| **Unrestricted** | `triage.dataMinimization: false` | No | Full terminal output + message content to LLM | Yes — full content |

**Progressive disclosure via Advisor**: When the agent is running in Safe mode and hits a stall that heuristics can't diagnose, the advisor tells the user conversationally:

> "Your session stalled and I couldn't figure out why with my basic recovery tools. I have more powerful AI-assisted diagnostics that could have caught this. Want me to turn them on?"

If the user agrees, the agent enables `llmDiagnostics`. If the user later hits a case where minimized data wasn't enough:

> "I diagnosed a stall but my confidence was low because I'm working with limited information. I can use fuller diagnostic data for maximum accuracy — want me to enable that?"

**Data minimization (when `llmDiagnostics: true`, `dataMinimization: true` — the default)**:
- Terminal output: extract signatures only (tool names, status patterns, error codes) — not raw content
- Message history: metadata only (timestamp, length, sender) — not message content
- Pending message: first 50 characters only

**Conservative defaults**:
- `cooldownMs: 1800000` (30 minutes between triage attempts)
- `stallThresholdMinutes: 10` (how long before a message is considered stalled)
- `maxTriagePerHour: 2` (cap on attempts per hour)
- Respects quota tracking — paused when quota exceeds `elevated`

```typescript
// server.ts — change
if (config.monitoring.triage?.enabled !== false && telegram) {
  const triageConfig = {
    cooldownMs: 1800000,
    stallThresholdMinutes: 10,
    maxTriagePerHour: 2,
    llmDiagnostics: false,      // Safe mode by default
    dataMinimization: true,      // Always minimize unless explicitly disabled
    ...config.monitoring.triage,
  };
}
```

### A.6 Init Template Update

Update `instar init` to include the new defaults in generated config:

```typescript
// init.ts — update config template
const config = {
  // ... existing fields ...
  scheduler: { enabled: true, maxParallelJobs: 2 },
  monitoring: {
    quotaTracking: true,
    memoryMonitoring: true,
    healthCheckIntervalMs: 30000,
    watchdog: { enabled: true },
    triage: { enabled: true },
  },
  memorySearch: { enabled: true },
  // gitState auto-detected from .git/ presence
};
```

---

## Part B: Capability Advisor

The capability advisor is a lightweight system that detects when disabled or degraded features would help, and recommends actions to the user **conversationally through the agent**.

### Core UX Principle: Agent as Interface

> **The user never sees config paths, CLI commands, or technical identifiers.** The agent is the interface.

When the advisor detects a recommendation, the agent communicates it naturally:

| BAD (CLI-oriented) | GOOD (Conversational) |
|--------------------|-----------------------|
| "Enable with: `instar config set monitoring.triage.llmDiagnostics true`" | "I have more powerful diagnostics available. Want me to turn them on?" |
| "Run `npm install better-sqlite3` for memory search" | "My memory search needs a small component to work properly. I can set that up — want me to?" |
| "Reply 'dismiss 1' to dismiss" | "Let me know if you'd like me to enable this, or I can check back later." |

The advisor generates structured `CapabilityRecommendation` objects internally. The **agent's session** (or Telegram delivery layer) translates these into natural language. The `configChange` and `enableCommand` fields exist for the agent to execute, not for the user to see.

### Architecture

The advisor lives in the **System Reviewer** (see SYSTEM-REVIEWER-SPEC.md) as a new analysis pass that runs after probes complete. This is the right home because:

1. The System Reviewer already runs every 6 hours
2. It already has access to probe results (symptom data)
3. It already has the server context (config, feature state)
4. It already has Telegram notification infrastructure
5. Adding another scheduled job would be redundant

```
SystemReviewer
├── Run probes (existing)
├── Analyze results (existing)
├── Generate recommendations (NEW — CapabilityAdvisor)
│   ├── Check disabled features against activity patterns
│   ├── Check degraded features (enabled but missing dependencies)
│   ├── Check unused features that would help based on symptoms
│   └── Generate specific, actionable recommendations
└── Report (existing, extended with recommendations)
```

### Module: CapabilityAdvisor

```typescript
interface CapabilityAdvisor {
  /**
   * Analyze current system state and generate recommendations.
   * Called by SystemReviewer after probe execution.
   */
  analyze(context: AdvisorContext): CapabilityRecommendation[];

  /**
   * Get recommendation history for dedup and lifecycle tracking.
   */
  getHistory(): RecommendationRecord[];
}

interface AdvisorContext {
  /** Current resolved config */
  config: ResolvedConfig;
  /** Latest probe results from SystemReviewer */
  probeResults: ProbeResult[];
  /** Recent session summaries — aggregates only, not full objects (scalability review) */
  recentSessionStats: {
    total: number;
    killed: number;
    failed: number;
    avgDurationMinutes: number;
    stalledCount: number;
  };
  /** Recent job execution history */
  recentJobs: JobState[];
  /** Active feature flags and their states */
  featureStates: FeatureState[];
  /** Whether better-sqlite3 is available */
  hasBetterSqlite3: boolean;
  /** Whether .git/ exists */
  hasGitRepo: boolean;
  /** Whether multi-machine config exists */
  hasMultiMachineConfig: boolean;
  /** Whether multiple agents communicate */
  hasAgentCommunication: boolean;
  /** Current quota state */
  quotaState?: QuotaState;
  /** Previous recommendations (to avoid repeating) */
  previousRecommendations: RecommendationRecord[];
}

interface FeatureState {
  feature: string;
  configPath: string;
  enabled: boolean;
  /** Explicitly set in config vs. using default */
  explicit: boolean;
  /** Feature is enabled but not fully functional */
  degraded: boolean;
  degradationReason?: string;
}

interface CapabilityRecommendation {
  /** Unique ID for dedup and dismissal tracking */
  id: string;
  /** Which feature this recommends */
  feature: string;
  /** Why this recommendation is being made (technical, for logging) */
  reason: string;
  /** What evidence triggered this recommendation (technical) */
  evidence: string[];
  /** Severity: how much this matters */
  severity: 'info' | 'suggested' | 'recommended';
  /** The config change the AGENT should make (not shown to user) */
  configChange: {
    path: string;
    value: unknown;
  };
  /** Conversational message template for the agent to deliver to the user */
  userMessage: string;
  /** Follow-up if user agrees (what the agent does) */
  onAccept: 'config-set' | 'install-dependency';
  /** Dependency to install, if applicable */
  installPackage?: string;
}

interface RecommendationRecord {
  id: string;
  firstRecommended: string;   // ISO timestamp
  lastRecommended: string;
  timesRecommended: number;
  dismissed: boolean;          // User explicitly said "no thanks"
  dismissedAt?: string;
  enabled: boolean;            // User enabled the feature
  enabledAt?: string;
}
```

### Detection Patterns

Each pattern maps an observable symptom to a conversational recommendation:

#### Pattern 1: Stalled Sessions → Stall Triage Nurse (Full Power)

**Trigger**: Agent is in Safe triage mode and 3+ sessions in the last 24h were killed or timed out, with at least one that heuristic recovery couldn't diagnose.

**User message**: "I've had trouble with 3 sessions stalling recently, and my basic recovery tools couldn't figure out what went wrong in some cases. I have more powerful AI-assisted diagnostics available — would you like me to turn those on?"

#### Pattern 2: Low-Confidence Triage → Unrestricted Mode

**Trigger**: Agent has `llmDiagnostics: true` but `dataMinimization: true`, and 2+ triage attempts had `confidence: "low"` in the last 7 days.

**User message**: "I've been diagnosing session issues but my confidence has been low because I'm working with limited diagnostic data. I can use fuller session data for more accurate recovery — would you like me to enable that?"

#### Pattern 3: Multi-Machine Config Present → Multi-Machine Failover

**Trigger**: `multiMachine.machines` is configured but `multiMachine.enabled` is `false`.

**User message**: "I see you've set up multiple machines but coordination isn't active yet. Want me to enable failover so a standby machine can take over if the primary goes silent?"

#### Pattern 4: Agent Communication → Replay Protection

**Trigger**: AgentBus has processed messages from other agents but replay protection is off.

**User message**: "I'm communicating with other agents but don't have replay protection enabled. This could leave me vulnerable to message replay attacks. Want me to turn it on?"

#### Pattern 5: Memory Search Degraded → Install better-sqlite3

**Trigger**: `memorySearch.enabled` is true but `better-sqlite3` failed to load.

**User message**: "My memory search is running in a limited mode — I can accumulate memories but can't search through them effectively. I need a small component installed to fix this. Want me to set that up?"

#### Pattern 6: Large Memory Files → Memory Search

**Trigger**: MEMORY.md exceeds 500 lines and `memorySearch.enabled` is `false` (user explicitly disabled it).

**User message**: "My memory file has grown to over 800 lines. Without search, I can only use what fits in my current context. Would you like me to re-enable memory search so I can find relevant memories on demand?"

#### Pattern 7: Jobs Defined But Scheduler Off

**Trigger**: `jobs.json` has entries but `scheduler.enabled` is `false`.

**User message**: "I have 5 scheduled jobs defined but my scheduler is turned off, so none of them are running. Would you like me to start running them?"

#### Pattern 8: Stuck Commands Detected → Session Watchdog

**Trigger**: Session monitor detected sessions that appeared stuck but watchdog is disabled (user explicitly disabled it).

**User message**: "I noticed 2 sessions appeared stuck for over 10 minutes recently. I have an automatic recovery system that can catch and fix these. Want me to enable it?"

### Recommendation Lifecycle

```
1. Advisor detects pattern → generates recommendation
2. Check recommendation history:
   a. If previously dismissed → skip (respect user's choice)
   b. If previously recommended < 7 days ago → skip (don't nag)
   c. If feature was enabled since last recommendation → skip (user acted)
3. Store recommendation in history
4. Deliver conversationally via the agent (Telegram or session)
5. User can:
   a. Agree → agent enables the feature and marks recommendation resolved
   b. Decline → recommendation is marked dismissed (won't be repeated)
   c. Ignore → will be mentioned again after cooldown, conversationally
```

### Recommendation Delivery

Recommendations are surfaced **conversationally through the agent**:

**1. Telegram (primary)** — The agent sends a natural message:

> "Hey — I've been monitoring things and noticed a couple of improvements I could make. First, my memory search needs a component to work properly. Second, I had some sessions stall recently that I couldn't recover with my basic tools — I have more powerful diagnostics available. Want me to set either of these up?"

**2. Dashboard** — Recommendations section with human-readable descriptions and "Enable" buttons (the button triggers the agent to make the change, not a raw config mutation).

**3. Session context** — When a recommendation is active and the agent starts a new session, the recommendation is available in the session context so the agent can mention it naturally during conversation.

**4. System Review Report** — Included in the review report alongside probe results (technical detail appropriate here since reports are for operators).

### Storage

Recommendation history is stored in `.instar/state/advisor-history.json`:

```json
{
  "schemaVersion": 1,
  "recommendations": [
    {
      "id": "triage-full-power",
      "feature": "Stall Triage Nurse (Full Power)",
      "firstRecommended": "2026-03-09T12:00:00Z",
      "lastRecommended": "2026-03-09T12:00:00Z",
      "timesRecommended": 1,
      "dismissed": false,
      "enabled": false
    }
  ]
}
```

**Pruning**: History is capped at 200 entries. Entries older than 90 days with `dismissed: true` or `enabled: true` are pruned on each write.

### Configuration

The advisor is part of the SystemReviewer configuration:

```typescript
interface SystemReviewerConfig {
  // ... existing fields ...

  /** Capability advisor configuration */
  advisor?: {
    /** Whether the advisor is enabled (default: true) */
    enabled?: boolean;
    /** Minimum days between repeating the same recommendation (default: 7) */
    cooldownDays?: number;
    /** Whether to send Telegram notifications for recommendations (default: true) */
    notifyTelegram?: boolean;
    /** Minimum severity to notify about (default: 'suggested') */
    minNotifySeverity?: 'info' | 'suggested' | 'recommended';
  };
}
```

---

## Part C: `instar config set` CLI (Agent's Internal Tool)

The `config set` CLI is the **agent's mechanism** for acting on recommendations. It is not a user-facing interface. The user says "yes" conversationally; the agent runs `instar config set` internally.

```bash
instar config set <path> <value>   # Set a config value
instar config get <path>           # Read a config value
instar config list                 # Show all config with defaults annotated
instar config diff                 # Show only values that differ from defaults
instar config reset <path>         # Revert to computed default
```

### Security: Schema-Validated Config Mutation (Review Critical Fix #1)

**The `config set` command validates ALL inputs against a schema before writing.**

```typescript
// commands/config.ts

/** Allowlist of mutable config paths with type constraints */
const CONFIG_SCHEMA: Record<string, ConfigFieldSpec> = {
  'scheduler.enabled': { type: 'boolean' },
  'scheduler.maxParallelJobs': { type: 'number', min: 1, max: 10 },
  'monitoring.watchdog.enabled': { type: 'boolean' },
  'monitoring.triage.enabled': { type: 'boolean' },
  'monitoring.triage.llmDiagnostics': { type: 'boolean' },
  'monitoring.triage.dataMinimization': { type: 'boolean' },
  'monitoring.triage.cooldownMs': { type: 'number', min: 60000 },
  'monitoring.triage.stallThresholdMinutes': { type: 'number', min: 1 },
  'memorySearch.enabled': { type: 'boolean' },
  'gitState.enabled': { type: 'boolean' },
  'replayProtection.enabled': { type: 'boolean' },
  'multiMachine.enabled': { type: 'boolean' },
  // ... exhaustive list of all mutable paths
};

/** Blocked paths — prevent prototype pollution */
const BLOCKED_PATTERNS = ['__proto__', 'constructor', 'prototype'];

function setConfigValue(configPath: string, dotPath: string, value: string): void {
  // 1. Block dangerous paths
  if (BLOCKED_PATTERNS.some(p => dotPath.includes(p))) {
    throw new Error(`Blocked config path: ${dotPath}`);
  }

  // 2. Validate against schema
  const spec = CONFIG_SCHEMA[dotPath];
  if (!spec) {
    throw new Error(`Unknown config path: ${dotPath}. Use 'instar config list' to see available paths.`);
  }

  // 3. Parse and validate value
  const parsed = parseAndValidate(value, spec);

  // 4. Atomic write: read → modify → write to temp → rename
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  setNestedValue(config, dotPath, parsed);

  const tempPath = configPath + '.tmp.' + process.pid;
  fs.writeFileSync(tempPath, JSON.stringify(config, null, 2));
  fs.renameSync(tempPath, configPath);  // Atomic on POSIX

  console.log(`Set ${dotPath} = ${JSON.stringify(parsed)}`);
}
```

### Config Reset

`instar config reset <path>` removes the explicit value, reverting to the computed default. This is critical for paths with conditional defaults (like `gitState.enabled` which defaults based on `.git/` presence).

### No Hot Reload in Phase 1 (Review Recommendation)

Per architecture review consensus, hot reload is **deferred to a separate design pass**. In Phase 1, `config set` writes to disk. Changes take effect on server restart. The CLI prints: "Config updated. Restart the server for changes to take effect."

This avoids:
- Race conditions between CLI writes and server reads
- Subsystem lifecycle complexity (starting/stopping heavy components at runtime)
- Unauthenticated reload endpoints

Hot reload may be added in a future spec with proper subsystem lifecycle management (`start()`/`stop()` event emitter interface), authentication, and concurrency guards.

### Atomic Writes (Review Critical Fix #5)

All config mutations use the atomic write pattern:
1. Read current config
2. Validate changes against schema
3. Write to temp file (`config.json.tmp.<pid>`)
4. Rename temp to config (`fs.renameSync` — atomic on POSIX)

This prevents corruption from concurrent writes or crashes mid-write.

### Output Formats

```bash
instar config list              # Human-readable table
instar config list --json       # Machine-readable JSON (for agent consumption)
instar config diff              # Only non-default values
instar config diff --json       # Machine-readable diff
```

---

## Integration Points

### With System Reviewer

The advisor runs as a post-probe analysis pass. Error handling ensures advisor failures never crash the SystemReviewer:

```typescript
class SystemReviewer {
  private advisor: CapabilityAdvisor;

  async review(options?: ReviewOptions): Promise<ReviewReport> {
    // 1. Run probes (existing)
    const probeResults = await this.runProbes(options);

    // 2. Run advisor analysis (NEW) — wrapped in try/catch
    let recommendations: CapabilityRecommendation[] = [];
    try {
      recommendations = this.advisor.analyze({
        config: this.ctx.config,
        probeResults,
        recentSessionStats: await this.ctx.sessionManager.getRecentSessionStats(24),
        recentJobs: this.ctx.scheduler?.getJobStates() ?? [],
        featureStates: this.getFeatureStates(),
        hasBetterSqlite3: this.ctx.memoryIndex?.isAvailable() ?? false,
        hasGitRepo: fs.existsSync(path.join(this.ctx.config.projectDir, '.git')),
        hasMultiMachineConfig: !!this.ctx.config.multiMachine?.machines?.length,
        hasAgentCommunication: this.ctx.agentBus?.hasReceivedMessages() ?? false,
        quotaState: this.ctx.quotaTracker?.getState(),
        previousRecommendations: this.advisor.getHistory(),
      });
    } catch (err) {
      console.warn('[SystemReviewer] Advisor analysis failed:', err);
      // Advisor failure is non-fatal — review continues without recommendations
    }

    // 3. Deliver new recommendations conversationally
    if (recommendations.length > 0) {
      await this.deliverRecommendations(recommendations);
    }

    // 4. Include in report
    return { ...existingReport, recommendations };
  }
}
```

### With Guided Setup (GUIDED-SETUP-SPEC.md)

The guided setup wizard already routes users through scenario-based configuration. The default changes in Part A should be reflected in the setup wizard's generated config.

The advisor (Part B) activates after initial setup, catching features that become relevant as the agent evolves (e.g., agent communication starts after setup, triggering replay protection recommendation).

### With Capability Map (CAPABILITY-MAP-SPEC.md)

The capability map tells an agent "what can I do." The capability advisor tells an agent "what should I turn on." They complement each other:

- Capability map entries include a `status` field (`active`, `disabled`, `degraded`)
- The advisor can reference the capability map when generating recommendations
- The map's `disabled` entries are candidates for advisor patterns

Note: The two features should have distinct naming to avoid user confusion (flagged by marketing review).

### With Dashboard

The dashboard should include:
- A "Recommendations" section showing active advisor recommendations in human-readable form
- Feature state indicators (enabled/disabled/degraded) for all toggleable features
- "Enable" buttons that trigger the agent to make config changes (not raw API calls)

### With Upgrade Path

When Instar upgrades and new features are added (disabled by default during the release), the advisor can detect them and recommend enabling them based on the agent's profile. This creates a progressive disclosure path: ship conservatively, let the advisor recommend activation.

---

## Implementation Plan

### Phase 1: Default Flips & Safety (Low Risk, High Impact)

- [ ] `Config.ts`: Flip `scheduler.enabled` default to `true`
- [ ] `Config.ts`: Define config resolution patterns (A, B, C) as documented constants
- [ ] PostUpdateMigrator: Write explicit `scheduler.enabled: false` for existing agents without explicit config
- [ ] `server.ts`: Flip `watchdog.enabled` to pattern A (enabled unless explicitly `false`)
- [ ] `Config.ts`: Add conditional `gitState.enabled` based on `.git/` detection (pattern C)
- [ ] `MemoryIndex.ts`: Flip default to `true`, add graceful degradation with `{degraded: true}` returns
- [ ] `server.ts`: Enable triage with tiered model (safe mode default, `llmDiagnostics` opt-in)
- [ ] `StallTriageNurse.ts`: Add data minimization layer (signatures-only mode)
- [ ] `init.ts`: Update config template with new defaults
- [ ] `setup.ts`: Update guided setup generated config
- [ ] Tests: Config resolution tests for each pattern (A, B, C)
- [ ] Tests: Graceful degradation of memory search with `degraded: true` visibility
- [ ] Tests: PostUpdateMigrator correctly preserves existing scheduler state
- [ ] Documentation: Update README, PLAYBOOK-GETTING-STARTED, changelog
- [ ] Migration guide: Document behavior change for existing agents

### Phase 2: Config CLI & Security

- [ ] `commands/config.ts`: `instar config set/get/list/diff/reset`
- [ ] Config schema allowlist with type validation and range constraints
- [ ] Prototype pollution defense (`__proto__`, `constructor`, `prototype` blocking)
- [ ] Atomic config writes (temp file + rename)
- [ ] `--json` output flag for machine-readable output
- [ ] Tests: Schema validation rejects invalid paths/types/values
- [ ] Tests: Atomic writes survive concurrent access

### Phase 3: Capability Advisor Core

- [ ] `src/monitoring/CapabilityAdvisor.ts` — Core advisor with pattern detection
- [ ] `FeatureState` detection — enumerate all toggleable features and their current state
- [ ] Detection patterns 1-8 (see Detection Patterns section)
- [ ] Recommendation storage in `.instar/state/advisor-history.json` with pruning
- [ ] Recommendation dedup, cooldown, and dismissal logic
- [ ] Integration with SystemReviewer as post-probe pass (with error isolation)
- [ ] Conversational message generation for each pattern
- [ ] Unit tests for each detection pattern
- [ ] Integration test: full advisor cycle (detect → recommend → enable → verify)

### Phase 4: Delivery & Refinement

- [ ] Telegram delivery: conversational recommendation messages
- [ ] Dashboard recommendations section with human-readable descriptions
- [ ] Session context injection for active recommendations
- [ ] Recommendation severity tuning based on real-world data
- [ ] Additional detection patterns (as new features are added)
- [ ] Analytics: track recommendation → enablement conversion
- [ ] Integration with Capability Map spec (once implemented)

---

## Success Criteria

1. **Zero-config agents get full functionality.** A fresh `instar init` project with a `.git/` repo has scheduler, watchdog, git state tracking, memory search, and triage nurse (safe mode) active without any manual config changes.

2. **No new crashes from default changes.** Graceful degradation ensures that auto-enabled features with missing dependencies return `{degraded: true}`, not stack traces.

3. **Existing agents aren't broken.** PostUpdateMigrator preserves pre-upgrade behavior for the scheduler. Explicit config values always override defaults.

4. **Recommendations are conversational.** The user never sees config paths, CLI commands, or technical identifiers. The agent translates capabilities into natural language.

5. **Progressive power disclosure works.** Users on safe triage mode encounter evidence-based recommendations to upgrade when their agent hits limits. Each tier makes the next tier visible through experience, not documentation.

6. **Advisors recommend, not nag.** Each recommendation appears at most once per 7-day period. Dismissed recommendations don't come back.

7. **Config mutations are safe.** Schema validation prevents invalid writes. Atomic writes prevent corruption. No prototype pollution vectors.

---

## Decisions

### 1. Why not auto-enable everything and just let users disable?

Some features have real costs or require specific infrastructure. Replay protection without agent communication is wasted cycles. Multi-machine without multiple machines configured is confusing. The line we drew: if the feature has no downside when its infrastructure is present, auto-enable. If it requires specific intent or infrastructure, keep opt-in but advise.

### 2. Why live in SystemReviewer and not a separate job?

Adding another 6-hour job is redundant when SystemReviewer already runs every 6 hours with all the context the advisor needs. The advisor is a 50-line analysis pass, not a new subsystem. Keeping it inside SystemReviewer means one fewer scheduled task, one fewer config block, and natural access to probe results.

### 3. Why `instar config set` instead of just editing JSON?

The agent needs a programmatic way to act on recommendations. When the user says "yes, turn that on," the agent runs `instar config set` internally. The CLI also enables atomic writes and schema validation — both impossible with manual JSON editing.

### 4. Should the advisor be able to auto-enable features?

**No.** Auto-enabling features without user consent crosses a trust boundary. The advisor recommends conversationally; the user decides; the agent acts. The only auto-enabling happens at default resolution time (Part A), where the user's intent is inferred from environment (`.git/` exists → git tracking, etc.). Runtime auto-activation without explicit consent would be surprising.

### 5. Why a tiered triage model instead of just keeping it opt-in?

Because most triage recovery (layers 1-3) requires NO external calls and NO privacy tradeoff. Keeping the entire triage nurse opt-in because layer 4 has privacy implications would deny users the benefit of layers 1-3 for no reason. The tiered model gives maximum default protection while respecting privacy for the more powerful capabilities.

### 6. Why defer hot reload?

Hot reload introduces race conditions, subsystem lifecycle management (starting/stopping components at runtime), and requires an authenticated endpoint. The security and architecture reviews both flagged this as underspecified. Shipping `config set` as cold-only (restart required) is safe, simple, and sufficient for Phase 1. Hot reload deserves its own focused design pass.

### 7. Why not auto-flip the scheduler for existing installs? (Review Consensus)

8 of 11 reviewers independently flagged this as the most dangerous change in the spec. Agents with populated `jobs.json` that never ran the scheduler will suddenly start executing dormant, possibly experimental or destructive jobs. The PostUpdateMigrator writes explicit `false` for existing agents; the Capability Advisor (Pattern 7) then recommends enabling it conversationally. This is self-consistent: the advisor's existence makes the aggressive default flip unnecessary for upgrades.

---

## Migration Notes

### For Existing Agents (Upgrading to This Version)

When an existing agent upgrades to the version containing these changes:

1. **Scheduler**: PostUpdateMigrator writes `"scheduler": { "enabled": false }` explicitly for agents without an existing scheduler config. The Advisor will recommend enabling it when it detects jobs in `jobs.json`. **No jobs will suddenly execute.**

2. **Watchdog**: Agents that didn't configure watchdog now get it. This is low-risk — watchdog is passive and only activates on stuck sessions.

3. **Git State**: Only activates if `.git/` exists. No behavior change for non-git setups.

4. **Memory Search**: Enabled by default, but degrades visibly if `better-sqlite3` is missing. Returns `{degraded: true}` — no crash, no silent failure.

5. **Triage Nurse**: Enabled in safe mode (heuristic-only, no external calls). LLM-powered diagnostics remain off until the user opts in conversationally.

### PostUpdateMigrator Integration

The PostUpdateMigrator should:
1. Detect when upgrading to this version
2. Write `scheduler.enabled: false` for agents without explicit scheduler config
3. Check if the agent has explicit config for other affected features
4. Create a one-time Telegram notification summarizing what changed

The notification is **conversational**, not technical:

> "I've been updated with some new capabilities! I now have automatic stuck-session recovery, memory search (though I need a component installed for full power), and git-based state tracking. I also noticed you have 5 scheduled jobs defined — want me to start running them on schedule?"

---

## Review History

### Round 1 (2026-03-09)

**Internal specreview**: 8 reviewers, avg 7.19/10. See `specreview/output/20260308-202012/synthesis.md`.

**External crossreview**: 3 models (GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast), avg 8.7/10. See `crossreview/output/20260308-202136/synthesis.md`.

**Critical fixes applied in v2**:
1. Config path validation with schema allowlist (6 reviewers)
2. Scheduler migration safety via PostUpdateMigrator (8/11 reviewers — unanimous)
3. Atomic config writes (4 reviewers)
4. Tiered triage privacy model replacing blanket opt-in (Privacy + Justin discussion)
5. Hot reload deferred to separate design pass (Architecture recommendation)
6. Graceful degradation returns `{degraded: true}` not bare empty (Adversarial finding)
7. Consistent config resolution patterns (GPT unique finding)
8. Conversational recommendations replacing CLI-oriented messaging (Justin direction)
9. Agent-as-interface principle throughout (Justin direction)
