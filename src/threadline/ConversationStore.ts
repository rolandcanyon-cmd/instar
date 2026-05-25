/**
 * ConversationStore — the single source of truth for a Threadline conversation.
 *
 * Phase 1 of the Threadline re-assessment (THREADLINE-CONVERSATION-KEYSTONE-SPEC.md).
 * Collapses the state previously smeared across `ThreadResumeMap`,
 * `ContextThreadMap`, the in-memory peer-affinity map and `inbox.jsonl` into one
 * durable record keyed by `threadId`. It is the ONLY place conversation turn
 * state lives — the one-shot reply worker provably cannot self-police a loop, so
 * the turn count + novelty hashes must live here, on the conversation.
 *
 * Concurrency: every write goes through `mutate(threadId, fn)`, a single-writer
 * surface modeled on `CommitmentTracker.mutate()` — a per-threadId FIFO queue
 * plus optimistic CAS on the record's `version`. This is the fix for the
 * convergence-flagged race where two near-simultaneous inbound messages (or a
 * live-inject racing a resume) would clobber `turnCount`/`lastOutboundHash` under
 * the legacy last-writer-wins `load→mutate→persist`.
 *
 * Storage: {stateDir}/threadline/conversations.json (server-write-only, atomic
 * tmp+rename). NOT relay-hosted — authoritative state stays local. The
 * append-only SharedStateLedger remains the audit trail; this is the live
 * mutable state it logs transitions from.
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ───────────────────────────────────────────────────────

/**
 * Conversation lifecycle state. Superset of the legacy `ThreadState`
 * (`active|idle|resolved|failed|archived`) plus `open` (created, not yet
 * worked) and `awaiting-reply` (we replied, waiting on the peer). `idle` is
 * also the warrants-a-reply gate's "suppressed, do not spawn" terminal-ish
 * state.
 */
export type ConversationState =
  | 'open'
  | 'active'
  | 'idle'
  | 'awaiting-reply'
  | 'resolved'
  | 'failed'
  | 'archived';

/**
 * The durable conversation record. EXHAUSTIVE against the legacy stores — an
 * incomplete field list silently drops live data on migration (convergence
 * finding). Every field the four legacy stores held is preserved here.
 */
export interface Conversation {
  /** Primary key — the Threadline thread id. */
  threadId: string;
  /** Monotonic version for optimistic CAS in mutate(). */
  version: number;

  /** Conversation participants — self + peer fingerprint(s). */
  participants: {
    /** This agent's name/fingerprint (best-effort). */
    self?: string;
    /** Remote peer fingerprint(s). */
    peers: string[];
  };
  /** Convenience display handle for the primary remote peer. */
  remoteAgent?: string;

  /** Lifecycle state. */
  state: ConversationState;
  /** When state became 'resolved' (grace-period clock). */
  resolvedAt?: string;

  // ── Resume primitives (from ThreadResumeEntry — dropping these breaks resume) ──
  /** The Claude/Codex session UUID the resume primitive depends on. */
  sessionUuid?: string;
  /** The live (or last-known) tmux session bound to this conversation. */
  boundSessionName?: string;
  /** Owning Telegram topic (formerly originTopicId). */
  boundTopicId?: number;
  /** Originating topic-session name at send time (fast-path resume cache). */
  originSessionName?: string;
  /** Spawn mode of the worker handling this conversation. */
  spawnMode?: 'interactive' | 'pipe';
  /** Thread subject. */
  subject?: string;

  // ── A2A context binding (from ContextThreadMap — the hijack guard) ──
  /** A2A contextId mapped to this thread, if any. */
  contextId?: string;
  /**
   * The authenticated agent identity that owns the contextId binding. Dropping
   * this reopens the session-smuggling vector ContextThreadMap defends.
   */
  agentIdentity?: string;

  // ── Bookkeeping ──
  pinned: boolean;
  messageCount: number;

  // ── Cross-machine failover (from ThreadResumeEntry) ──
  machineOrigin?: string;
  migratedTo?: string;
  migrateFrom?: string;

  // ── Turn state + novelty (the loop-gate's home — lives here, not on the worker) ──
  turnCount: number;
  lastInboundHash?: string;
  lastOutboundHash?: string;

  // ── Timestamps + trust snapshot ──
  createdAt: string;
  savedAt: string;
  lastActivityAt: string;
  /** Snapshot of the unified-trust level at last contact. */
  trustLevel?: string;
  /** Snapshot of the MoltBridge IQS band at last contact. */
  iqsBand?: string;
}

/** Mutation function: receives a draft clone, returns the next record. */
export type ConversationMutateFn = (draft: Conversation) => Conversation | Promise<Conversation>;

interface ConversationStoreFile {
  version: 1;
  conversations: Record<string, Conversation>;
  lastModified: string;
}

// ── Constants ───────────────────────────────────────────────────

/** Entries older than 7 days are pruned (non-pinned only) — matches legacy TTL. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Resolved conversations get a 7-day grace before removal — matches legacy. */
const RESOLVED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Cap before LRU eviction of non-pinned entries — matches ThreadResumeMap. */
const MAX_ENTRIES = 1000;

/** Max depth of the per-id mutate queue. Enqueue beyond this rejects. */
const MUTATE_QUEUE_MAX_DEPTH = 256;
/** Max CAS retries when the version drifts under an apply. */
const MUTATE_CAS_MAX_RETRIES = 5;

// ── Ephemeral verified-only peer-affinity (NOT persisted) ────────
//
// The legacy peer-affinity map is a SHORT (10-min sliding / 2-hr absolute),
// verified-only, deliberately ephemeral hint — promoting it to a durable,
// unverified binding would reopen a hijack vector (spec §1). We keep it in
// memory on the store so it is lost on restart by design (accepted loss).
const AFFINITY_SLIDING_MS = 10 * 60 * 1000;
const AFFINITY_ABSOLUTE_MS = 2 * 60 * 60 * 1000;

interface AffinityHint {
  threadId: string;
  firstSeen: number;
  lastSeen: number;
}

// ── Mutate queue plumbing ────────────────────────────────────────

interface MutateQueueEntry {
  fn: ConversationMutateFn;
  resolve: (c: Conversation) => void;
  reject: (e: Error) => void;
}

// ── Implementation ──────────────────────────────────────────────

export class ConversationStore {
  private filePath: string;
  private store: ConversationStoreFile;

  /** Per-threadId FIFO mutate queues — serialize concurrent writers. */
  private mutateQueues: Map<string, MutateQueueEntry[]> = new Map();
  private mutateRunning: Set<string> = new Set();

  /** Ephemeral verified-only peer-affinity hints (peerFingerprint → hint). */
  private affinity: Map<string, AffinityHint> = new Map();

  constructor(stateDir: string) {
    const threadlineDir = path.join(stateDir, 'threadline');
    fs.mkdirSync(threadlineDir, { recursive: true });
    this.filePath = path.join(threadlineDir, 'conversations.json');
    this.store = this.loadStore();
  }

  // ── Reads (synchronous, from in-memory store) ──────────────────

  /** Get a conversation by threadId. Returns null if missing or TTL-expired. */
  get(threadId: string): Conversation | null {
    const c = this.store.conversations[threadId];
    if (!c) return null;
    if (!c.pinned && this.isExpired(c)) return null;
    return c;
  }

  /** True if a (non-expired) conversation exists for the threadId. */
  has(threadId: string): boolean {
    return this.get(threadId) !== null;
  }

  /** Find conversations whose peer set includes the given fingerprint/name. */
  getByParticipant(participant: string): Conversation[] {
    const out: Conversation[] = [];
    for (const c of Object.values(this.store.conversations)) {
      if (c.pinned || !this.isExpired(c)) {
        if (c.participants.peers.includes(participant) || c.remoteAgent === participant) {
          out.push(c);
        }
      }
    }
    return out;
  }

  /** Find the conversation bound to a Telegram topic, if any. */
  getByTopicId(topicId: number): Conversation | null {
    for (const c of Object.values(this.store.conversations)) {
      if (c.boundTopicId === topicId && (c.pinned || !this.isExpired(c))) return c;
    }
    return null;
  }

  /** Reverse lookup: conversation owning an A2A contextId (identity-bound). */
  getByContextId(contextId: string, agentIdentity: string): Conversation | null {
    for (const c of Object.values(this.store.conversations)) {
      if (c.contextId === contextId && (c.pinned || !this.isExpired(c))) {
        // Identity binding — prevents session smuggling (ContextThreadMap parity).
        if (c.agentIdentity && c.agentIdentity !== agentIdentity) return null;
        return c;
      }
    }
    return null;
  }

  /** List active/idle conversations (not resolved/failed/archived). */
  listActive(): Conversation[] {
    const out: Conversation[] = [];
    for (const c of Object.values(this.store.conversations)) {
      if ((c.state === 'active' || c.state === 'idle' || c.state === 'open' || c.state === 'awaiting-reply') &&
          (c.pinned || !this.isExpired(c))) {
        out.push(c);
      }
    }
    return out;
  }

  /** Total stored conversations (for monitoring). */
  size(): number {
    return Object.keys(this.store.conversations).length;
  }

  // ── Writes (single-writer CAS) ─────────────────────────────────

  /**
   * Single-writer mutate surface. Every write path routes through here so
   * concurrent writers (the inbound funnel gate, the router resume/spawn, the
   * relay-send binding stamp) can't clobber each other.
   *
   * Contract (mirrors CommitmentTracker.mutate):
   *  - FIFO queue per threadId, max depth 256.
   *  - Optimistic CAS on `version`: read → fn(clone) → write iff version
   *    unchanged, else retry (max 5). On success version is incremented and
   *    the store is persisted atomically.
   *  - If the conversation does not exist yet, the fn receives a fresh skeleton
   *    (state 'open', version 0) so callers can upsert in one call.
   */
  async mutate(threadId: string, fn: ConversationMutateFn): Promise<Conversation> {
    return new Promise<Conversation>((resolve, reject) => {
      let queue = this.mutateQueues.get(threadId);
      if (!queue) {
        queue = [];
        this.mutateQueues.set(threadId, queue);
      }
      if (queue.length >= MUTATE_QUEUE_MAX_DEPTH) {
        reject(new Error(
          `ConversationStore.mutate: queue full for ${threadId} (depth ${queue.length} >= ${MUTATE_QUEUE_MAX_DEPTH})`,
        ));
        return;
      }
      queue.push({ fn, resolve, reject });
      void this.drainMutateQueue(threadId);
    });
  }

  private async drainMutateQueue(threadId: string): Promise<void> {
    if (this.mutateRunning.has(threadId)) return;
    this.mutateRunning.add(threadId);
    try {
      const queue = this.mutateQueues.get(threadId);
      while (queue && queue.length > 0) {
        const entry = queue.shift()!;
        try {
          const result = await this.applyMutationWithCAS(threadId, entry.fn);
          entry.resolve(result);
        } catch (err) {
          entry.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
      if (queue && queue.length === 0) this.mutateQueues.delete(threadId);
    } finally {
      this.mutateRunning.delete(threadId);
    }
  }

  private async applyMutationWithCAS(threadId: string, fn: ConversationMutateFn): Promise<Conversation> {
    let attempt = 0;
    while (attempt <= MUTATE_CAS_MAX_RETRIES) {
      const current = this.store.conversations[threadId] ?? this.skeleton(threadId);
      const observedVersion = current.version ?? 0;

      const draft: Conversation = { ...current, participants: { ...current.participants, peers: [...current.participants.peers] } };
      const next = await fn(draft);

      // CAS: the record's version must not have drifted underneath us.
      const latest = this.store.conversations[threadId];
      const latestVersion = latest?.version ?? (latest ? 0 : observedVersion);
      if (latest && latestVersion !== observedVersion) {
        attempt++;
        continue;
      }

      const committed: Conversation = {
        ...next,
        threadId,
        version: observedVersion + 1,
        savedAt: new Date().toISOString(),
      };
      this.store.conversations[threadId] = committed;
      this.pruneIfNeeded();
      this.saveStore();
      return committed;
    }
    throw new Error(
      `ConversationStore.mutate: CAS retry budget exhausted for ${threadId} after ${MUTATE_CAS_MAX_RETRIES} retries`,
    );
  }

  /**
   * Direct upsert of a full record WITHOUT going through the CAS queue. ONLY
   * for migration / bulk import where there are no concurrent writers. Runtime
   * writers MUST use mutate().
   */
  importDirect(conversation: Conversation): void {
    const existing = this.store.conversations[conversation.threadId];
    this.store.conversations[conversation.threadId] = {
      ...conversation,
      version: existing ? Math.max(existing.version ?? 0, conversation.version ?? 0) : (conversation.version ?? 0),
      savedAt: new Date().toISOString(),
    };
  }

  /** Persist after a batch of importDirect calls. */
  flush(): void {
    this.saveStore();
  }

  /** Remove a conversation. */
  remove(threadId: string): void {
    if (this.store.conversations[threadId]) {
      delete this.store.conversations[threadId];
      this.saveStore();
    }
  }

  // ── Ephemeral verified-only peer affinity (in-memory, non-durable) ──

  /**
   * Record a short-lived, verified-only affinity hint (peer → most-recent
   * thread). Deliberately NOT persisted (accepted loss on restart). Callers
   * MUST only call this for VERIFIED peers — an unverified affinity would be a
   * hijack vector.
   */
  recordAffinity(peerFingerprint: string, threadId: string): void {
    const now = Date.now();
    const existing = this.affinity.get(peerFingerprint);
    if (existing && existing.threadId === threadId) {
      existing.lastSeen = now;
    } else {
      this.affinity.set(peerFingerprint, { threadId, firstSeen: now, lastSeen: now });
    }
  }

  /** Look up a fresh affinity hint, honoring the sliding + absolute windows. */
  getAffinity(peerFingerprint: string): string | null {
    const hint = this.affinity.get(peerFingerprint);
    if (!hint) return null;
    const now = Date.now();
    if (now - hint.lastSeen > AFFINITY_SLIDING_MS || now - hint.firstSeen > AFFINITY_ABSOLUTE_MS) {
      this.affinity.delete(peerFingerprint);
      return null;
    }
    return hint.threadId;
  }

  // ── Maintenance ────────────────────────────────────────────────

  /** Prune expired + resolved-past-grace + LRU-overflow (non-pinned). */
  prune(): void {
    this.pruneMap();
    this.saveStore();
  }

  // ── Private helpers ────────────────────────────────────────────

  private skeleton(threadId: string): Conversation {
    const now = new Date().toISOString();
    return {
      threadId,
      version: 0,
      participants: { peers: [] },
      state: 'open',
      pinned: false,
      messageCount: 0,
      turnCount: 0,
      createdAt: now,
      savedAt: now,
      lastActivityAt: now,
    };
  }

  private isExpired(c: Conversation): boolean {
    const now = Date.now();
    if (c.state === 'resolved' && c.resolvedAt) {
      return now - new Date(c.resolvedAt).getTime() > RESOLVED_GRACE_MS;
    }
    const ref = c.lastActivityAt || c.savedAt;
    return now - new Date(ref).getTime() > MAX_AGE_MS;
  }

  private pruneIfNeeded(): void {
    if (Object.keys(this.store.conversations).length > MAX_ENTRIES) this.pruneMap();
  }

  private pruneMap(): void {
    const map = this.store.conversations;
    // Phase 1: drop expired / resolved-past-grace (non-pinned).
    for (const key of Object.keys(map)) {
      const c = map[key];
      if (c.pinned) continue;
      if (this.isExpired(c)) delete map[key];
    }
    // Phase 2: LRU eviction if still over cap.
    const keys = Object.keys(map);
    if (keys.length <= MAX_ENTRIES) return;
    const unpinned: Array<{ key: string; t: number }> = [];
    for (const key of keys) {
      const c = map[key];
      if (c.pinned) continue;
      unpinned.push({ key, t: new Date(c.lastActivityAt || c.savedAt).getTime() });
    }
    unpinned.sort((a, b) => a.t - b.t);
    const toEvict = keys.length - MAX_ENTRIES;
    for (let i = 0; i < toEvict && i < unpinned.length; i++) {
      delete map[unpinned[i].key];
    }
  }

  private loadStore(): ConversationStoreFile {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        if (data && data.version === 1 && data.conversations && typeof data.conversations === 'object') {
          return data as ConversationStoreFile;
        }
      }
    } catch {
      // Corrupted — start fresh.
    }
    return { version: 1, conversations: {}, lastModified: new Date().toISOString() };
  }

  private saveStore(): void {
    this.store.lastModified = new Date().toISOString();
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.store, null, 2) + '\n');
      fs.renameSync(tmpPath, this.filePath);
    } catch {
      // @silent-fallback-ok — state persistence failure, retried on next write.
    }
  }
}
