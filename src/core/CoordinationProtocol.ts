/**
 * CoordinationProtocol — Work coordination primitives for multi-machine agents.
 *
 * Provides higher-level coordination on top of AgentBus:
 *   1. File avoidance requests ("please avoid file X for 30 min")
 *   2. Work announcements (broadcast what you're starting/finishing)
 *   3. Status queries (who is working on what?)
 *   4. ETA tracking (when will other machine finish with a file?)
 *   5. Leadership / awake-role management with fencing tokens
 *
 * From INTELLIGENT_SYNC_SPEC Sections 7.4, 8, 13.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentBus, AgentMessage } from './AgentBus.js';

// ── Types ────────────────────────────────────────────────────────────

export interface FileAvoidanceRequest {
  /** Files to avoid. */
  files: string[];
  /** Duration in milliseconds. */
  durationMs: number;
  /** Reason for the request. */
  reason: string;
  /** Session ID of the requester. */
  sessionId?: string;
}

export interface FileAvoidanceResponse {
  /** Whether the request was accepted. */
  accepted: boolean;
  /** Files that cannot be avoided (already committed to). */
  conflictingFiles: string[];
  /** Reason for partial/full rejection. */
  reason?: string;
}

export interface WorkAnnouncement {
  /** Unique work item ID. */
  workId: string;
  /** Type of announcement. */
  action: 'started' | 'completed' | 'paused' | 'resumed' | 'abandoned';
  /** Session ID. */
  sessionId: string;
  /** Task description. */
  task: string;
  /** Files planned or modified. */
  files: string[];
  /** Branch name, if applicable. */
  branch?: string;
  /** Estimated completion time (ISO). */
  eta?: string;
}

export interface StatusQuery {
  /** What to query. */
  queryType: 'active-work' | 'file-owners' | 'machine-status';
  /** Filter by specific files (for file-owners). */
  files?: string[];
}

export interface StatusResponse {
  /** Machine ID of the responder. */
  machineId: string;
  /** Active work items on this machine. */
  activeWork: WorkAnnouncement[];
  /** Machine status. */
  status: 'active' | 'idle' | 'shutting-down';
  /** Current session ID. */
  sessionId?: string;
}

export interface LeadershipState {
  /** Current leader machine ID. */
  leaderId: string;
  /** Fencing token (monotonically increasing). */
  fencingToken: number;
  /** Role of this machine. */
  role: 'awake' | 'standby';
  /** Lease expiration (ISO). */
  leaseExpiresAt: string;
  /** When the lease was acquired. */
  acquiredAt: string;
}

export interface AvoidanceEntry {
  /** Requesting machine. */
  from: string;
  /** Files to avoid. */
  files: string[];
  /** When the avoidance expires. */
  expiresAt: number;
  /** Reason. */
  reason: string;
}

export interface CoordinationProtocolConfig {
  /** The AgentBus instance for communication. */
  bus: AgentBus;
  /** This machine's ID. */
  machineId: string;
  /** State directory (.instar). */
  stateDir: string;
  /** Lease TTL in ms (default: 15 min). */
  leaseTtlMs?: number;
  /** Timeout for status queries in ms (default: 10s). */
  statusQueryTimeoutMs?: number;
  /** Callback when a file avoidance request is received. */
  onAvoidanceRequest?: (req: FileAvoidanceRequest, from: string) => FileAvoidanceResponse;
  /** Callback when a work announcement is received. */
  onWorkAnnouncement?: (announcement: WorkAnnouncement, from: string) => void;
}

export interface CoordinationEvents {
  'avoidance-requested': (req: FileAvoidanceRequest, from: string) => void;
  'avoidance-response': (resp: FileAvoidanceResponse, from: string) => void;
  'work-announced': (announcement: WorkAnnouncement, from: string) => void;
  'status-response': (resp: StatusResponse) => void;
  'leadership-changed': (state: LeadershipState) => void;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_LEASE_TTL = 15 * 60 * 1000; // 15 minutes
const DEFAULT_STATUS_TIMEOUT = 10_000;
const COORDINATION_DIR = 'coordination';
const LEADERSHIP_FILE = 'leadership.json';
const AVOIDANCE_FILE = 'avoidances.json';

// ── CoordinationProtocol ─────────────────────────────────────────────

export class CoordinationProtocol {
  private bus: AgentBus;
  private machineId: string;
  private stateDir: string;
  private leaseTtlMs: number;
  private statusQueryTimeoutMs: number;
  private coordDir: string;
  private avoidances: AvoidanceEntry[] = [];
  private peerWork: Map<string, WorkAnnouncement[]> = new Map();
  private onAvoidanceRequest?: (req: FileAvoidanceRequest, from: string) => FileAvoidanceResponse;
  private onWorkAnnouncement?: (announcement: WorkAnnouncement, from: string) => void;

  constructor(config: CoordinationProtocolConfig) {
    this.bus = config.bus;
    this.machineId = config.machineId;
    this.stateDir = config.stateDir;
    this.leaseTtlMs = config.leaseTtlMs ?? DEFAULT_LEASE_TTL;
    this.statusQueryTimeoutMs = config.statusQueryTimeoutMs ?? DEFAULT_STATUS_TIMEOUT;
    this.onAvoidanceRequest = config.onAvoidanceRequest;
    this.onWorkAnnouncement = config.onWorkAnnouncement;

    this.coordDir = path.join(config.stateDir, 'state', COORDINATION_DIR);
    if (!fs.existsSync(this.coordDir)) {
      fs.mkdirSync(this.coordDir, { recursive: true });
    }

    // Register message handlers
    this.registerHandlers();
  }

  // ── File Avoidance ──────────────────────────────────────────────────

  /**
   * Request another machine to avoid specific files for a duration.
   */
  async requestFileAvoidance(
    targetMachineId: string,
    request: FileAvoidanceRequest,
  ): Promise<FileAvoidanceResponse | null> {
    const reply = await this.bus.request<FileAvoidanceRequest, FileAvoidanceResponse>({
      type: 'file-avoidance-request',
      to: targetMachineId,
      payload: request,
      timeoutMs: this.statusQueryTimeoutMs,
    });

    return reply?.payload ?? null;
  }

  /**
   * Broadcast a file avoidance request to all machines.
   */
  async broadcastFileAvoidance(request: FileAvoidanceRequest): Promise<void> {
    await this.bus.send({
      type: 'file-avoidance-request',
      to: '*',
      payload: request,
    });
  }

  /**
   * Check if a file is currently under avoidance.
   */
  isFileAvoided(filePath: string): AvoidanceEntry | undefined {
    this.cleanExpiredAvoidances();
    return this.avoidances.find(a => a.files.includes(filePath));
  }

  /**
   * Get all active avoidances.
   */
  getActiveAvoidances(): AvoidanceEntry[] {
    this.cleanExpiredAvoidances();
    return [...this.avoidances];
  }

  // ── Work Announcements ──────────────────────────────────────────────

  /**
   * Announce work to all machines.
   */
  async announceWork(announcement: WorkAnnouncement): Promise<void> {
    await this.bus.send({
      type: 'work-announcement',
      to: '*',
      payload: announcement,
    });
  }

  /**
   * Announce that work has started.
   */
  async announceWorkStarted(opts: {
    sessionId: string;
    task: string;
    files: string[];
    branch?: string;
    eta?: string;
  }): Promise<string> {
    const workId = `work_${crypto.randomBytes(6).toString('hex')}`;
    await this.announceWork({
      workId,
      action: 'started',
      ...opts,
    });
    return workId;
  }

  /**
   * Announce that work has completed.
   */
  async announceWorkCompleted(workId: string, sessionId: string, files: string[]): Promise<void> {
    await this.announceWork({
      workId,
      action: 'completed',
      sessionId,
      task: '',
      files,
    });
  }

  /**
   * Get known work from other machines.
   */
  getPeerWork(machineId?: string): WorkAnnouncement[] {
    if (machineId) {
      return this.peerWork.get(machineId) ?? [];
    }
    const all: WorkAnnouncement[] = [];
    for (const [, work] of this.peerWork) {
      all.push(...work);
    }
    return all;
  }

  // ── Status Queries ──────────────────────────────────────────────────

  /**
   * Query a specific machine's status.
   */
  async queryStatus(targetMachineId: string): Promise<StatusResponse | null> {
    const reply = await this.bus.request<StatusQuery, StatusResponse>({
      type: 'status-update',
      to: targetMachineId,
      payload: { queryType: 'active-work' },
      timeoutMs: this.statusQueryTimeoutMs,
    });

    return reply?.payload ?? null;
  }

  /**
   * Query all machines for file owners.
   */
  async queryFileOwners(files: string[]): Promise<StatusResponse[]> {
    // Broadcast the query
    await this.bus.send<StatusQuery>({
      type: 'status-update',
      to: '*',
      payload: { queryType: 'file-owners', files },
    });

    // Collect responses (imperfect — relies on peer responses arriving before timeout)
    return new Promise<StatusResponse[]>((resolve) => {
      const responses: StatusResponse[] = [];
      const timer = setTimeout(() => {
        this.bus.off('message', handler);
        resolve(responses);
      }, this.statusQueryTimeoutMs);

      const handler = (msg: AgentMessage) => {
        if (msg.type === 'status-update' && msg.from !== this.machineId) {
          const payload = msg.payload as StatusResponse;
          if (payload.machineId) {
            responses.push(payload);
          }
        }
      };

      this.bus.on('message', handler);
    });
  }

  // ── Leadership ──────────────────────────────────────────────────────

  /**
   * Attempt to claim the awake (leader) role.
   * Returns the new leadership state if successful.
   */
  claimLeadership(): LeadershipState | null {
    const current = this.readLeadership();

    // Check if current leader's lease is still valid
    if (current && current.leaderId !== this.machineId) {
      const expiresAt = new Date(current.leaseExpiresAt).getTime();
      if (Date.now() < expiresAt) {
        return null; // Another machine holds a valid lease
      }
    }

    // Claim leadership
    const newToken = (current?.fencingToken ?? 0) + 1;
    const now = new Date();
    const state: LeadershipState = {
      leaderId: this.machineId,
      fencingToken: newToken,
      role: 'awake',
      leaseExpiresAt: new Date(now.getTime() + this.leaseTtlMs).toISOString(),
      acquiredAt: now.toISOString(),
    };

    this.writeLeadership(state);
    return state;
  }

  /**
   * Renew the leadership lease (must already be leader).
   */
  renewLease(): LeadershipState | null {
    const current = this.readLeadership();
    if (!current || current.leaderId !== this.machineId) {
      return null; // Not the leader
    }

    const now = new Date();
    current.leaseExpiresAt = new Date(now.getTime() + this.leaseTtlMs).toISOString();
    this.writeLeadership(current);
    return current;
  }

  /**
   * Relinquish leadership (transition to standby).
   */
  relinquishLeadership(): void {
    const current = this.readLeadership();
    if (current && current.leaderId === this.machineId) {
      current.role = 'standby';
      current.leaseExpiresAt = new Date().toISOString(); // Expire immediately
      this.writeLeadership(current);
    }
  }

  /**
   * Read current leadership state.
   */
  getLeadership(): LeadershipState | null {
    return this.readLeadership();
  }

  /**
   * Check if this machine is the current leader.
   */
  isLeader(): boolean {
    const current = this.readLeadership();
    if (!current) return false;
    if (current.leaderId !== this.machineId) return false;
    return Date.now() < new Date(current.leaseExpiresAt).getTime();
  }

  /**
   * Check if the current leader's lease has expired.
   */
  isLeaseExpired(): boolean {
    const current = this.readLeadership();
    if (!current) return true;
    return Date.now() >= new Date(current.leaseExpiresAt).getTime();
  }

  // ── Accessors ───────────────────────────────────────────────────────

  getMachineId(): string {
    return this.machineId;
  }

  // ── Private: Message Handlers ───────────────────────────────────────

  private registerHandlers(): void {
    // Handle file avoidance requests
    this.bus.onMessage<FileAvoidanceRequest>('file-avoidance-request', (msg) => {
      // Record the avoidance
      this.avoidances.push({
        from: msg.from,
        files: msg.payload.files,
        expiresAt: Date.now() + msg.payload.durationMs,
        reason: msg.payload.reason,
      });

      // Invoke callback and possibly respond
      if (this.onAvoidanceRequest) {
        const response = this.onAvoidanceRequest(msg.payload, msg.from);
        // Send response if this was a directed request
        if (msg.to !== '*' && msg.replyTo === undefined) {
          this.bus.send<FileAvoidanceResponse>({
            type: 'file-avoidance-response',
            to: msg.from,
            payload: response,
            replyTo: msg.id,
          });
        }
      }
    });

    // Handle file avoidance responses
    this.bus.onMessage<FileAvoidanceResponse>('file-avoidance-response', (_msg) => {
      // Handled by request/response pattern in AgentBus
    });

    // Handle work announcements
    this.bus.onMessage<WorkAnnouncement>('work-announcement', (msg) => {
      const announcement = msg.payload;
      const peerList = this.peerWork.get(msg.from) ?? [];

      if (announcement.action === 'started' || announcement.action === 'resumed') {
        // Add or update work entry
        const existingIdx = peerList.findIndex(w => w.workId === announcement.workId);
        if (existingIdx >= 0) {
          peerList[existingIdx] = announcement;
        } else {
          peerList.push(announcement);
        }
      } else if (announcement.action === 'completed' || announcement.action === 'abandoned') {
        // Remove work entry
        const idx = peerList.findIndex(w => w.workId === announcement.workId);
        if (idx >= 0) peerList.splice(idx, 1);
      } else if (announcement.action === 'paused') {
        // Update status
        const existing = peerList.find(w => w.workId === announcement.workId);
        if (existing) existing.action = 'paused';
      }

      this.peerWork.set(msg.from, peerList);

      if (this.onWorkAnnouncement) {
        this.onWorkAnnouncement(announcement, msg.from);
      }
    });

    // Handle status queries
    this.bus.onMessage<StatusQuery>('status-update', (msg) => {
      // Only respond to queries, not responses
      const payload = msg.payload;
      if (!payload.queryType) return;

      const ownWork = this.peerWork.get(this.machineId) ?? [];
      const response: StatusResponse = {
        machineId: this.machineId,
        activeWork: ownWork,
        status: 'active',
      };

      // If file-specific query, filter work
      if (payload.queryType === 'file-owners' && payload.files) {
        const targetFiles = new Set(payload.files);
        response.activeWork = ownWork.filter(w =>
          w.files.some(f => targetFiles.has(f)),
        );
      }

      this.bus.send<StatusResponse>({
        type: 'status-update',
        to: msg.from,
        payload: response,
        replyTo: msg.id,
      });
    });
  }

  // ── Private: Avoidance Cleanup ──────────────────────────────────────

  private cleanExpiredAvoidances(): void {
    const now = Date.now();
    this.avoidances = this.avoidances.filter(a => a.expiresAt > now);
  }

  // ── Private: Leadership State I/O ───────────────────────────────────

  private readLeadership(): LeadershipState | null {
    const filePath = path.join(this.coordDir, LEADERSHIP_FILE);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as LeadershipState;
    } catch {
      // @silent-fallback-ok — leadership file may not exist yet; null signals no leadership state
      return null;
    }
  }

  private writeLeadership(state: LeadershipState): void {
    const filePath = path.join(this.coordDir, LEADERSHIP_FILE);
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n');
  }
}
