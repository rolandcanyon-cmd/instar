/**
 * ConnectionManager — Manages WebSocket connections from agents.
 *
 * Handles authentication, heartbeat, and connection lifecycle.
 * Part of Threadline Relay Phase 1.
 */

import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import type {
  AgentFingerprint,
  AgentVisibility,
  AuthFrame,
  ChallengeFrame,
  AuthOkFrame,
  AuthErrorFrame,
  PingFrame,
  ErrorFrame,
  DisplacedFrame,
  RelayFrame,
  RelayServerConfig,
} from './types.js';
import { RELAY_ERROR_CODES } from './types.js';
import { verify } from '../ThreadlineCrypto.js';
import type { PresenceRegistry } from './PresenceRegistry.js';
import type { RelayRateLimiter } from './RelayRateLimiter.js';

interface PendingAuth {
  nonce: string;
  timer: ReturnType<typeof setTimeout>;
  ip: string;
}

interface AgentConnection {
  socket: WebSocket;
  agentId: AgentFingerprint;
  publicKey: Buffer;
  sessionId: string;
  ip: string;
  missedPongs: number;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
}

export interface ConnectionManagerConfig {
  heartbeatIntervalMs: number;
  heartbeatJitterMs: number;
  authTimeoutMs: number;
  missedPongsBeforeDisconnect: number;
}

export class ConnectionManager {
  private readonly config: ConnectionManagerConfig;
  private readonly presence: PresenceRegistry;
  private readonly rateLimiter: RelayRateLimiter;
  private readonly pending = new Map<WebSocket, PendingAuth>();
  private readonly connections = new Map<AgentFingerprint, AgentConnection>();
  private readonly socketToAgent = new Map<WebSocket, AgentFingerprint>();

  /** Callback when a fully authenticated agent connection is established */
  onAuthenticated?: (agentId: AgentFingerprint, socket: WebSocket) => void;
  /** Callback when an agent disconnects */
  onDisconnected?: (agentId: AgentFingerprint) => void;
  /** Callback when an existing agent is displaced by a new connection */
  onDisplaced?: (agentId: AgentFingerprint, oldSocket: WebSocket) => void;

  constructor(
    config: ConnectionManagerConfig,
    presence: PresenceRegistry,
    rateLimiter: RelayRateLimiter,
  ) {
    this.config = config;
    this.presence = presence;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Handle a new WebSocket connection.
   * Sends a challenge and waits for auth response.
   */
  handleConnection(socket: WebSocket, ip: string): void {
    // Rate limit auth attempts by IP
    const authCheck = this.rateLimiter.checkAuth(ip);
    if (!authCheck.allowed) {
      this.sendFrame(socket, {
        type: 'auth_error',
        code: RELAY_ERROR_CODES.RATE_LIMITED,
        message: 'Too many auth attempts',
      });
      socket.close(4029, 'Rate limited');
      return;
    }
    this.rateLimiter.recordAuth(ip);

    // Generate challenge nonce
    const nonce = crypto.randomBytes(32).toString('base64');
    const challenge: ChallengeFrame = { type: 'challenge', nonce };

    // Set auth timeout
    const timer = setTimeout(() => {
      this.pending.delete(socket);
      this.sendFrame(socket, {
        type: 'auth_error',
        code: RELAY_ERROR_CODES.AUTH_TIMEOUT,
        message: 'Authentication timeout',
      });
      socket.close(4008, 'Auth timeout');
    }, this.config.authTimeoutMs);

    this.pending.set(socket, { nonce, timer, ip });
    this.sendFrame(socket, challenge);
  }

  /**
   * Handle an auth response from an agent.
   */
  handleAuth(socket: WebSocket, frame: AuthFrame): boolean {
    const pending = this.pending.get(socket);
    if (!pending) {
      this.sendFrame(socket, {
        type: 'auth_error',
        code: RELAY_ERROR_CODES.AUTH_FAILED,
        message: 'No pending challenge',
      });
      return false;
    }

    clearTimeout(pending.timer);
    this.pending.delete(socket);

    // Decode public key
    let publicKey: Buffer;
    try {
      publicKey = Buffer.from(frame.publicKey, 'base64');
      if (publicKey.length !== 32) throw new Error('Invalid key length');
    } catch {
      this.sendFrame(socket, {
        type: 'auth_error',
        code: RELAY_ERROR_CODES.AUTH_FAILED,
        message: 'Invalid public key',
      });
      return false;
    }

    // Verify fingerprint matches public key
    const expectedFingerprint = publicKey.subarray(0, 16).toString('hex');
    if (frame.agentId !== expectedFingerprint) {
      this.sendFrame(socket, {
        type: 'auth_error',
        code: RELAY_ERROR_CODES.AUTH_FAILED,
        message: 'Agent ID does not match public key',
      });
      return false;
    }

    // Verify signature
    let signature: Buffer;
    try {
      signature = Buffer.from(frame.signature, 'base64');
    } catch {
      this.sendFrame(socket, {
        type: 'auth_error',
        code: RELAY_ERROR_CODES.AUTH_FAILED,
        message: 'Invalid signature encoding',
      });
      return false;
    }

    const nonceBuffer = Buffer.from(pending.nonce, 'utf-8');
    const valid = verify(publicKey, nonceBuffer, signature);
    if (!valid) {
      this.sendFrame(socket, {
        type: 'auth_error',
        code: RELAY_ERROR_CODES.AUTH_FAILED,
        message: 'Signature verification failed',
      });
      return false;
    }

    // Handle displacement: if this agent is already connected, disconnect the old socket
    const existingConn = this.connections.get(frame.agentId);
    if (existingConn) {
      const displacedFrame: DisplacedFrame = {
        type: 'displaced',
        reason: 'Another device connected with the same identity key',
      };
      this.sendFrame(existingConn.socket, displacedFrame);
      this.removeConnection(existingConn.socket, frame.agentId);
      existingConn.socket.close(4001, 'Displaced by new connection');
      this.onDisplaced?.(frame.agentId, existingConn.socket);
    }

    // Register with presence
    const sessionId = `relay-${crypto.randomBytes(8).toString('hex')}`;
    const visibility: AgentVisibility = frame.visibility ?? 'unlisted';

    try {
      this.presence.register(
        frame.agentId,
        frame.publicKey,
        frame.metadata,
        visibility,
        sessionId,
      );
    } catch (err) {
      this.sendFrame(socket, {
        type: 'auth_error',
        code: RELAY_ERROR_CODES.INTERNAL_ERROR,
        message: err instanceof Error ? err.message : 'Registration failed',
      });
      return false;
    }

    // Store connection
    const connection: AgentConnection = {
      socket,
      agentId: frame.agentId,
      publicKey,
      sessionId,
      ip: pending.ip,
      missedPongs: 0,
      heartbeatTimer: null,
    };
    this.connections.set(frame.agentId, connection);
    this.socketToAgent.set(socket, frame.agentId);

    // Start heartbeat
    this.startHeartbeat(connection);

    // Send auth success
    const authOk: AuthOkFrame = {
      type: 'auth_ok',
      sessionId,
      heartbeatInterval: this.config.heartbeatIntervalMs,
    };
    this.sendFrame(socket, authOk);

    this.onAuthenticated?.(frame.agentId, socket);
    return true;
  }

  /**
   * Handle a pong response from an agent.
   */
  handlePong(socket: WebSocket): void {
    const agentId = this.socketToAgent.get(socket);
    if (!agentId) return;
    const conn = this.connections.get(agentId);
    if (!conn) return;
    conn.missedPongs = 0;
    this.presence.touch(agentId);
  }

  /**
   * Handle socket close/error.
   */
  handleDisconnect(socket: WebSocket): void {
    // Clean up pending auth
    const pending = this.pending.get(socket);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(socket);
    }

    // Clean up authenticated connection
    const agentId = this.socketToAgent.get(socket);
    if (agentId) {
      this.removeConnection(socket, agentId);
      this.onDisconnected?.(agentId);
    }
  }

  /**
   * Get socket for an agent.
   */
  getSocket(agentId: AgentFingerprint): WebSocket | undefined {
    return this.connections.get(agentId)?.socket;
  }

  /**
   * Get agent ID for a socket.
   */
  getAgentId(socket: WebSocket): AgentFingerprint | undefined {
    return this.socketToAgent.get(socket);
  }

  /**
   * Get IP address for an agent.
   */
  getIP(agentId: AgentFingerprint): string {
    return this.connections.get(agentId)?.ip ?? 'unknown';
  }

  /**
   * Check if a socket is authenticated.
   */
  isAuthenticated(socket: WebSocket): boolean {
    return this.socketToAgent.has(socket);
  }

  /**
   * Get total number of active connections.
   */
  get size(): number {
    return this.connections.size;
  }

  /**
   * Destroy all connections and timers.
   */
  destroy(): void {
    for (const [, conn] of this.connections) {
      if (conn.heartbeatTimer) clearTimeout(conn.heartbeatTimer);
    }
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
    }
    this.connections.clear();
    this.socketToAgent.clear();
    this.pending.clear();
  }

  // ── Private ─────────────────────────────────────────────────────

  private startHeartbeat(conn: AgentConnection): void {
    const scheduleNext = () => {
      const jitter = (Math.random() * 2 - 1) * this.config.heartbeatJitterMs;
      const interval = this.config.heartbeatIntervalMs + jitter;

      conn.heartbeatTimer = setTimeout(() => {
        if (conn.missedPongs >= this.config.missedPongsBeforeDisconnect) {
          // Too many missed pongs — disconnect
          this.handleDisconnect(conn.socket);
          conn.socket.close(4000, 'Heartbeat timeout');
          return;
        }

        conn.missedPongs++;
        const ping: PingFrame = {
          type: 'ping',
          timestamp: new Date().toISOString(),
        };
        this.sendFrame(conn.socket, ping);
        scheduleNext();
      }, Math.max(1000, interval));
    };

    scheduleNext();
  }

  private removeConnection(socket: WebSocket, agentId: AgentFingerprint): void {
    const conn = this.connections.get(agentId);
    if (conn?.heartbeatTimer) {
      clearTimeout(conn.heartbeatTimer);
    }
    this.connections.delete(agentId);
    this.socketToAgent.delete(socket);
    this.presence.unregister(agentId);
  }

  private sendFrame(socket: WebSocket, frame: RelayFrame): void {
    if (socket.readyState === 1 /* OPEN */) {
      socket.send(JSON.stringify(frame));
    }
  }
}
