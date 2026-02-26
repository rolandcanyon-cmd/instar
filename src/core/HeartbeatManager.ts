/**
 * Heartbeat manager for distributed coordination.
 *
 * Handles:
 * - Awake machine broadcasts heartbeat every 2 minutes
 * - Standby machines monitor heartbeat and auto-failover
 * - Split-brain detection via cross-heartbeat processing
 * - Graceful handoff coordination
 * - Failover hardening (cooldown, max attempts, optional confirmation)
 *
 * Phase 5 of the multi-machine spec.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { MachineRole } from './types.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

// ── Constants ────────────────────────────────────────────────────────

const HEARTBEAT_FILE = 'heartbeat.json';
const HEARTBEAT_INTERVAL_MS = 2 * 60_000; // 2 minutes
const DEFAULT_FAILOVER_TIMEOUT_MS = 15 * 60_000; // 15 minutes
const FAILOVER_COOLDOWN_MS = 30 * 60_000; // 30 minutes between auto-failovers
const MAX_FAILOVERS_PER_24H = 3;

// ── Types ────────────────────────────────────────────────────────────

export interface Heartbeat {
  /** Machine ID of the heartbeat sender */
  holder: string;
  /** Current role of the sender */
  role: MachineRole;
  /** ISO timestamp of the heartbeat */
  timestamp: string;
  /** ISO timestamp when this heartbeat expires */
  expiresAt: string;
}

export interface FailoverConfig {
  /** Whether auto-failover is enabled */
  enabled: boolean;
  /** Milliseconds of silence before failover (default: 15 min) */
  timeoutMs: number;
  /** Whether to require human confirmation before failover */
  requireConfirmation: boolean;
}

export interface FailoverState {
  /** Timestamps of recent auto-failover events */
  recentFailovers: number[];
  /** Whether auto-failover has been disabled due to instability */
  disabled: boolean;
  /** Reason auto-failover was disabled */
  disabledReason?: string;
}

export type HeartbeatCheckResult =
  | { status: 'healthy'; holder: string; ageMs: number }
  | { status: 'stale'; holder: string; ageMs: number }
  | { status: 'expired'; holder: string; ageMs: number }
  | { status: 'missing' }
  | { status: 'split-brain'; holder: string; myId: string };

// ── HeartbeatManager ─────────────────────────────────────────────────

export class HeartbeatManager {
  private stateDir: string;
  private machineId: string;
  private failoverConfig: FailoverConfig;
  private failoverState: FailoverState;

  constructor(
    stateDir: string,
    machineId: string,
    failoverConfig?: Partial<FailoverConfig>,
  ) {
    this.stateDir = stateDir;
    this.machineId = machineId;
    this.failoverConfig = {
      enabled: failoverConfig?.enabled ?? true,
      timeoutMs: failoverConfig?.timeoutMs ?? DEFAULT_FAILOVER_TIMEOUT_MS,
      requireConfirmation: failoverConfig?.requireConfirmation ?? false,
    };
    this.failoverState = {
      recentFailovers: [],
      disabled: false,
    };
  }

  // ── Heartbeat Path ───────────────────────────────────────────────

  get heartbeatPath(): string {
    return path.join(this.stateDir, 'state', HEARTBEAT_FILE);
  }

  // ── Write Heartbeat ──────────────────────────────────────────────

  /**
   * Write a heartbeat as the awake machine.
   */
  writeHeartbeat(): Heartbeat {
    const now = new Date();
    const heartbeat: Heartbeat = {
      holder: this.machineId,
      role: 'awake',
      timestamp: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.failoverConfig.timeoutMs).toISOString(),
    };

    const dir = path.dirname(this.heartbeatPath);
    fs.mkdirSync(dir, { recursive: true });

    // Atomic write
    const tmpPath = `${this.heartbeatPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(heartbeat, null, 2));
    fs.renameSync(tmpPath, this.heartbeatPath);

    return heartbeat;
  }

  // ── Read Heartbeat ───────────────────────────────────────────────

  /**
   * Read the current heartbeat from disk.
   * Returns null if no heartbeat file exists.
   */
  readHeartbeat(): Heartbeat | null {
    if (!fs.existsSync(this.heartbeatPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.heartbeatPath, 'utf-8'));
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'HeartbeatManager.readHeartbeat',
        primary: 'Read heartbeat file for multi-machine coordination',
        fallback: 'Return null — heartbeat unknown',
        reason: `Failed to read heartbeat: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'May cause false failovers in multi-machine setup',
      });
      return null;
    }
  }

  // ── Check Heartbeat ──────────────────────────────────────────────

  /**
   * Check the heartbeat status relative to this machine.
   * This is the critical hot-path check before every Telegram poll.
   */
  checkHeartbeat(): HeartbeatCheckResult {
    const heartbeat = this.readHeartbeat();

    if (!heartbeat) {
      return { status: 'missing' };
    }

    const ageMs = Date.now() - new Date(heartbeat.timestamp).getTime();
    const expired = Date.now() > new Date(heartbeat.expiresAt).getTime();

    // Split-brain: another machine claims awake, and so do we
    if (heartbeat.holder !== this.machineId && heartbeat.role === 'awake') {
      // This could be split-brain OR normal standby monitoring
      if (expired) {
        return { status: 'expired', holder: heartbeat.holder, ageMs };
      }
      return { status: 'healthy', holder: heartbeat.holder, ageMs };
    }

    // Our own heartbeat
    if (expired) {
      return { status: 'expired', holder: heartbeat.holder, ageMs };
    }

    if (ageMs > HEARTBEAT_INTERVAL_MS * 2) {
      return { status: 'stale', holder: heartbeat.holder, ageMs };
    }

    return { status: 'healthy', holder: heartbeat.holder, ageMs };
  }

  /**
   * Determine if this machine should demote based on the heartbeat.
   * Called as the hot-path check before Telegram polling.
   *
   * Returns true if this machine should stop being awake (another machine
   * has a valid heartbeat claiming the awake role).
   */
  shouldDemote(): boolean {
    const heartbeat = this.readHeartbeat();
    if (!heartbeat) return false;

    // If the heartbeat holder is someone else AND it hasn't expired
    if (heartbeat.holder !== this.machineId) {
      const expired = Date.now() > new Date(heartbeat.expiresAt).getTime();
      return !expired;
    }

    return false;
  }

  /**
   * Process an incoming heartbeat from another machine (received via tunnel).
   * Handles split-brain detection.
   *
   * Returns 'demote' if this machine should demote, 'ignore' if not.
   */
  processIncomingHeartbeat(incoming: Heartbeat): 'demote' | 'ignore' | 'they-should-demote' {
    if (incoming.holder === this.machineId) return 'ignore';

    const localHeartbeat = this.readHeartbeat();

    // If we don't have a local heartbeat, the incoming one wins
    if (!localHeartbeat) return 'demote';

    // If we're not the holder, just update our local state
    if (localHeartbeat.holder !== this.machineId) {
      // Update local heartbeat with the incoming one if it's newer
      if (new Date(incoming.timestamp) > new Date(localHeartbeat.timestamp)) {
        this.writeIncomingHeartbeat(incoming);
      }
      return 'ignore';
    }

    // Split-brain: both claim awake
    const ourTimestamp = new Date(localHeartbeat.timestamp).getTime();
    const theirTimestamp = new Date(incoming.timestamp).getTime();

    if (theirTimestamp > ourTimestamp) {
      // Their heartbeat is newer — we should demote
      this.writeIncomingHeartbeat(incoming);
      return 'demote';
    }

    // Our heartbeat is newer — they should demote
    return 'they-should-demote';
  }

  // ── Failover ─────────────────────────────────────────────────────

  /**
   * Check if auto-failover should trigger.
   * Called periodically by standby machines.
   */
  shouldFailover(): { should: boolean; reason?: string } {
    if (!this.failoverConfig.enabled) {
      return { should: false, reason: 'Auto-failover disabled' };
    }

    if (this.failoverState.disabled) {
      return { should: false, reason: this.failoverState.disabledReason };
    }

    // Cooldown check
    const now = Date.now();
    const lastFailover = this.failoverState.recentFailovers[this.failoverState.recentFailovers.length - 1];
    if (lastFailover && (now - lastFailover) < FAILOVER_COOLDOWN_MS) {
      const remaining = Math.ceil((FAILOVER_COOLDOWN_MS - (now - lastFailover)) / 60_000);
      return { should: false, reason: `Cooldown: ${remaining} minutes remaining` };
    }

    // Max failovers check
    const dayAgo = now - 24 * 60 * 60_000;
    const recentCount = this.failoverState.recentFailovers.filter(t => t > dayAgo).length;
    if (recentCount >= MAX_FAILOVERS_PER_24H) {
      this.failoverState.disabled = true;
      this.failoverState.disabledReason = 'Auto-failover disabled: too many failovers in 24 hours';
      return { should: false, reason: this.failoverState.disabledReason };
    }

    // Check heartbeat expiry
    const heartbeat = this.readHeartbeat();
    if (!heartbeat) {
      return { should: true, reason: 'No heartbeat file found' };
    }

    const expired = Date.now() > new Date(heartbeat.expiresAt).getTime();
    if (!expired) {
      return { should: false, reason: 'Heartbeat still valid' };
    }

    return { should: true, reason: `Heartbeat expired (holder: ${heartbeat.holder})` };
  }

  /**
   * Record that a failover occurred.
   */
  recordFailover(): void {
    this.failoverState.recentFailovers.push(Date.now());
    // Keep only last 24h
    const dayAgo = Date.now() - 24 * 60 * 60_000;
    this.failoverState.recentFailovers = this.failoverState.recentFailovers.filter(t => t > dayAgo);
  }

  /**
   * Get the current failover state (for diagnostics).
   */
  getFailoverState(): FailoverState {
    return { ...this.failoverState };
  }

  /**
   * Reset failover state (re-enable after manual intervention).
   */
  resetFailoverState(): void {
    this.failoverState = {
      recentFailovers: [],
      disabled: false,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /**
   * Write an incoming heartbeat to the local file (not our own).
   */
  private writeIncomingHeartbeat(heartbeat: Heartbeat): void {
    const dir = path.dirname(this.heartbeatPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.heartbeatPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(heartbeat, null, 2));
    fs.renameSync(tmpPath, this.heartbeatPath);
  }
}
