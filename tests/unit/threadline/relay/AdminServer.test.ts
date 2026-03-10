/**
 * AdminServer Unit Tests
 *
 * Tests admin endpoints: status, agents, metrics, ban/unban, auth.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { AdminServer } from '../../../../src/threadline/relay/AdminServer.js';
import { AbuseDetector } from '../../../../src/threadline/relay/AbuseDetector.js';
import { RelayMetrics } from '../../../../src/threadline/relay/RelayMetrics.js';
import { PresenceRegistry } from '../../../../src/threadline/relay/PresenceRegistry.js';
import { RelayRateLimiter } from '../../../../src/threadline/relay/RelayRateLimiter.js';
import { ConnectionManager } from '../../../../src/threadline/relay/ConnectionManager.js';
import { InMemoryOfflineQueue } from '../../../../src/threadline/relay/OfflineQueue.js';

// ── HTTP helper ────────────────────────────────────────────────────

function request(
  port: number,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown>; raw: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(bodyStr ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw), raw });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: {}, raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Tests ──────────────────────────────────────────────────────────

describe('AdminServer', () => {
  const ADMIN_KEY = 'test-admin-key-12345';
  let server: AdminServer;
  let port: number;
  let presence: PresenceRegistry;
  let abuseDetector: AbuseDetector;
  let metrics: RelayMetrics;
  let connections: ConnectionManager;
  let offlineQueue: InMemoryOfflineQueue;

  beforeAll(async () => {
    presence = new PresenceRegistry();
    abuseDetector = new AbuseDetector();
    metrics = new RelayMetrics();
    const rateLimiter = new RelayRateLimiter();
    connections = new ConnectionManager(
      { heartbeatIntervalMs: 60000, heartbeatJitterMs: 0, authTimeoutMs: 10000, missedPongsBeforeDisconnect: 3 },
      presence,
      rateLimiter,
    );
    offlineQueue = new InMemoryOfflineQueue();

    // Register a test agent
    presence.register('aabbccdd00112233', 'pubkey', { name: 'test-agent', framework: 'instar', capabilities: ['chat'] }, 'public', 'session-1');

    // Record some metrics
    metrics.recordMessageRouted();
    metrics.recordMessageRouted();
    metrics.recordMessageDelivered();
    metrics.recordConnection();

    server = new AdminServer(
      { port: 0, adminKey: ADMIN_KEY },
      {
        presence,
        rateLimiter,
        connections,
        abuseDetector,
        offlineQueue,
        metrics,
        getUptime: () => 42,
      },
    );

    await server.start();
    port = server.address!.port;
  });

  afterAll(async () => {
    await server.stop();
    abuseDetector.destroy();
    connections.destroy();
    offlineQueue.destroy();
  });

  // ── Auth ─────────────────────────────────────────────────────────

  it('rejects without admin key', async () => {
    const res = await request(port, 'GET', '/admin/status', 'wrong-key');
    expect(res.status).toBe(401);
  });

  it('rejects empty auth', async () => {
    const res = await request(port, 'GET', '/admin/status', '');
    expect(res.status).toBe(401);
  });

  // ── GET /admin/status ────────────────────────────────────────────

  it('returns relay status', async () => {
    const res = await request(port, 'GET', '/admin/status', ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ok');
    expect(res.data.uptime).toBe(42);
    expect(res.data.agents).toBe(1);
    expect(res.data.throughput).toBeDefined();
    const throughput = res.data.throughput as Record<string, unknown>;
    expect(throughput.messagesTotal).toBe(2);
  });

  // ── GET /admin/agents ────────────────────────────────────────────

  it('lists all agents', async () => {
    const res = await request(port, 'GET', '/admin/agents', ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.data.count).toBe(1);
    const agents = res.data.agents as Array<Record<string, unknown>>;
    expect(agents[0].name).toBe('test-agent');
    expect(agents[0].agentId).toBe('aabbccdd00112233');
    expect(agents[0].visibility).toBe('public');
  });

  // ── GET /admin/metrics ───────────────────────────────────────────

  it('returns metrics in Prometheus format by default', async () => {
    const res = await new Promise<{ status: number; raw: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/admin/metrics',
          method: 'GET',
          headers: {
            Authorization: `Bearer ${ADMIN_KEY}`,
            Accept: 'text/plain',
          },
        },
        (httpRes) => {
          const chunks: Buffer[] = [];
          httpRes.on('data', (c: Buffer) => chunks.push(c));
          httpRes.on('end', () => resolve({ status: httpRes.statusCode ?? 0, raw: Buffer.concat(chunks).toString() }));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(res.status).toBe(200);
    expect(res.raw).toContain('threadline_messages_routed_total 2');
    expect(res.raw).toContain('threadline_messages_delivered_total 1');
    expect(res.raw).toContain('# TYPE threadline_connections_total counter');
  });

  it('returns metrics in JSON when Accept: application/json', async () => {
    const res = await new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/admin/metrics',
          method: 'GET',
          headers: {
            Authorization: `Bearer ${ADMIN_KEY}`,
            Accept: 'application/json',
          },
        },
        (httpRes) => {
          const chunks: Buffer[] = [];
          httpRes.on('data', (c: Buffer) => chunks.push(c));
          httpRes.on('end', () => resolve({ status: httpRes.statusCode ?? 0, data: JSON.parse(Buffer.concat(chunks).toString()) }));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(res.status).toBe(200);
    expect(res.data.messagesRouted).toBe(2);
    expect(res.data.messagesDelivered).toBe(1);
  });

  // ── POST /admin/ban & /admin/unban ───────────────────────────────

  it('bans and unbans an agent', async () => {
    const banRes = await request(port, 'POST', '/admin/ban', ADMIN_KEY, {
      agentId: 'badagent123',
      reason: 'Testing ban',
      durationMs: 300_000,
    });
    expect(banRes.status).toBe(200);
    const ban = banRes.data.ban as Record<string, unknown>;
    expect(ban.agentId).toBe('badagent123');
    expect(ban.reason).toBe('Testing ban');

    // Verify ban shows up in list
    const listRes = await request(port, 'GET', '/admin/bans', ADMIN_KEY);
    expect(listRes.status).toBe(200);
    expect(listRes.data.count).toBe(1);

    // Unban
    const unbanRes = await request(port, 'POST', '/admin/unban', ADMIN_KEY, {
      agentId: 'badagent123',
    });
    expect(unbanRes.status).toBe(200);
    expect(unbanRes.data.unbanned).toBe(true);

    // Verify ban is gone
    const listRes2 = await request(port, 'GET', '/admin/bans', ADMIN_KEY);
    expect(listRes2.data.count).toBe(0);
  });

  it('ban requires agentId', async () => {
    const res = await request(port, 'POST', '/admin/ban', ADMIN_KEY, { reason: 'test' });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('agentId');
  });

  it('unban requires agentId', async () => {
    const res = await request(port, 'POST', '/admin/unban', ADMIN_KEY, {});
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('agentId');
  });

  it('ban with default duration', async () => {
    const res = await request(port, 'POST', '/admin/ban', ADMIN_KEY, {
      agentId: 'defaultban',
    });
    expect(res.status).toBe(200);
    const ban = res.data.ban as Record<string, unknown>;
    expect(ban.durationMs).toBe(60 * 60 * 1000); // 1 hour default
    // Cleanup
    abuseDetector.unban('defaultban');
  });

  // ── GET /admin/bans ──────────────────────────────────────────────

  it('lists active bans (initially empty after cleanup)', async () => {
    const res = await request(port, 'GET', '/admin/bans', ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.data.count).toBe(0);
  });

  // ── Error handling ───────────────────────────────────────────────

  it('returns 404 for unknown routes', async () => {
    const res = await request(port, 'GET', '/admin/nonexistent', ADMIN_KEY);
    expect(res.status).toBe(404);
  });

  it('rejects invalid JSON body', async () => {
    const res = await new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/admin/ban',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ADMIN_KEY}`,
            'Content-Type': 'application/json',
          },
        },
        (httpRes) => {
          const chunks: Buffer[] = [];
          httpRes.on('data', (c: Buffer) => chunks.push(c));
          httpRes.on('end', () => resolve({ status: httpRes.statusCode ?? 0, data: JSON.parse(Buffer.concat(chunks).toString()) }));
        },
      );
      req.on('error', reject);
      req.write('not json');
      req.end();
    });
    expect(res.status).toBe(400);
  });

  // ── Lifecycle ────────────────────────────────────────────────────

  it('reports isRunning', () => {
    expect(server.isRunning).toBe(true);
  });

  it('handles OPTIONS', async () => {
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/admin/status', method: 'OPTIONS' },
        (httpRes) => { httpRes.resume(); httpRes.on('end', () => resolve({ status: httpRes.statusCode ?? 0 })); },
      );
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(204);
  });
});
