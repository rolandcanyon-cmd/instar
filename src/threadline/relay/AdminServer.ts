/**
 * AdminServer — Relay administration endpoints.
 *
 * Exposes relay health, agent management, metrics, and ban management
 * on a separate port accessible only from the operator's network.
 *
 * Requires authentication via `RELAY_ADMIN_KEY` environment variable
 * or config, passed as `Authorization: Bearer <key>`.
 *
 * Part of Threadline Relay Phase 5.
 */

import http from 'node:http';
import type { PresenceRegistry } from './PresenceRegistry.js';
import type { RelayRateLimiter } from './RelayRateLimiter.js';
import type { ConnectionManager } from './ConnectionManager.js';
import type { AbuseDetector } from './AbuseDetector.js';
import type { IOfflineQueue } from './OfflineQueue.js';
import type { RelayMetrics } from './RelayMetrics.js';

// ── Configuration ──────────────────────────────────────────────────

export interface AdminServerConfig {
  port: number; // default 9091
  host?: string; // default '127.0.0.1'
  adminKey: string; // required
}

export interface AdminServerDeps {
  presence: PresenceRegistry;
  rateLimiter: RelayRateLimiter;
  connections: ConnectionManager;
  abuseDetector: AbuseDetector;
  offlineQueue: IOfflineQueue;
  metrics: RelayMetrics;
  getUptime: () => number;
}

// ── Implementation ─────────────────────────────────────────────────

export class AdminServer {
  private readonly config: Required<AdminServerConfig>;
  private readonly deps: AdminServerDeps;
  private server: http.Server | null = null;
  private running = false;

  constructor(config: AdminServerConfig, deps: AdminServerDeps) {
    this.config = {
      port: config.port,
      host: config.host ?? '127.0.0.1',
      adminKey: config.adminKey,
    };
    this.deps = deps;
  }

  async start(): Promise<void> {
    if (this.running) return;

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.listen(this.config.port, this.config.host, () => {
        this.running = true;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.running || !this.server) return;

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        this.running = false;
        resolve();
      });
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  get address(): { host: string; port: number } | null {
    const addr = this.server?.address();
    if (!addr || typeof addr === 'string') return null;
    return { host: addr.address, port: addr.port };
  }

  // ── Request Handling ─────────────────────────────────────────────

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS for localhost only
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${this.config.adminKey}`) {
      this.sendJson(res, 401, { error: 'Unauthorized. Provide relay admin key.' });
      return;
    }

    const pathname = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;

    try {
      if (pathname === '/admin/status' && req.method === 'GET') {
        this.handleStatus(res);
      } else if (pathname === '/admin/agents' && req.method === 'GET') {
        this.handleListAgents(res);
      } else if (pathname === '/admin/metrics' && req.method === 'GET') {
        this.handleMetrics(req, res);
      } else if (pathname === '/admin/ban' && req.method === 'POST') {
        this.handleBan(req, res);
      } else if (pathname === '/admin/unban' && req.method === 'POST') {
        this.handleUnban(req, res);
      } else if (pathname === '/admin/bans' && req.method === 'GET') {
        this.handleListBans(res);
      } else {
        this.sendJson(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      this.sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal error' });
    }
  }

  private handleStatus(res: http.ServerResponse): void {
    const queueStats = this.deps.offlineQueue.getStats();
    const abuseStats = this.deps.abuseDetector.getStats();
    const metricsSnapshot = this.deps.metrics.getSnapshot();

    this.sendJson(res, 200, {
      status: 'ok',
      uptime: this.deps.getUptime(),
      agents: this.deps.presence.size,
      connections: this.deps.connections.size,
      offlineQueue: queueStats,
      abuse: abuseStats,
      throughput: {
        messagesTotal: metricsSnapshot.messagesRouted,
        messagesPerMinute: metricsSnapshot.messagesPerMinute,
        connectionsTotal: metricsSnapshot.connectionsTotal,
        authFailures: metricsSnapshot.authFailures,
      },
    });
  }

  private handleListAgents(res: http.ServerResponse): void {
    const agents = this.deps.presence.getAll();
    this.sendJson(res, 200, {
      agents: agents.map(a => ({
        agentId: a.agentId,
        name: a.metadata.name,
        framework: a.metadata.framework,
        capabilities: a.metadata.capabilities,
        visibility: a.visibility,
        status: a.status,
        connectedSince: a.connectedSince,
        lastSeen: a.lastSeen,
        sessionId: a.sessionId,
      })),
      count: agents.length,
    });
  }

  private handleMetrics(req: http.IncomingMessage, res: http.ServerResponse): void {
    const accept = req.headers.accept ?? '';
    const snapshot = this.deps.metrics.getSnapshot();

    // If Prometheus format requested (or default)
    if (accept.includes('text/plain') || !accept.includes('application/json')) {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(this.deps.metrics.toPrometheus());
      return;
    }

    // JSON format
    this.sendJson(res, 200, snapshot);
  }

  private async handleBan(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    if (!body) {
      this.sendJson(res, 400, { error: 'Request body required' });
      return;
    }

    let params: { agentId?: string; reason?: string; durationMs?: number };
    try {
      params = JSON.parse(body);
    } catch {
      this.sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    if (!params.agentId) {
      this.sendJson(res, 400, { error: 'agentId is required' });
      return;
    }

    const durationMs = params.durationMs ?? 60 * 60 * 1000; // default 1 hour
    const reason = params.reason ?? 'Manual admin ban';
    const ban = this.deps.abuseDetector.ban(params.agentId, reason, durationMs);
    this.sendJson(res, 200, { ban });
  }

  private async handleUnban(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    if (!body) {
      this.sendJson(res, 400, { error: 'Request body required' });
      return;
    }

    let params: { agentId?: string };
    try {
      params = JSON.parse(body);
    } catch {
      this.sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    if (!params.agentId) {
      this.sendJson(res, 400, { error: 'agentId is required' });
      return;
    }

    const removed = this.deps.abuseDetector.unban(params.agentId);
    this.sendJson(res, 200, { unbanned: removed, agentId: params.agentId });
  }

  private handleListBans(res: http.ServerResponse): void {
    const bans = this.deps.abuseDetector.getActiveBans();
    this.sendJson(res, 200, { bans, count: bans.length });
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', () => resolve(''));
    });
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}
