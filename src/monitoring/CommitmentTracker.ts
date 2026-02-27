/**
 * Commitment Tracker — durable promise enforcement for agent infrastructure.
 *
 * When a user asks an agent to change something, the agent says "done" — but
 * often the change doesn't stick. Sessions compact, configs revert, behavioral
 * promises get forgotten. This module closes that gap.
 *
 * Three commitment types:
 *   1. config-change  — enforced by code (auto-corrects config drift)
 *   2. behavioral     — injected into every session via hooks
 *   3. one-time-action — tracked until verified, then closed
 *
 * The CommitmentTracker runs as a server-side monitor. It does NOT depend on
 * the LLM following instructions — it enforces commitments independently.
 *
 * Lifecycle:
 *   record → verify → (auto-correct if needed) → monitor → resolve
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LiveConfig } from '../config/LiveConfig.js';
import type { ComponentHealth } from '../core/types.js';

// ── Types ─────────────────────────────────────────────────────────

export type CommitmentType = 'config-change' | 'behavioral' | 'one-time-action';
export type CommitmentStatus = 'pending' | 'verified' | 'violated' | 'expired' | 'withdrawn';

export interface Commitment {
  /** Unique identifier (CMT-xxx) */
  id: string;
  /** What the user asked for, in their words */
  userRequest: string;
  /** What the agent committed to */
  agentResponse: string;
  /** Commitment type determines verification strategy */
  type: CommitmentType;
  /** Current status */
  status: CommitmentStatus;
  /** When the commitment was made */
  createdAt: string;
  /** When the commitment was last verified */
  lastVerifiedAt?: string;
  /** When the commitment was fulfilled or violated */
  resolvedAt?: string;
  /** Resolution details */
  resolution?: string;
  /** Number of consecutive successful verifications */
  verificationCount: number;
  /** Number of violations detected */
  violationCount: number;
  /** Telegram topic ID where the commitment was made */
  topicId?: number;
  /** Source: 'agent' (self-registered) or 'sentinel' (detected by LLM scanner) */
  source?: 'agent' | 'sentinel' | 'manual';

  // ── Type-specific fields ────────────────────────────────

  /** For config-change: the config path and expected value */
  configPath?: string;
  configExpectedValue?: unknown;

  /** For behavioral: the rule text injected into sessions */
  behavioralRule?: string;
  /** For behavioral/one-time: when this commitment expires (null = forever) */
  expiresAt?: string;

  /** For one-time-action: verification method */
  verificationMethod?: 'config-value' | 'file-exists' | 'manual';
  /** For one-time-action with file-exists: the path to check */
  verificationPath?: string;
}

export interface CommitmentStore {
  version: 1;
  commitments: Commitment[];
  lastModified: string;
}

export interface CommitmentVerificationReport {
  timestamp: string;
  active: number;
  verified: number;
  violated: number;
  pending: number;
  violations: Array<{
    id: string;
    userRequest: string;
    detail: string;
    autoCorrected: boolean;
  }>;
}

export interface CommitmentTrackerConfig {
  stateDir: string;
  liveConfig: LiveConfig;
  /** Check interval in ms. Default: 60_000 (1 minute) */
  checkIntervalMs?: number;
  /** Callback when a violation is detected */
  onViolation?: (commitment: Commitment, detail: string) => void;
  /** Callback when a commitment is verified for the first time */
  onVerified?: (commitment: Commitment) => void;
}

// ── Implementation ────────────────────────────────────────────────

export class CommitmentTracker extends EventEmitter {
  private config: CommitmentTrackerConfig;
  private store: CommitmentStore;
  private storePath: string;
  private rulesPath: string;
  private interval: ReturnType<typeof setInterval> | null = null;
  private nextId: number;

  constructor(config: CommitmentTrackerConfig) {
    super();
    this.config = config;
    this.storePath = path.join(config.stateDir, 'state', 'commitments.json');
    this.rulesPath = path.join(config.stateDir, 'state', 'commitment-rules.md');
    this.store = this.loadStore();
    this.nextId = this.computeNextId();
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  start(): void {
    if (this.interval) return;

    const intervalMs = this.config.checkIntervalMs ?? 60_000;

    // First verification after a short delay
    setTimeout(() => this.verify(), 15_000);

    this.interval = setInterval(() => this.verify(), intervalMs);
    this.interval.unref();

    const active = this.getActive().length;
    if (active > 0) {
      console.log(`[CommitmentTracker] Started (every ${Math.round(intervalMs / 1000)}s, ${active} active commitment(s))`);
    } else {
      console.log(`[CommitmentTracker] Started (every ${Math.round(intervalMs / 1000)}s, no active commitments)`);
    }
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // ── Commitment CRUD ────────────────────────────────────────────

  /**
   * Record a new commitment. Returns the created commitment.
   */
  record(input: {
    userRequest: string;
    agentResponse: string;
    type: CommitmentType;
    topicId?: number;
    source?: 'agent' | 'sentinel' | 'manual';
    configPath?: string;
    configExpectedValue?: unknown;
    behavioralRule?: string;
    expiresAt?: string;
    verificationMethod?: 'config-value' | 'file-exists' | 'manual';
    verificationPath?: string;
  }): Commitment {
    const id = `CMT-${String(this.nextId++).padStart(3, '0')}`;

    const commitment: Commitment = {
      id,
      userRequest: input.userRequest,
      agentResponse: input.agentResponse,
      type: input.type,
      status: 'pending',
      createdAt: new Date().toISOString(),
      verificationCount: 0,
      violationCount: 0,
      topicId: input.topicId,
      source: input.source ?? 'agent',
      configPath: input.configPath,
      configExpectedValue: input.configExpectedValue,
      behavioralRule: input.behavioralRule,
      expiresAt: input.expiresAt,
      verificationMethod: input.verificationMethod,
      verificationPath: input.verificationPath,
    };

    this.store.commitments.push(commitment);
    this.saveStore();

    // Regenerate behavioral rules file if this is a behavioral commitment
    if (input.type === 'behavioral') {
      this.writeBehavioralRules();
    }

    console.log(`[CommitmentTracker] Recorded ${id}: "${input.userRequest}" (${input.type})`);
    this.emit('recorded', commitment);

    // Run immediate verification for config-change commitments
    if (input.type === 'config-change') {
      this.verifyOne(id);
    }

    return commitment;
  }

  /**
   * Withdraw a commitment (user changed their mind).
   */
  withdraw(id: string, reason: string): boolean {
    const commitment = this.store.commitments.find(c => c.id === id);
    if (!commitment || commitment.status === 'withdrawn' || commitment.status === 'expired') {
      return false;
    }

    commitment.status = 'withdrawn';
    commitment.resolvedAt = new Date().toISOString();
    commitment.resolution = reason;
    this.saveStore();

    if (commitment.type === 'behavioral') {
      this.writeBehavioralRules();
    }

    console.log(`[CommitmentTracker] Withdrawn ${id}: ${reason}`);
    this.emit('withdrawn', commitment);
    return true;
  }

  /**
   * Get all active commitments (pending or verified, not expired).
   */
  getActive(): Commitment[] {
    const now = new Date().toISOString();
    return this.store.commitments.filter(c => {
      if (c.status === 'withdrawn' || c.status === 'expired') return false;
      if (c.expiresAt && c.expiresAt < now) return false;
      // Active = pending, verified, or violated (violated is still "active" — it needs attention)
      return c.status === 'pending' || c.status === 'verified' || c.status === 'violated';
    });
  }

  /**
   * Get all commitments (including resolved).
   */
  getAll(): Commitment[] {
    return [...this.store.commitments];
  }

  /**
   * Get a single commitment by ID.
   */
  get(id: string): Commitment | null {
    return this.store.commitments.find(c => c.id === id) ?? null;
  }

  // ── Verification ───────────────────────────────────────────────

  /**
   * Run verification on all active commitments.
   */
  verify(): CommitmentVerificationReport {
    const active = this.getActive();
    const violations: CommitmentVerificationReport['violations'] = [];
    let verified = 0;
    let pending = 0;

    // Expire old commitments first
    this.expireCommitments();

    for (const commitment of active) {
      const result = this.verifyOne(commitment.id);
      if (!result) continue;

      if (result.passed) {
        verified++;
      } else {
        // Attempt auto-correction for config-change commitments
        let autoCorrected = false;
        if (commitment.type === 'config-change' && commitment.configPath !== undefined) {
          autoCorrected = this.attemptAutoCorrection(commitment);
        }

        violations.push({
          id: commitment.id,
          userRequest: commitment.userRequest,
          detail: result.detail,
          autoCorrected,
        });
      }
    }

    pending = active.filter(c => c.status === 'pending').length;

    const report: CommitmentVerificationReport = {
      timestamp: new Date().toISOString(),
      active: active.length,
      verified,
      violated: violations.length,
      pending,
      violations,
    };

    this.emit('verification', report);
    return report;
  }

  /**
   * Verify a single commitment. Returns null if commitment not found or not active.
   */
  verifyOne(id: string): { passed: boolean; detail: string } | null {
    const commitment = this.store.commitments.find(c => c.id === id);
    if (!commitment) return null;
    if (commitment.status === 'withdrawn' || commitment.status === 'expired') return null;

    let result: { passed: boolean; detail: string };

    switch (commitment.type) {
      case 'config-change':
        result = this.verifyConfigChange(commitment);
        break;
      case 'behavioral':
        result = this.verifyBehavioral(commitment);
        break;
      case 'one-time-action':
        result = this.verifyOneTimeAction(commitment);
        break;
      default:
        result = { passed: false, detail: `Unknown commitment type: ${commitment.type}` };
    }

    // Update commitment status based on result
    if (result.passed) {
      const wasFirstVerification = commitment.status === 'pending';
      const wasViolated = commitment.status === 'violated';

      commitment.status = 'verified';
      commitment.lastVerifiedAt = new Date().toISOString();
      commitment.verificationCount++;

      if (wasFirstVerification && this.config.onVerified) {
        this.config.onVerified(commitment);
      }

      if (wasViolated) {
        console.log(`[CommitmentTracker] ${id} recovered: "${commitment.userRequest}"`);
      }

      // Close one-time actions after first verification
      if (commitment.type === 'one-time-action') {
        commitment.resolvedAt = new Date().toISOString();
        commitment.resolution = 'Verified complete';
      }
    } else {
      const wasVerified = commitment.status === 'verified';
      commitment.status = 'violated';
      commitment.violationCount++;

      if (wasVerified) {
        // Regression — was verified, now violated
        console.warn(`[CommitmentTracker] VIOLATION ${id}: "${commitment.userRequest}" — ${result.detail}`);
        if (this.config.onViolation) {
          this.config.onViolation(commitment, result.detail);
        }
      }
    }

    this.saveStore();
    return result;
  }

  // ── Session Awareness ──────────────────────────────────────────

  /**
   * Get behavioral commitments formatted for session injection.
   * This is what hooks read and inject into new sessions.
   */
  getBehavioralContext(): string {
    const behavioral = this.getActive().filter(c =>
      c.type === 'behavioral' || c.type === 'config-change'
    );

    if (behavioral.length === 0) return '';

    const lines = [
      '# Active Commitments (user-requested rules)',
      '',
      'These rules were explicitly requested by the user. They override defaults.',
      '',
    ];

    for (const c of behavioral) {
      const since = c.createdAt.split('T')[0];
      const expires = c.expiresAt ? ` (expires ${c.expiresAt.split('T')[0]})` : '';

      if (c.type === 'behavioral' && c.behavioralRule) {
        lines.push(`- [${c.id}] ${c.behavioralRule}${expires} (Since ${since})`);
      } else if (c.type === 'config-change' && c.configPath) {
        lines.push(`- [${c.id}] Config: ${c.configPath} must be ${JSON.stringify(c.configExpectedValue)}. User request: "${c.userRequest}"${expires} (Since ${since})`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Get ComponentHealth for integration with HealthChecker.
   */
  getHealth(): ComponentHealth {
    const active = this.getActive();
    const violated = active.filter(c => c.status === 'violated');

    if (active.length === 0) {
      return { status: 'healthy', message: 'No active commitments', lastCheck: new Date().toISOString() };
    }

    if (violated.length > 0) {
      return {
        status: 'degraded',
        message: `${violated.length} violated commitment(s): ${violated.map(c => c.id).join(', ')}`,
        lastCheck: new Date().toISOString(),
      };
    }

    return {
      status: 'healthy',
      message: `${active.length} commitment(s) tracked, all verified`,
      lastCheck: new Date().toISOString(),
    };
  }

  // ── Type-specific Verification ─────────────────────────────────

  private verifyConfigChange(commitment: Commitment): { passed: boolean; detail: string } {
    if (!commitment.configPath) {
      return { passed: false, detail: 'Missing configPath on config-change commitment' };
    }

    const currentValue = this.config.liveConfig.get(commitment.configPath, undefined);
    const matches = this.deepEqual(currentValue, commitment.configExpectedValue);

    return {
      passed: matches,
      detail: matches
        ? `Config ${commitment.configPath} = ${JSON.stringify(currentValue)} (matches)`
        : `Config ${commitment.configPath} = ${JSON.stringify(currentValue)}, expected ${JSON.stringify(commitment.configExpectedValue)}`,
    };
  }

  private verifyBehavioral(commitment: Commitment): { passed: boolean; detail: string } {
    // Behavioral commitments are "verified" if the rule text exists in the rules file
    if (!commitment.behavioralRule) {
      return { passed: false, detail: 'Missing behavioralRule on behavioral commitment' };
    }

    try {
      if (!fs.existsSync(this.rulesPath)) {
        this.writeBehavioralRules();
      }
      const content = fs.readFileSync(this.rulesPath, 'utf-8');
      const hasRule = content.includes(commitment.id);
      return {
        passed: hasRule,
        detail: hasRule ? 'Behavioral rule present in injection file' : 'Behavioral rule missing from injection file — regenerating',
      };
    } catch {
      return { passed: false, detail: 'Failed to read behavioral rules file' };
    }
  }

  private verifyOneTimeAction(commitment: Commitment): { passed: boolean; detail: string } {
    switch (commitment.verificationMethod) {
      case 'config-value':
        return this.verifyConfigChange(commitment);

      case 'file-exists':
        if (!commitment.verificationPath) {
          return { passed: false, detail: 'Missing verificationPath for file-exists check' };
        }
        const exists = fs.existsSync(commitment.verificationPath);
        return {
          passed: exists,
          detail: exists ? `File exists: ${commitment.verificationPath}` : `File missing: ${commitment.verificationPath}`,
        };

      case 'manual':
        // Manual commitments stay pending until explicitly resolved
        return { passed: false, detail: 'Awaiting manual verification' };

      default:
        return { passed: false, detail: `Unknown verification method: ${commitment.verificationMethod}` };
    }
  }

  // ── Auto-correction ────────────────────────────────────────────

  private attemptAutoCorrection(commitment: Commitment): boolean {
    if (!commitment.configPath || commitment.configExpectedValue === undefined) return false;

    try {
      this.config.liveConfig.set(commitment.configPath, commitment.configExpectedValue);

      // Re-verify after correction
      const recheck = this.verifyConfigChange(commitment);
      if (recheck.passed) {
        commitment.status = 'verified';
        commitment.lastVerifiedAt = new Date().toISOString();
        commitment.verificationCount++;
        this.saveStore();
        console.log(`[CommitmentTracker] Auto-corrected ${commitment.id}: ${commitment.configPath} → ${JSON.stringify(commitment.configExpectedValue)}`);
        this.emit('corrected', commitment);
        return true;
      }
    } catch (err) {
      console.error(`[CommitmentTracker] Auto-correction failed for ${commitment.id}:`, err);
    }

    return false;
  }

  // ── Behavioral Rules File ──────────────────────────────────────

  /**
   * Write the commitment-rules.md file for hook injection.
   */
  private writeBehavioralRules(): void {
    const content = this.getBehavioralContext();
    try {
      const dir = path.dirname(this.rulesPath);
      fs.mkdirSync(dir, { recursive: true });

      if (content) {
        const tmpPath = `${this.rulesPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, content + '\n');
        fs.renameSync(tmpPath, this.rulesPath);
      } else {
        // No active commitments — remove the file so hooks skip injection
        if (fs.existsSync(this.rulesPath)) {
          fs.unlinkSync(this.rulesPath);
        }
      }
    } catch {
      // @silent-fallback-ok — rules file is nice-to-have, monitor catches violations anyway
    }
  }

  // ── Expiration ─────────────────────────────────────────────────

  private expireCommitments(): void {
    const now = new Date().toISOString();
    let changed = false;

    for (const c of this.store.commitments) {
      if (c.expiresAt && c.expiresAt < now && c.status !== 'expired' && c.status !== 'withdrawn') {
        c.status = 'expired';
        c.resolvedAt = now;
        c.resolution = 'Expired';
        changed = true;
        console.log(`[CommitmentTracker] Expired ${c.id}: "${c.userRequest}"`);
      }
    }

    if (changed) {
      this.saveStore();
      this.writeBehavioralRules();
    }
  }

  // ── Persistence ────────────────────────────────────────────────

  private loadStore(): CommitmentStore {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        if (data.version === 1 && Array.isArray(data.commitments)) {
          return data as CommitmentStore;
        }
      }
    } catch {
      // Start fresh on corruption
    }
    return { version: 1, commitments: [], lastModified: new Date().toISOString() };
  }

  private saveStore(): void {
    this.store.lastModified = new Date().toISOString();
    try {
      const dir = path.dirname(this.storePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.storePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.store, null, 2) + '\n');
      fs.renameSync(tmpPath, this.storePath);
    } catch {
      // @silent-fallback-ok — state persistence failure, will retry next cycle
    }
  }

  private computeNextId(): number {
    if (this.store.commitments.length === 0) return 1;
    const maxId = Math.max(...this.store.commitments.map(c => {
      const match = c.id.match(/CMT-(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    }));
    return maxId + 1;
  }

  // ── Utility ────────────────────────────────────────────────────

  private deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;

    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);

    for (const key of keys) {
      if (!this.deepEqual(aObj[key], bObj[key])) return false;
    }

    return true;
  }
}
