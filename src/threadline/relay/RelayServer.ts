/**
 * RelayServer — The main Threadline relay WebSocket server.
 *
 * Ties together ConnectionManager, MessageRouter, PresenceRegistry,
 * RelayRateLimiter, OfflineQueue, A2ABridge, AbuseDetector, and
 * RelayMetrics into a complete relay service.
 *
 * Part of Threadline Relay Phases 1-5.
 */

import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import type {
  RelayServerConfig,
  RelayFrame,
  ClientFrame,
  AgentFingerprint,
  PresenceChangeFrame,
} from './types.js';
import { RELAY_ERROR_CODES } from './types.js';
import { PresenceRegistry } from './PresenceRegistry.js';
import { RelayRateLimiter } from './RelayRateLimiter.js';
import { MessageRouter } from './MessageRouter.js';
import { ConnectionManager } from './ConnectionManager.js';
import { A2ABridge, A2ABridgeRateLimiter } from './A2ABridge.js';
import { InMemoryOfflineQueue } from './OfflineQueue.js';
import type { IOfflineQueue } from './OfflineQueue.js';
import { AbuseDetector } from './AbuseDetector.js';
import { RelayMetrics } from './RelayMetrics.js';
import type { MessageEnvelope } from './types.js';

type ResolvedRelayServerConfig = Omit<Required<RelayServerConfig>, 'rateLimitConfig' | 'a2aRateLimitConfig' | 'offlineQueueConfig' | 'abuseDetectorConfig'> & {
  rateLimitConfig?: Partial<import('./RelayRateLimiter.js').RelayRateLimitConfig>;
  a2aRateLimitConfig?: Partial<import('./A2ABridge.js').A2ABridgeRateLimitConfig>;
  offlineQueueConfig?: Partial<import('./OfflineQueue.js').OfflineQueueConfig>;
  abuseDetectorConfig?: Partial<import('./AbuseDetector.js').AbuseDetectorConfig>;
};

const DEFAULTS: ResolvedRelayServerConfig = {
  port: 8787,
  host: '0.0.0.0',
  heartbeatIntervalMs: 60_000,
  heartbeatJitterMs: 15_000,
  authTimeoutMs: 10_000,
  maxEnvelopeSize: 256 * 1024,
  maxAgents: 10_000,
  missedPongsBeforeDisconnect: 3,
};

export class RelayServer {
  private readonly config: ResolvedRelayServerConfig;
  readonly presence: PresenceRegistry;
  readonly rateLimiter: RelayRateLimiter;
  readonly router: MessageRouter;
  readonly connections: ConnectionManager;
  readonly a2aBridge: A2ABridge;
  readonly offlineQueue: IOfflineQueue;
  readonly abuseDetector: AbuseDetector;
  readonly metrics: RelayMetrics;
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private running = false;
  private readonly a2aResponseHandlers = new Map<string, (envelope: MessageEnvelope) => void>();

  constructor(config?: Partial<RelayServerConfig>) {
    this.config = { ...DEFAULTS, ...config };

    this.presence = new PresenceRegistry({ maxAgents: this.config.maxAgents });
    this.rateLimiter = new RelayRateLimiter(config?.rateLimitConfig);

    this.connections = new ConnectionManager(
      {
        heartbeatIntervalMs: this.config.heartbeatIntervalMs,
        heartbeatJitterMs: this.config.heartbeatJitterMs,
        authTimeoutMs: this.config.authTimeoutMs,
        missedPongsBeforeDisconnect: this.config.missedPongsBeforeDisconnect,
      },
      this.presence,
      this.rateLimiter,
    );

    this.router = new MessageRouter({
      presence: this.presence,
      rateLimiter: this.rateLimiter,
      getSocket: (id) => this.connections.getSocket(id),
      getIP: (id) => this.connections.getIP(id),
      maxEnvelopeSize: this.config.maxEnvelopeSize,
    });

    this.a2aBridge = new A2ABridge(
      {
        baseUrl: `http://${this.config.host}:${this.config.port}`,
      },
      {
        presence: this.presence,
        rateLimiter: new A2ABridgeRateLimiter(config?.a2aRateLimitConfig),
        sendToAgent: (agentId, envelope) => {
          const socket = this.connections.getSocket(agentId);
          if (!socket || socket.readyState !== WebSocket.OPEN) return false;
          socket.send(JSON.stringify({ type: 'message', envelope }));
          return true;
        },
        onAgentResponse: (taskId, handler) => {
          this.a2aResponseHandlers.set(taskId, handler);
        },
        removeResponseHandler: (taskId) => {
          this.a2aResponseHandlers.delete(taskId);
        },
      },
    );

    // Initialize offline queue
    const queue = new InMemoryOfflineQueue(config?.offlineQueueConfig);
    this.offlineQueue = queue;

    // Initialize abuse detector
    this.abuseDetector = new AbuseDetector(config?.abuseDetectorConfig);

    // Initialize metrics
    this.metrics = new RelayMetrics();

    // Wire abuse events to metrics
    this.abuseDetector.onAbuse(() => {
      this.metrics.recordAbuseBan();
    });

    // Wire up expiry notifications
    queue.onExpiry((expired) => {
      for (const envelope of expired) {
        this.notifyDeliveryExpired(envelope);
        this.metrics.recordMessageExpired();
      }
    });

    // Wire up presence change notifications + queue flush
    this.connections.onAuthenticated = (agentId) => {
      this.metrics.recordConnection();
      this.metrics.setActiveConnections(this.connections.size);

      // Check abuse: connection churn
      const churnBan = this.abuseDetector.recordConnection(agentId);
      if (churnBan) {
        // Agent was banned for connection churn — disconnect
        const socket = this.connections.getSocket(agentId);
        if (socket) {
          this.sendFrame(socket, {
            type: 'error',
            code: RELAY_ERROR_CODES.BANNED,
            message: churnBan.reason,
          });
          socket.close(4003, 'Banned: connection churn');
        }
        return;
      }

      this.notifyPresenceChange(agentId, 'online');
      this.flushOfflineQueue(agentId);
    };
    this.connections.onDisconnected = (agentId) => {
      this.metrics.setActiveConnections(this.connections.size);
      this.notifyPresenceChange(agentId, 'offline');
    };
  }

  /**
   * Start the relay server.
   */
  async start(): Promise<void> {
    if (this.running) return;

    return new Promise((resolve) => {
      this.httpServer = http.createServer(async (req, res) => {
        const pathname = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;

        // Health check endpoint
        if (pathname === '/health') {
          const queueStats = this.offlineQueue.getStats();
          const abuseStats = this.abuseDetector.getStats();
          const metricsSnapshot = this.metrics.getSnapshot();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            agents: this.presence.size,
            connections: this.connections.size,
            offlineQueue: queueStats,
            abuse: abuseStats,
            throughput: {
              messagesRouted: metricsSnapshot.messagesRouted,
              messagesPerMinute: metricsSnapshot.messagesPerMinute,
            },
            uptime: process.uptime(),
          }));
          return;
        }

        // A2A Bridge routes
        if (pathname.startsWith('/a2a/')) {
          try {
            const handled = await this.a2aBridge.handleRequest(req, res, pathname);
            if (handled) return;
          } catch {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }));
            return;
          }
        }

        res.writeHead(404);
        res.end();
      });

      this.wss = new WebSocketServer({
        server: this.httpServer,
        path: '/v1/connect',
        maxPayload: this.config.maxEnvelopeSize + 1024, // envelope + frame overhead
      });

      this.wss.on('connection', (socket, req) => {
        const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
          ?? req.socket.remoteAddress
          ?? 'unknown';

        this.connections.handleConnection(socket, ip);

        socket.on('message', (data) => {
          this.handleMessage(socket, data);
        });

        socket.on('close', () => {
          this.connections.handleDisconnect(socket);
        });

        socket.on('error', () => {
          this.connections.handleDisconnect(socket);
        });
      });

      this.httpServer.listen(this.config.port, this.config.host, () => {
        this.running = true;
        resolve();
      });
    });
  }

  /**
   * Stop the relay server.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    return new Promise((resolve) => {
      this.router.destroy();
      this.connections.destroy();
      this.a2aBridge.destroy();
      this.offlineQueue.destroy();
      this.abuseDetector.destroy();

      if (this.wss) {
        // Close all connections
        for (const client of this.wss.clients) {
          client.close(1001, 'Server shutting down');
        }
        this.wss.close();
        this.wss = null;
      }

      if (this.httpServer) {
        this.httpServer.close(() => {
          this.httpServer = null;
          this.running = false;
          resolve();
        });
      } else {
        this.running = false;
        resolve();
      }
    });
  }

  /**
   * Get the server's address (for testing).
   */
  get address(): { host: string; port: number } | null {
    const addr = this.httpServer?.address();
    if (!addr || typeof addr === 'string') return null;
    return { host: addr.address, port: addr.port };
  }

  /**
   * Whether the server is running.
   */
  get isRunning(): boolean {
    return this.running;
  }

  // ── Private ─────────────────────────────────────────────────────

  private handleMessage(socket: WebSocket, data: Buffer | ArrayBuffer | Buffer[] | string): void {
    let frame: ClientFrame;
    try {
      const text = typeof data === 'string' ? data : data.toString();
      frame = JSON.parse(text);
    } catch {
      this.sendFrame(socket, {
        type: 'error',
        code: RELAY_ERROR_CODES.INVALID_FRAME,
        message: 'Invalid JSON',
      });
      return;
    }

    // Handle auth before checking authentication
    if (frame.type === 'auth') {
      this.connections.handleAuth(socket, frame);
      return;
    }

    // All other frames require authentication
    if (!this.connections.isAuthenticated(socket)) {
      this.sendFrame(socket, {
        type: 'error',
        code: RELAY_ERROR_CODES.AUTH_FAILED,
        message: 'Not authenticated',
      });
      return;
    }

    const agentId = this.connections.getAgentId(socket)!;

    // Check if agent is banned
    const ban = this.abuseDetector.isBanned(agentId);
    if (ban) {
      this.sendFrame(socket, {
        type: 'error',
        code: RELAY_ERROR_CODES.BANNED,
        message: `Banned until ${ban.expiresAt}: ${ban.reason}`,
      });
      return;
    }

    switch (frame.type) {
      case 'message':
        this.handleRouteMessage(socket, agentId, frame);
        break;

      case 'ack':
        this.handleAck(agentId, frame);
        break;

      case 'discover':
        this.handleDiscover(socket, agentId, frame);
        break;

      case 'pong':
        this.connections.handlePong(socket);
        break;

      case 'subscribe':
        this.presence.subscribe(agentId, frame.agentIds);
        break;

      case 'presence':
        // Agent can update its own presence
        if (frame.status === 'offline') {
          this.connections.handleDisconnect(socket);
          socket.close(1000, 'Agent going offline');
        }
        break;

      default:
        this.sendFrame(socket, {
          type: 'error',
          code: RELAY_ERROR_CODES.INVALID_FRAME,
          message: `Unknown frame type: ${(frame as { type: string }).type}`,
        });
    }
  }

  private handleRouteMessage(
    socket: WebSocket,
    senderAgentId: AgentFingerprint,
    frame: { type: 'message'; envelope: import('./types.js').MessageEnvelope },
  ): void {
    this.metrics.recordMessageRouted();

    // Check Sybil limits for new agents
    const sybilCheck = this.abuseDetector.checkSybilLimit(senderAgentId);
    if (!sybilCheck.allowed) {
      this.sendFrame(socket, {
        type: 'ack',
        messageId: frame.envelope.messageId,
        status: 'rejected',
        reason: sybilCheck.reason,
      });
      this.metrics.recordMessageRejected();
      return;
    }

    // Check abuse patterns (spam, flooding)
    const abuseBan = this.abuseDetector.recordMessage(senderAgentId, frame.envelope.to);
    if (abuseBan) {
      this.sendFrame(socket, {
        type: 'error',
        code: RELAY_ERROR_CODES.BANNED,
        message: abuseBan.reason,
      });
      this.metrics.recordMessageRejected();
      return;
    }

    // Check if this message is addressed to the A2A bridge
    if (frame.envelope.to === this.a2aBridge.bridgeFingerprint) {
      const handled = this.a2aBridge.handleAgentResponse(frame.envelope);
      this.sendFrame(socket, {
        type: 'ack',
        messageId: frame.envelope.messageId,
        status: handled ? 'delivered' : 'rejected',
        reason: handled ? undefined : 'No pending A2A task for this thread',
      });
      if (handled) this.metrics.recordMessageDelivered();
      else this.metrics.recordMessageRejected();
      return;
    }

    const result = this.router.route(frame.envelope, senderAgentId);

    // If recipient is offline, try to queue the message
    if (!result.delivered && result.errorCode === RELAY_ERROR_CODES.RECIPIENT_OFFLINE) {
      const queueResult = this.offlineQueue.enqueue(frame.envelope);
      if (queueResult.queued) {
        this.sendFrame(socket, {
          type: 'ack',
          messageId: frame.envelope.messageId,
          status: 'queued',
          ttl: queueResult.ttlMs ? Math.round(queueResult.ttlMs / 1000) : undefined,
        });
        this.metrics.recordMessageQueued();
        return;
      }
      // Queue full — reject with specific reason
      this.sendFrame(socket, {
        type: 'ack',
        messageId: frame.envelope.messageId,
        status: 'rejected',
        reason: `Offline queue full (${queueResult.reason})`,
      });
      this.metrics.recordMessageRejected();
      return;
    }

    // Send ack back to sender
    this.sendFrame(socket, {
      type: 'ack',
      messageId: frame.envelope.messageId,
      status: result.status,
      reason: result.reason,
    });

    if (result.delivered) {
      this.metrics.recordMessageDelivered();
    } else {
      this.metrics.recordMessageRejected();
    }
  }

  /**
   * Flush queued messages when an agent comes online.
   */
  private flushOfflineQueue(agentId: AgentFingerprint): void {
    const queued = this.offlineQueue.drain(agentId);
    if (queued.length === 0) return;

    const socket = this.connections.getSocket(agentId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    for (const msg of queued) {
      this.sendFrame(socket, {
        type: 'message',
        envelope: msg.envelope,
      });

      // Notify the original sender that the message was delivered (if still connected)
      const senderSocket = this.connections.getSocket(msg.envelope.from);
      if (senderSocket) {
        this.sendFrame(senderSocket, {
          type: 'ack',
          messageId: msg.envelope.messageId,
          status: 'delivered',
        });
      }
    }
  }

  /**
   * Notify sender when a queued message expires.
   */
  private notifyDeliveryExpired(envelope: MessageEnvelope): void {
    const senderSocket = this.connections.getSocket(envelope.from);
    if (senderSocket) {
      this.sendFrame(senderSocket, {
        type: 'delivery_expired',
        messageId: envelope.messageId,
        recipientId: envelope.to,
        queuedAt: envelope.timestamp,
      });
    }
  }

  private handleAck(
    senderAgentId: AgentFingerprint,
    frame: { type: 'ack'; messageId: string; status: string },
  ): void {
    // Forward ack to the original sender of the message
    // For Phase 1, acks from recipients are informational only
    // The relay already sent its own delivery ack
  }

  private handleDiscover(
    socket: WebSocket,
    agentId: AgentFingerprint,
    frame: { type: 'discover'; filter?: { capability?: string; framework?: string; name?: string } },
  ): void {
    // Rate limit discovery
    const check = this.rateLimiter.checkDiscovery(agentId);
    if (!check.allowed) {
      this.sendFrame(socket, {
        type: 'error',
        code: RELAY_ERROR_CODES.RATE_LIMITED,
        message: 'Discovery rate limited',
      });
      return;
    }
    this.rateLimiter.recordDiscovery(agentId);
    this.metrics.recordDiscoveryQuery();

    const agents = this.presence.discover(frame.filter);
    this.sendFrame(socket, {
      type: 'discover_result',
      agents: agents.map(a => ({
        agentId: a.agentId,
        name: a.metadata.name,
        framework: a.metadata.framework,
        capabilities: a.metadata.capabilities,
        status: a.status,
        connectedSince: a.connectedSince,
      })),
    });
  }

  private notifyPresenceChange(agentId: AgentFingerprint, status: 'online' | 'offline'): void {
    const subscribers = this.presence.getSubscribers(agentId);
    const entry = this.presence.get(agentId);

    const notification: PresenceChangeFrame = {
      type: 'presence_change',
      agentId,
      status,
      metadata: entry?.metadata,
    };

    for (const subscriberId of subscribers) {
      const socket = this.connections.getSocket(subscriberId);
      if (socket) {
        this.sendFrame(socket, notification);
      }
    }
  }

  private sendFrame(socket: WebSocket, frame: RelayFrame): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }
}
