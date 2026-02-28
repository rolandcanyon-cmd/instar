/**
 * AuditTrail — Tamper-evident logging for LLM merge operations.
 *
 * Logs:
 *   - Every LLM invocation (prompt hash, model, timestamp)
 *   - Resolution decisions (chosen side, confidence, file)
 *   - Validation results (post-merge checks)
 *   - Redaction events (count, types — never the values)
 *   - Security events (injection attempts, auth failures)
 *
 * Log entries are chained: each entry includes a hash of the previous
 * entry, creating a tamper-evident audit chain.
 *
 * From INTELLIGENT_SYNC_SPEC Section 5.6 and Phase 6 requirements.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ── Types ────────────────────────────────────────────────────────────

export type AuditEventType =
  | 'llm-invocation'
  | 'resolution'
  | 'validation'
  | 'redaction'
  | 'security'
  | 'handoff'
  | 'branch'
  | 'access-denied';

export interface AuditEntry {
  /** Unique entry ID. */
  id: string;
  /** Event type. */
  type: AuditEventType;
  /** ISO timestamp. */
  timestamp: string;
  /** Machine that generated this event. */
  machineId: string;
  /** User ID (if applicable). */
  userId?: string;
  /** Session ID. */
  sessionId?: string;
  /** Event-specific data. */
  data: Record<string, unknown>;
  /** SHA-256 hash of the previous entry (chain link). */
  previousHash: string;
  /** SHA-256 hash of this entry (for the next link). */
  entryHash: string;
}

export interface AuditQuery {
  /** Filter by event type. */
  type?: AuditEventType;
  /** Filter by machine. */
  machineId?: string;
  /** Filter by session. */
  sessionId?: string;
  /** Entries after this timestamp. */
  after?: string;
  /** Entries before this timestamp. */
  before?: string;
  /** Maximum entries to return. */
  limit?: number;
}

export interface AuditIntegrityResult {
  /** Whether the chain is intact. */
  intact: boolean;
  /** Total entries checked. */
  entriesChecked: number;
  /** First broken link (if any). */
  brokenAt?: number;
  /** Details about the break. */
  breakDetails?: string;
}

export interface AuditStats {
  /** Total entries. */
  totalEntries: number;
  /** Entries by type. */
  byType: Record<AuditEventType, number>;
  /** Entries by machine. */
  byMachine: Record<string, number>;
  /** Time range. */
  firstEntry?: string;
  lastEntry?: string;
}

export interface AuditTrailConfig {
  /** State directory (.instar). */
  stateDir: string;
  /** This machine's ID. */
  machineId: string;
  /** Maximum entries per file before rotation (default: 1000). */
  maxEntriesPerFile?: number;
}

// ── Constants ────────────────────────────────────────────────────────

const AUDIT_DIR = 'audit';
const CURRENT_LOG = 'current.jsonl';
const GENESIS_HASH = '0'.repeat(64);
const DEFAULT_MAX_ENTRIES = 1000;

// ── AuditTrail ───────────────────────────────────────────────────────

export class AuditTrail {
  private stateDir: string;
  private machineId: string;
  private auditDir: string;
  private maxEntries: number;
  private lastHash: string;

  constructor(config: AuditTrailConfig) {
    this.stateDir = config.stateDir;
    this.machineId = config.machineId;
    this.maxEntries = config.maxEntriesPerFile ?? DEFAULT_MAX_ENTRIES;

    this.auditDir = path.join(config.stateDir, 'state', AUDIT_DIR);
    if (!fs.existsSync(this.auditDir)) {
      fs.mkdirSync(this.auditDir, { recursive: true });
    }

    // Load the last hash from the current log
    this.lastHash = this.loadLastHash();
  }

  // ── Logging ───────────────────────────────────────────────────────

  /**
   * Log an LLM invocation event.
   */
  logLLMInvocation(data: {
    promptHash: string;
    model: string;
    conflictFile: string;
    tier: number;
    tokenEstimate?: number;
    sessionId?: string;
  }): AuditEntry {
    return this.append('llm-invocation', data, data.sessionId);
  }

  /**
   * Log a resolution decision.
   */
  logResolution(data: {
    file: string;
    chosenSide: 'ours' | 'theirs' | 'merged';
    confidence: number;
    tier: number;
    conflictRegions: number;
    sessionId?: string;
  }): AuditEntry {
    return this.append('resolution', data, data.sessionId);
  }

  /**
   * Log a validation result.
   */
  logValidation(data: {
    file: string;
    passed: boolean;
    checks: string[];
    failures?: string[];
    sessionId?: string;
  }): AuditEntry {
    return this.append('validation', data, data.sessionId);
  }

  /**
   * Log a redaction event (never log the actual values).
   */
  logRedaction(data: {
    file: string;
    totalRedactions: number;
    typeCounts: Record<string, number>;
    entropyStringsFound: number;
    sessionId?: string;
  }): AuditEntry {
    return this.append('redaction', data, data.sessionId);
  }

  /**
   * Log a security event.
   */
  logSecurity(data: {
    event: string;
    severity: 'low' | 'medium' | 'high';
    details: string;
    sourceFile?: string;
    sessionId?: string;
  }): AuditEntry {
    return this.append('security', data, data.sessionId);
  }

  /**
   * Log a handoff event.
   */
  logHandoff(data: {
    fromMachine: string;
    toMachine?: string;
    reason: string;
    workItemCount: number;
    sessionId?: string;
  }): AuditEntry {
    return this.append('handoff', data, data.sessionId);
  }

  /**
   * Log a branch event.
   */
  logBranch(data: {
    action: 'create' | 'merge' | 'abandon';
    branch: string;
    result: 'success' | 'conflict' | 'failed';
    conflictFiles?: string[];
    sessionId?: string;
  }): AuditEntry {
    return this.append('branch', data, data.sessionId);
  }

  /**
   * Log an access denied event.
   */
  logAccessDenied(data: {
    userId: string;
    permission: string;
    role: string;
    action: string;
    sessionId?: string;
  }): AuditEntry {
    return this.append('access-denied', data, data.sessionId);
  }

  // ── Querying ──────────────────────────────────────────────────────

  /**
   * Query audit entries with filters.
   */
  query(filter?: AuditQuery): AuditEntry[] {
    const entries = this.loadEntries();
    let filtered = entries;

    if (filter?.type) {
      filtered = filtered.filter(e => e.type === filter.type);
    }
    if (filter?.machineId) {
      filtered = filtered.filter(e => e.machineId === filter.machineId);
    }
    if (filter?.sessionId) {
      filtered = filtered.filter(e => e.sessionId === filter.sessionId);
    }
    if (filter?.after) {
      filtered = filtered.filter(e => e.timestamp > filter.after!);
    }
    if (filter?.before) {
      filtered = filtered.filter(e => e.timestamp < filter.before!);
    }
    if (filter?.limit) {
      filtered = filtered.slice(-filter.limit);
    }

    return filtered;
  }

  /**
   * Get audit statistics.
   */
  stats(): AuditStats {
    const entries = this.loadEntries();
    const byType = {} as Record<AuditEventType, number>;
    const byMachine = {} as Record<string, number>;

    for (const entry of entries) {
      byType[entry.type] = (byType[entry.type] ?? 0) + 1;
      byMachine[entry.machineId] = (byMachine[entry.machineId] ?? 0) + 1;
    }

    return {
      totalEntries: entries.length,
      byType,
      byMachine,
      firstEntry: entries[0]?.timestamp,
      lastEntry: entries[entries.length - 1]?.timestamp,
    };
  }

  // ── Integrity Verification ────────────────────────────────────────

  /**
   * Verify the integrity of the audit chain.
   * Checks that each entry's previousHash matches the prior entry's entryHash.
   */
  verifyIntegrity(): AuditIntegrityResult {
    const entries = this.loadEntries();
    if (entries.length === 0) {
      return { intact: true, entriesChecked: 0 };
    }

    // First entry should chain from genesis
    if (entries[0].previousHash !== GENESIS_HASH) {
      return {
        intact: false,
        entriesChecked: 1,
        brokenAt: 0,
        breakDetails: `First entry does not chain from genesis hash`,
      };
    }

    for (let i = 0; i < entries.length; i++) {
      // Verify the entry's own hash
      const computed = this.computeEntryHash(entries[i]);
      if (computed !== entries[i].entryHash) {
        return {
          intact: false,
          entriesChecked: i + 1,
          brokenAt: i,
          breakDetails: `Entry ${entries[i].id} has been tampered with (hash mismatch)`,
        };
      }

      // Verify chain link (skip first entry, already checked)
      if (i > 0 && entries[i].previousHash !== entries[i - 1].entryHash) {
        return {
          intact: false,
          entriesChecked: i + 1,
          brokenAt: i,
          breakDetails: `Chain broken at entry ${entries[i].id} — previousHash does not match prior entry`,
        };
      }
    }

    return { intact: true, entriesChecked: entries.length };
  }

  // ── Private Helpers ───────────────────────────────────────────────

  /**
   * Append an entry to the audit log.
   */
  private append(
    type: AuditEventType,
    data: Record<string, unknown>,
    sessionId?: string,
  ): AuditEntry {
    const entry: AuditEntry = {
      id: `audit_${crypto.randomBytes(8).toString('hex')}`,
      type,
      timestamp: new Date().toISOString(),
      machineId: this.machineId,
      sessionId,
      data,
      previousHash: this.lastHash,
      entryHash: '', // Computed below
    };

    entry.entryHash = this.computeEntryHash(entry);
    this.lastHash = entry.entryHash;

    // Write to current log
    const logPath = this.currentLogPath();
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');

    // Check if rotation is needed
    this.maybeRotate();

    return entry;
  }

  /**
   * Compute the SHA-256 hash of an entry (excluding the entryHash field).
   */
  private computeEntryHash(entry: AuditEntry): string {
    const hashable = {
      id: entry.id,
      type: entry.type,
      timestamp: entry.timestamp,
      machineId: entry.machineId,
      userId: entry.userId,
      sessionId: entry.sessionId,
      data: entry.data,
      previousHash: entry.previousHash,
    };
    return crypto.createHash('sha256')
      .update(JSON.stringify(hashable))
      .digest('hex');
  }

  /**
   * Load the last hash from the current log.
   */
  private loadLastHash(): string {
    const entries = this.loadEntries();
    if (entries.length === 0) return GENESIS_HASH;
    return entries[entries.length - 1].entryHash;
  }

  /**
   * Load all entries from the current log.
   */
  private loadEntries(): AuditEntry[] {
    const logPath = this.currentLogPath();
    try {
      const content = fs.readFileSync(logPath, 'utf-8');
      return content.trim().split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as AuditEntry);
    } catch {
      // @silent-fallback-ok — log file may not exist yet; empty array is the natural default
      return [];
    }
  }

  /**
   * Current log file path.
   */
  private currentLogPath(): string {
    return path.join(this.auditDir, CURRENT_LOG);
  }

  /**
   * Rotate log if it exceeds max entries.
   */
  private maybeRotate(): void {
    const entries = this.loadEntries();
    if (entries.length < this.maxEntries) return;

    // Rotate: rename current to timestamped archive
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveName = `audit-${timestamp}.jsonl`;
    const archivePath = path.join(this.auditDir, archiveName);

    try {
      fs.renameSync(this.currentLogPath(), archivePath);
    } catch {
      // Rotation failed — continue with current file
    }
  }
}
