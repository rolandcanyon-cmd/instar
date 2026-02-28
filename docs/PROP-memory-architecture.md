# PROP: Mature Memory Architecture for Instar

> **Version**: 2.0
> **Date**: 2026-02-28
> **Status**: Phase 1-2 complete (115 tests). Phase 3 revised — awaiting review.
> **Author**: Dawn (Inside-Dawn, builder instance)
> **Instar Version**: 0.9.17 (baseline)
> **Target Version**: 0.10.x

---

## Problem Statement

Instar agents accumulate knowledge across sessions but lack a coherent memory architecture. The current system is a collection of independent subsystems that don't cross-pollinate:

| System | Format | What it knows | What it can't do |
|--------|--------|---------------|------------------|
| MEMORY.md | Flat markdown | Anything the agent wrote | Scale, decay, connect, retrieve by relevance |
| TopicMemory | SQLite + JSONL | Conversation history | Connect conversations to knowledge |
| Relationships | JSON files | People and interactions | Connect people to topics or knowledge |
| CanonicalState | JSON files | Quick facts, anti-patterns | Evolve, connect, forget |
| DecisionJournal | JSONL | Past decisions | Inform future ones (no retrieval by similarity) |
| MemoryIndex | SQLite FTS5 | Text search over files | Understand meaning, only keyword match |

**The core problem**: These systems are *silos*. A learning about an API endpoint lives in MEMORY.md. The person who built that API lives in relationships/. The conversation where the agent discovered the endpoint lives in TopicMemory. The decision to use that API lives in DecisionJournal. Nothing connects them.

**Scaling problems**:
1. **MEMORY.md doesn't scale** — At 5K words it's noise, at 10K it actively hurts context
2. **No relevance-based retrieval** — Context loading is all-or-nothing (FTS5 is keyword matching, not semantic)
3. **No forgetting** — Old facts have equal weight to verified current facts
4. **No connections** — Knowledge is isolated in silos with no cross-references
5. **No confidence tracking** — A guess from 3 months ago looks identical to a verified fact from today

---

## Design Goals

1. **Scale gracefully** — 10 facts or 10,000 facts, same retrieval quality
2. **Retrieve by relevance** — "What do I know about deployment?" returns deployment knowledge, not everything
3. **Connect knowledge** — People, conversations, facts, and decisions form a web, not isolated lists
4. **Forget gracefully** — Knowledge decays unless verified; the agent stays current, not encyclopedic
5. **Migrate incrementally** — No big-bang migration; current systems continue working throughout
6. **Stay file-based** — No external database server; SQLite + JSON only (Instar's core portability promise)
7. **LLM-supervised quality** — The agent curates its own memory, not just accumulates

---

## Architecture Overview

### The Three Memory Systems

Drawing from cognitive science and Dawn's operational experience, a mature agent memory has three layers:

```
                    ┌─────────────────────────────┐
                    │     WORKING MEMORY           │
                    │  (Session context window)     │
                    │  What I'm thinking about now  │
                    └──────────────┬──────────────┘
                                   │ retrieves from
                    ┌──────────────▼──────────────┐
                    │     SEMANTIC MEMORY           │
                    │  (Structured knowledge graph)  │
                    │  Facts, entities, connections  │
                    └──────────────┬──────────────┘
                                   │ summarized from
                    ┌──────────────▼──────────────┐
                    │     EPISODIC MEMORY           │
                    │  (Session digests + raw logs)  │
                    │  What happened, what I learned │
                    └─────────────────────────────┘
```

**Episodic Memory** = What happened (sessions, conversations, events)
**Semantic Memory** = What I know (facts, entities, relationships, patterns)
**Working Memory** = What's relevant right now (session-specific context injection)

### Why Not a Full Knowledge Graph?

Knowledge graphs (Neo4j, etc.) are powerful but violate Instar's core constraint: **no external database servers**. The right level of graph-ness for Instar is:

- **Yes**: Entities with typed relationships and confidence scores
- **Yes**: Bidirectional connections between facts, people, topics
- **Yes**: Traversal queries ("what do I know about things related to X?")
- **No**: Full graph query language (Cypher, SPARQL)
- **No**: Running database server
- **No**: Schema-first rigid ontology

**The solution**: A lightweight entity-relationship store in SQLite, with a JSON export for portability and disaster recovery. Graph *concepts* without graph *infrastructure*.

---

## Detailed Design

### Phase 1: Semantic Memory Store (SQLite + JSON)

**New file**: `src/memory/SemanticMemory.ts`

#### Entity Model

```typescript
interface MemoryEntity {
  id: string;                    // UUID
  type: EntityType;              // 'fact' | 'person' | 'project' | 'tool' | 'pattern' | 'decision' | 'lesson'
  name: string;                  // Human-readable label
  content: string;               // The actual knowledge (markdown)
  confidence: number;            // 0.0 - 1.0 (how sure are we?)

  // Temporal
  createdAt: string;             // When first recorded
  lastVerified: string;          // When last confirmed true
  lastAccessed: string;          // When last retrieved for a session
  expiresAt?: string;            // Optional hard expiry (e.g., "API key rotates monthly")

  // Provenance
  source: string;                // Where this came from ('session:ABC', 'observation', 'user:Justin')
  sourceSession?: string;        // Session ID that created this

  // Classification
  tags: string[];                // Free-form tags for filtering
  domain?: string;               // Optional domain grouping ('infrastructure', 'relationships', 'business')
}

type EntityType = 'fact' | 'person' | 'project' | 'tool' | 'pattern' | 'decision' | 'lesson';
```

#### Relationship Model

```typescript
interface MemoryEdge {
  id: string;                    // UUID
  fromId: string;                // Source entity
  toId: string;                  // Target entity
  relation: RelationType;        // Type of connection
  weight: number;                // 0.0 - 1.0 (strength of connection)
  context?: string;              // Why this connection exists
  createdAt: string;
}

type RelationType =
  | 'related_to'       // Generic association
  | 'built_by'         // Person → Project/Tool
  | 'learned_from'     // Lesson → Session/Person
  | 'depends_on'       // Project → Tool/API
  | 'supersedes'       // New fact → Old fact
  | 'contradicts'      // Fact → Fact (conflict detection)
  | 'part_of'          // Component → System
  | 'used_in'          // Tool → Project
  | 'knows_about'      // Person → Topic
  | 'caused'           // Event → Consequence
  | 'verified_by';     // Fact → Session (re-verification)
```

#### SQLite Schema

```sql
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  created_at TEXT NOT NULL,
  last_verified TEXT NOT NULL,
  last_accessed TEXT NOT NULL,
  expires_at TEXT,
  source TEXT NOT NULL,
  source_session TEXT,
  domain TEXT,
  tags TEXT NOT NULL DEFAULT '[]',  -- JSON array

  -- Computed: effective_weight = confidence * recency_decay
  -- Used for retrieval ranking
);

CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  context TEXT,
  created_at TEXT NOT NULL,

  UNIQUE(from_id, to_id, relation)
);

-- Full-text search over entity content
CREATE VIRTUAL TABLE entities_fts USING fts5(
  name, content, tags,
  content=entities,
  content_rowid=rowid,
  tokenize='porter unicode61'
);

-- Index for efficient type + domain queries
CREATE INDEX idx_entities_type ON entities(type);
CREATE INDEX idx_entities_domain ON entities(domain);
CREATE INDEX idx_entities_confidence ON entities(confidence);
CREATE INDEX idx_edges_from ON edges(from_id);
CREATE INDEX idx_edges_to ON edges(to_id);
CREATE INDEX idx_edges_relation ON edges(relation);
```

#### Core Operations

```typescript
class SemanticMemory {
  // ── Create & Update ──

  /** Record a new fact, lesson, pattern, etc. */
  remember(entity: Omit<MemoryEntity, 'id' | 'createdAt' | 'lastAccessed'>): string;

  /** Connect two entities */
  connect(fromId: string, toId: string, relation: RelationType, context?: string): string;

  /** Update confidence after verification */
  verify(id: string, newConfidence?: number): void;

  /** Mark an entity as superseded by a newer one */
  supersede(oldId: string, newId: string, reason: string): void;

  // ── Retrieval ──

  /** Search by text relevance (FTS5 + confidence + recency) */
  search(query: string, options?: {
    types?: EntityType[];
    domain?: string;
    minConfidence?: number;
    limit?: number;
  }): ScoredEntity[];

  /** Get an entity and its connections (1-hop neighborhood) */
  recall(id: string): { entity: MemoryEntity; connections: ConnectedEntity[] };

  /** Find entities related to a topic (graph traversal) */
  explore(startId: string, options?: {
    maxDepth?: number;    // Default: 2
    relations?: RelationType[];
    minWeight?: number;
  }): MemoryEntity[];

  /** Get context for a session — the "working memory loader" */
  getRelevantContext(query: string, options?: {
    maxTokens?: number;   // Default: 2000
    types?: EntityType[];
  }): string;  // Formatted markdown for session injection

  // ── Maintenance ──

  /** Apply confidence decay to all entities */
  decayAll(halfLifeDays?: number): DecayReport;

  /** Find low-confidence or expired entities */
  findStale(options?: { maxConfidence?: number; olderThan?: string }): MemoryEntity[];

  /** Remove an entity and its edges */
  forget(id: string, reason: string): void;

  /** Export to JSON (for backup, git state, portability) */
  export(): { entities: MemoryEntity[]; edges: MemoryEdge[] };

  /** Import from JSON (migration, restore) */
  import(data: { entities: MemoryEntity[]; edges: MemoryEdge[] }): ImportReport;

  /** Statistics */
  stats(): SemanticMemoryStats;
}
```

#### Retrieval Scoring

The key innovation: **multi-signal ranking** that combines text relevance, confidence, and recency.

```
score = (fts5_rank * 0.4) + (confidence * 0.3) + (recency_decay * 0.2) + (access_frequency * 0.1)

where:
  fts5_rank     = BM25 text relevance score (normalized 0-1)
  confidence    = entity.confidence (0-1)
  recency_decay = exp(-0.693 * days_since_verified / half_life_days)
  access_freq   = min(1.0, access_count / 10)  // Frequently accessed = more relevant
```

This means:
- A verified fact from yesterday ranks higher than an unverified claim from last month
- A frequently-accessed entity ranks higher than a rarely-used one
- Text relevance is still the primary signal, but it's modulated by quality indicators

#### Confidence Decay

Every 24 hours (or on-demand), `decayAll()` reduces confidence:

```
new_confidence = confidence * exp(-0.693 * days_since_verified / half_life_days)
```

Default half-life: **30 days**. A fact not re-verified in 30 days drops to 50% confidence. In 60 days, 25%. In 90 days, 12.5%.

**Why this matters**: An agent that learned "the API endpoint is at /v1/users" 90 days ago and never re-verified it should treat that knowledge with appropriate skepticism. The decay doesn't delete the fact — it makes it rank lower in retrieval, so fresh verified knowledge surfaces first.

**Exemptions**: Entities with `expiresAt: null` and `type: 'lesson'` have a longer half-life (90 days). Hard-won lessons should persist longer than factual observations.

### Phase 2: Episodic Memory + Session Activity Sentinel

**New files**: `src/memory/EpisodicMemory.ts`, `src/monitoring/SessionActivitySentinel.ts`, `src/memory/ActivityPartitioner.ts`

#### The Problem with Session-End Digests

The original design assumed sessions are short, discrete units — digest them when they end. Reality is different: Telegram sessions can span hours or days, covering multiple unrelated topics. A session might never end cleanly (compaction, timeout, machine restart). And learnings from hour 1 are cold by hour 8.

**The solution**: Continuous mid-session digestion with end-of-session synthesis.

#### Two-Level Digest Architecture

```
Long-running session (hours/days)
  │
  ├─ Activity Unit 1: "Built migration engine" (45 min)
  │   └─ Mini-digest + entity extraction
  │
  ├─ Activity Unit 2: "Wrote E2E tests" (30 min)
  │   └─ Mini-digest + entity extraction
  │
  ├─ Activity Unit 3: "Discussed Phase 3 architecture" (20 min)
  │   └─ Mini-digest + entity extraction
  │
  └─ Session ends
      └─ Synthesis digest (reads all mini-digests → coherent overview)
```

#### Activity Digest (Mini-Digest)

```typescript
interface ActivityDigest {
  id: string;                      // UUID
  sessionId: string;               // Parent session
  sessionName: string;
  startedAt: string;               // When this activity unit began
  endedAt: string;                 // When it ended (next boundary)
  telegramTopicId?: number;        // Linked Telegram topic (if any)

  // What happened
  summary: string;                 // 2-3 sentence overview of this activity unit
  actions: string[];               // Key actions taken (commits, file edits, tests)

  // What was learned
  entities: string[];              // IDs of SemanticMemory entities created/updated
  learnings: string[];             // Key insights (free text)

  // What matters
  significance: number;            // 1-10
  themes: string[];                // Topic tags
  boundarySignal: BoundarySignal;  // What triggered this partition
}

type BoundarySignal =
  | 'topic_shift'       // Conversation changed direction
  | 'task_complete'     // Commit, test run, deployment
  | 'long_pause'        // 30+ min gap in activity
  | 'explicit_switch'   // User said "now let's work on..."
  | 'time_threshold'    // Max time between digests (60 min)
  | 'session_end';      // Session completed/killed
```

#### Session Synthesis (End-of-Session)

```typescript
interface SessionSynthesis {
  sessionId: string;
  sessionName: string;
  startedAt: string;
  endedAt: string;
  jobSlug?: string;
  telegramTopicId?: number;

  // Composed from mini-digests
  activityDigestIds: string[];     // References to all activity digests
  summary: string;                 // Coherent overview of the full session
  keyOutcomes: string[];           // What was accomplished

  // Aggregated from mini-digests
  allEntities: string[];           // All SemanticMemory entities created
  allLearnings: string[];          // All insights across activity units

  // Session-level assessment
  significance: number;            // 1-10
  themes: string[];                // Union of all activity themes
  followUp?: string;               // What the next session should do
}
```

#### Session Activity Sentinel

The sentinel is a monitoring process that runs inside the Instar server, watching for sessions that have accumulated unprocessed activity.

```typescript
class SessionActivitySentinel {
  /**
   * Check all running sessions for undigested activity.
   * Called periodically (every 30-60 min) by the scheduler.
   */
  async scan(): Promise<SentinelReport>;

  /**
   * Digest a specific session's recent activity.
   * Reads both session logs AND Telegram topic logs.
   */
  async digestActivity(sessionId: string): Promise<ActivityDigest[]>;

  /**
   * Synthesize all mini-digests into a session-level summary.
   * Called when a session completes.
   */
  async synthesizeSession(sessionId: string): Promise<SessionSynthesis>;
}
```

**Trigger points:**
1. **Periodic scan** (every 30-60 min): Sentinel checks running sessions, digests any with significant new activity since last digest
2. **Session completion** (`sessionComplete` event): Sentinel creates final activity digest + session synthesis
3. **On-demand** (API/CLI): Manual digest trigger for debugging or catch-up

#### Dual-Source Activity Partitioning

The ActivityPartitioner reads from two sources to build a unified activity timeline:

| Source | What it captures | Best for |
|--------|-----------------|----------|
| **Session logs** (tmux capture-pane) | Raw actions — file edits, test runs, git commits, tool output | WHAT the agent did |
| **Telegram topic logs** (JSONL) | Conversation — human instructions, agent responses, decisions, feedback | WHY the agent did it |

```typescript
class ActivityPartitioner {
  /**
   * Build a unified activity timeline from session + Telegram logs.
   * Identifies natural boundaries where activity shifts.
   */
  partition(input: {
    sessionOutput: string;           // tmux capture output
    telegramMessages?: TelegramLogEntry[];  // JSONL entries for linked topic
    lastDigestedAt?: string;         // Only process activity after this timestamp
  }): ActivityUnit[];
}

interface ActivityUnit {
  startedAt: string;
  endedAt: string;
  sessionContent: string;          // Relevant session output for this unit
  telegramContent?: string;        // Relevant Telegram messages for this unit
  boundarySignal: BoundarySignal;  // What marks the end of this unit
}
```

**Boundary detection signals (ranked by strength):**
1. **Explicit topic shift** in Telegram: "now let's work on X" / "moving on to..."
2. **Git commit** in session output: clear task completion marker
3. **Long pause** (30+ min gap): natural break in activity
4. **Telegram topic change**: messages shift to a different subject
5. **Time threshold** (60 min max): prevents unbounded activity units

For **job sessions** with no Telegram topic, the partitioner uses session logs only. For **interactive Telegram sessions**, it uses both. The Telegram logs are the richer signal for boundary detection because they contain the human's intent.

#### Storage

- Activity digests: `state/episodes/activities/{sessionId}/{digestId}.json`
- Session syntheses: `state/episodes/sessions/{sessionId}.json`
- Sentinel state: `state/episodes/sentinel-state.json` (tracks last-digested timestamps per session)

#### Retrieval

```typescript
class EpisodicMemory {
  /** Get all activity digests for a session */
  getSessionActivities(sessionId: string): ActivityDigest[];

  /** Get the session synthesis */
  getSessionSynthesis(sessionId: string): SessionSynthesis | null;

  /** Search across all digests by time range */
  getByTimeRange(start: string, end: string): ActivityDigest[];

  /** Search by theme */
  getByTheme(theme: string): ActivityDigest[];

  /** Search by significance (most important activity) */
  getBySignificance(minSignificance: number): ActivityDigest[];

  /** Get recent activity across all sessions (for working memory) */
  getRecentActivity(hours: number, limit: number): ActivityDigest[];
}
```

### Phase 3: Working Memory (Context-Aware Retrieval)

**Enhancement to**: `src/core/ContextHierarchy.ts`

The working memory layer assembles the right context for each session from all memory systems:

```typescript
interface WorkingMemoryAssembly {
  /** Identity grounding (Tier 0 — always) */
  identity: string;

  /** Relevant semantic knowledge (Tier 1 — session-specific) */
  knowledge: string;           // Top-ranked entities from SemanticMemory.search()

  /** Recent episode context (Tier 1) */
  recentEpisodes: string;      // Last 2-3 session digests

  /** Relationship context (Tier 1, if person detected) */
  relationships: string;       // Relevant relationship records

  /** Topic history (Tier 1, if topic detected) */
  topicContext: string;        // TopicMemory summary + recent messages

  /** Job-specific context (Tier 1, if job session) */
  jobContext: string;          // Handoff notes + last job state

  /** Total token estimate */
  estimatedTokens: number;
}
```

**Assembly strategy**:
1. Parse the session trigger (message, job prompt) to identify topics
2. Query SemanticMemory for relevant entities
3. Check for related people (person entities connected to topic entities)
4. Load episode digests for continuity
5. Budget tokens across sources (identity: 200, knowledge: 800, episodes: 400, relationships: 300, topic: 300)
6. Return formatted context for session-start hook injection

### Phase 4: Migration from Current Systems

**Critical constraint**: Migration is incremental. Current systems keep working throughout.

#### Step 1: SemanticMemory Ingestion (Automated)

A one-time migration job + ongoing sync:

1. **MEMORY.md → entities**: Parse headings as entities, content as knowledge. Each section becomes a `fact` or `pattern` entity. Confidence = 0.7 (not recently verified).

2. **Relationships → person entities + edges**: Each relationship becomes a `person` entity. Interaction themes become `knows_about` edges. Significance maps to confidence.

3. **CanonicalState → entities**: Quick facts become `fact` entities (confidence = 0.95). Anti-patterns become `lesson` entities. Project registry entries become `project` entities.

4. **DecisionJournal → decision entities + edges**: Each decision becomes a `decision` entity with `caused` edges to the entities it affected.

#### Step 2: Dual-Write Period

For 2-3 releases, both old and new systems receive writes:
- MEMORY.md continues to be updated (backward compatibility)
- SemanticMemory also receives the same knowledge
- MemoryIndex continues to work as before
- SemanticMemory's FTS5 provides an alternative search path

#### Step 3: Gradual Cutover

Once SemanticMemory proves reliable:
- New sessions prefer SemanticMemory for retrieval
- MEMORY.md becomes a human-readable export (still generated, no longer primary)
- MemoryIndex deprecated in favor of SemanticMemory's built-in FTS5
- Relationships continue in their own format but gain edges in SemanticMemory

#### Step 4: MEMORY.md as Generated Artifact

MEMORY.md transitions from "source of truth" to "generated snapshot":
- Periodically regenerated from SemanticMemory (top entities by confidence)
- Still loaded by session-start hooks (backward compatible with existing agents)
- Agents that haven't updated continue working as before
- Updated agents use SemanticMemory directly for retrieval

---

## Implementation Plan

### Phase 1: SemanticMemory Core (v0.10.0)
**Effort**: 2-3 sessions
**Files**:
- `src/memory/SemanticMemory.ts` — Core entity/edge store
- `tests/unit/semantic-memory.test.ts` — Entity CRUD, search, decay, export/import
- `src/server/routes.ts` — API endpoints: GET/POST /memory/semantic, /memory/semantic/search

**Deliverables**:
- Entity and edge CRUD operations
- FTS5 search with multi-signal ranking
- Confidence decay engine
- JSON export/import
- API routes for management and search

### Phase 2: Migration Engine (v0.10.1)
**Effort**: 1-2 sessions
**Files**:
- `src/memory/MemoryMigrator.ts` — Ingests MEMORY.md, relationships, canonical state
- `src/commands/memory.ts` — CLI commands: `instar memory migrate`, `instar memory stats`
- Job: `memory-migration` (one-time)

**Deliverables**:
- Automated ingestion from all existing memory sources
- Dual-write hooks in existing managers
- CLI for manual migration and inspection

### Phase 3: Episodic Memory + Session Activity Sentinel (v0.10.2)
**Effort**: 3-4 sessions
**Files**:
- `src/memory/EpisodicMemory.ts` — Activity digest + session synthesis storage and retrieval
- `src/memory/ActivityPartitioner.ts` — Dual-source activity timeline builder with boundary detection
- `src/monitoring/SessionActivitySentinel.ts` — Periodic scan of running sessions for undigested activity
- `tests/unit/episodic-memory.test.ts` — Storage, retrieval, time-range queries
- `tests/unit/activity-partitioner.test.ts` — Boundary detection, dual-source merging
- `tests/unit/session-activity-sentinel.test.ts` — Scan logic, trigger conditions
- `tests/integration/episodic-memory.test.ts` — Full HTTP pipeline for episode API routes
- `tests/e2e/episodic-memory-lifecycle.test.ts` — Production path verification (E2E standard)
- `src/server/routes.ts` — Episode API endpoints
- Enhancement to `sessionComplete` event handler — Triggers synthesis

**Deliverables**:
- Mid-session activity digestion (continuous, not just at session end)
- Dual-source partitioning (session logs + Telegram topic logs)
- Activity boundary detection (topic shifts, commits, pauses, time thresholds)
- End-of-session synthesis from accumulated mini-digests
- Entity extraction from digests into SemanticMemory
- Time-range, theme, and significance-based episode retrieval
- Sentinel job for monitoring long-running sessions

### Phase 4: Working Memory Assembly (v0.10.3)
**Effort**: 1-2 sessions
**Files**:
- Enhancement to `src/core/ContextHierarchy.ts` — Uses SemanticMemory for Tier 1/2
- Enhancement to session-start hook — Injects relevant context
- Enhancement to compaction-recovery hook — Re-injects from SemanticMemory

**Deliverables**:
- Context-aware session bootstrapping
- Token-budgeted assembly from all memory layers
- Seamless integration with existing hook system

### Phase 5: MEMORY.md Generation & Cutover (v0.10.4)
**Effort**: 1 session
**Files**:
- `src/memory/MemoryExporter.ts` — Generates MEMORY.md from SemanticMemory
- New job: `memory-export` — Periodic MEMORY.md regeneration
- Deprecation of MemoryIndex in favor of SemanticMemory search

**Deliverables**:
- MEMORY.md as generated artifact
- Backward compatibility preserved
- MemoryIndex deprecated with migration path

---

## Knowledge Graph Concepts: What We Take and What We Leave

### What We Take

| Concept | How We Use It | Why |
|---------|--------------|-----|
| **Typed entities** | EntityType enum (fact, person, project, etc.) | Different knowledge needs different handling |
| **Typed relationships** | RelationType enum (built_by, depends_on, etc.) | Enables meaningful traversal ("who built X?") |
| **Graph traversal** | `explore()` with depth limit | Find related knowledge 1-2 hops away |
| **Edge weights** | Connection strength (0-1) | Some connections are stronger than others |
| **Temporal properties** | Created, verified, accessed timestamps | Knowledge has a lifecycle |
| **Confidence scores** | Per-entity confidence with decay | Not all knowledge is equally trustworthy |

### What We Leave

| Concept | Why We Skip It | What We Do Instead |
|---------|---------------|-------------------|
| **Graph database** (Neo4j, etc.) | Violates file-based portability | SQLite with explicit edges table |
| **Query language** (Cypher, SPARQL) | Overkill for agent use cases | Typed API methods (search, recall, explore) |
| **Rigid ontology** | Agents need flexibility | Loose typing with free-form tags |
| **Full reasoning engine** | Too complex, diminishing returns | LLM handles reasoning over retrieved context |
| **Distributed graphs** | Single agent, single machine | Local SQLite with JSON export |
| **Real-time graph analytics** | Agents don't need PageRank | Simple BFS traversal with depth limits |

### The Principle

We use graph *concepts* (entities, edges, traversal, confidence) implemented in graph-*free* infrastructure (SQLite + JSON). The agent gets 80% of the value of a knowledge graph at 20% of the complexity, with zero operational burden.

---

## API Surface

### Server Endpoints

```
GET    /memory/semantic                    # Stats and overview
GET    /memory/semantic/search?q=QUERY     # FTS5 search with ranking
POST   /memory/semantic/entities           # Create entity
GET    /memory/semantic/entities/:id       # Get entity + connections
PATCH  /memory/semantic/entities/:id       # Update entity
DELETE /memory/semantic/entities/:id       # Forget entity
POST   /memory/semantic/entities/:id/verify  # Re-verify (refresh confidence)
POST   /memory/semantic/edges              # Create edge
DELETE /memory/semantic/edges/:id          # Remove edge
GET    /memory/semantic/explore/:id        # Graph traversal from entity
POST   /memory/semantic/context            # Get relevant context for a query
GET    /memory/semantic/stale              # List low-confidence entities
POST   /memory/semantic/decay              # Trigger confidence decay
POST   /memory/semantic/export             # Full JSON export
POST   /memory/semantic/import             # Full JSON import

GET    /memory/episodes                    # List session syntheses
GET    /memory/episodes/:sessionId         # Get session synthesis + activity digests
GET    /memory/episodes/activities         # List activity digests (with time/theme filters)
GET    /memory/episodes/activities/:id     # Get specific activity digest
GET    /memory/episodes/recent?hours=24    # Recent activity across all sessions
POST   /memory/episodes/digest/:sessionId  # Trigger manual digest for a running session
GET    /memory/episodes/sentinel           # Sentinel status (last scan, pending sessions)
POST   /memory/episodes/sentinel/scan      # Trigger sentinel scan on-demand
```

### CLI Commands

```bash
instar memory stats              # Overview of all memory systems
instar memory search "query"     # Search across all memory
instar memory migrate            # Run migration from existing systems
instar memory export             # Export to JSON
instar memory import FILE        # Import from JSON
instar memory decay              # Trigger confidence decay
instar memory stale              # List entities needing re-verification
instar memory episodes           # List recent session syntheses
instar memory digest SESSION_ID  # Trigger manual digest for a session
instar memory sentinel           # Show sentinel status and pending sessions
```

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| SQLite corruption | Memory loss | JSON export every 24h (backup), JSONL source of truth for messages |
| Migration data loss | Knowledge not transferred | Dual-write period, validation report after migration |
| Performance at scale | Slow session starts | Token budgets, indexed queries, lazy loading |
| Over-engineering | Complexity without value | Start with Phase 1 only; validate before proceeding |
| Backward compatibility | Existing agents break | MEMORY.md continues to work; new features are additive |
| Confidence decay too aggressive | Useful knowledge forgotten | Configurable half-life, lessons exempt from fast decay |
| Entity bloat | Too many low-quality entities | memory-hygiene guardian job prunes stale entities |
| Sentinel LLM cost | Frequent digestion burns API tokens | Haiku tier for digestion; configurable scan interval; skip sessions with minimal activity |
| tmux buffer overflow | Long sessions lose early output | Sentinel digests continuously so early activity is captured before buffer scrolls |
| Noisy activity partitioning | Too many trivial mini-digests | Minimum activity threshold (e.g., 5+ Telegram messages or 10+ min of session output) before creating a digest |
| Digest quality varies | LLM summaries may miss key insights | Entity extraction as separate step from summarization; human can review via API/CLI |
| Sentinel interferes with running session | Reading tmux output disrupts active session | Read-only capture-pane (already non-disruptive); Telegram JSONL is separate file |

---

## Success Criteria

1. **An agent with 1000+ entities can retrieve relevant context in <100ms**
2. **Session context quality improves** — sessions start with more relevant knowledge
3. **Knowledge connections discoverable** — "what do I know about X?" returns X + related entities
4. **Stale knowledge identified** — entities older than 60 days without verification are flagged
5. **MEMORY.md stays readable** — generated version is as useful as hand-written version
6. **Zero breaking changes** — existing agents continue working without modification
7. **Migration is reversible** — JSON export can restore to any point
8. **Long sessions don't lose learnings** — activity from hour 1 of a 6-hour session is captured, not forgotten
9. **Digests capture both what and why** — dual-source digests include agent actions AND human intent
10. **Sentinel overhead is negligible** — <$0.01 per digest using Haiku tier

---

## Open Questions

1. **Embedding-based retrieval**: Should we add vector embeddings for semantic search? This would require an embedding model (local or API). FTS5 keyword matching is good but misses semantic similarity. Could be a Phase 6 addition.

2. **Cross-agent memory sharing**: Should entities be shareable between agents? The JSON export/import enables this manually, but a shared registry could enable automatic knowledge sharing.

3. **Memory capacity limits**: Should there be a hard cap on entities? Or should the decay + hygiene system naturally keep the count manageable?

4. **LLM-supervised entity creation**: Should entity creation always go through an LLM for quality assessment? Or is that too expensive for high-frequency fact recording?

---

## Relationship to Guardian Network

The guardian network (implemented in commit 913b871) maintains whatever memory system exists. With SemanticMemory, the guardians evolve:

- **memory-hygiene** → Audits SemanticMemory entities instead of MEMORY.md text
- **session-continuity-check** → Verifies session digests are being created
- **degradation-digest** → Can track memory-related degradations
- **guardian-pulse** → Monitors memory migration job health

The guardians are the immune system. SemanticMemory is the nervous system. They complement, not replace, each other.

