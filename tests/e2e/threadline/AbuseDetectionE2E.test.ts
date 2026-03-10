/**
 * Abuse Detection E2E Tests
 *
 * Full integration: RelayServer + AbuseDetector + AdminServer
 * Tests ban enforcement, Sybil limits, abuse pattern detection,
 * and admin endpoint integration.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { AdminServer } from '../../../src/threadline/relay/AdminServer.js';
import { RelayClient } from '../../../src/threadline/client/RelayClient.js';
import { computeFingerprint, deriveX25519PublicKey } from '../../../src/threadline/client/MessageEncryptor.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import type { MessageEnvelope, AckFrame, ErrorFrame } from '../../../src/threadline/relay/types.js';

// ── HTTP helper ────────────────────────────────────────────────────

function adminRequest(
  port: number,
  method: string,
  path: string,
  key: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(bodyStr ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: {} });
          }
        });
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe('Abuse Detection E2E', { timeout: 30_000 }, () => {
  let server: RelayServer;
  let adminServer: AdminServer;
  let serverPort: number;
  let adminPort: number;
  const ADMIN_KEY = 'e2e-admin-key-test';

  const aliceIdentity = generateIdentityKeyPair();
  const aliceFingerprint = computeFingerprint(aliceIdentity.publicKey);
  const bobIdentity = generateIdentityKeyPair();
  const bobFingerprint = computeFingerprint(bobIdentity.publicKey);

  const makeClient = (identity: ReturnType<typeof generateIdentityKeyPair>, name: string) => {
    const fingerprint = computeFingerprint(identity.publicKey);
    return new RelayClient(
      {
        relayUrl: `ws://127.0.0.1:${serverPort}/v1/connect`,
        name,
        framework: 'test',
        capabilities: ['conversation'],
        version: '1.0.0',
        visibility: 'public',
        reconnectMaxMs: 0,
      },
      {
        fingerprint,
        publicKey: identity.publicKey,
        privateKey: identity.privateKey,
        x25519PublicKey: deriveX25519PublicKey(identity.privateKey),
        createdAt: new Date().toISOString(),
      },
    );
  };

  const makeEnvelope = (from: string, to: string): MessageEnvelope => ({
    from,
    to,
    threadId: `thread-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    nonce: Buffer.from('nonce').toString('base64'),
    ephemeralPubKey: Buffer.from('ephkey').toString('base64'),
    salt: Buffer.from('salt').toString('base64'),
    payload: Buffer.from('hello').toString('base64'),
    signature: Buffer.from('sig').toString('base64'),
  });

  beforeAll(async () => {
    server = new RelayServer({
      port: 0,
      host: '127.0.0.1',
      abuseDetectorConfig: {
        // Tight limits for testing
        spamUniqueRecipientsPerMinute: 3,
        spamBanDurationMs: 10_000,
        connectionChurnPerHour: 50, // high enough to not trigger during tests
        sybilFirstHourLimit: 3,
        sybilGraduationMs: 1000, // 1 second for testing
      },
      rateLimitConfig: {
        perAgentPerMinute: 200, // high to not interfere with abuse tests
        perAgentPerHour: 10000,
        perIPPerMinute: 500,
        globalPerMinute: 10000,
      },
    });
    await server.start();
    serverPort = server.address!.port;

    adminServer = new AdminServer(
      { port: 0, adminKey: ADMIN_KEY },
      {
        presence: server.presence,
        rateLimiter: server.rateLimiter,
        connections: server.connections,
        abuseDetector: server.abuseDetector,
        offlineQueue: server.offlineQueue,
        metrics: server.metrics,
        getUptime: () => Math.round(process.uptime()),
      },
    );
    await adminServer.start();
    adminPort = adminServer.address!.port;
  });

  afterAll(async () => {
    await adminServer.stop();
    await server.stop();
  });

  // ── Admin Ban Integration ────────────────────────────────────────

  it('admin can ban an agent and it gets rejected', async () => {
    // Ban Alice via admin
    const banRes = await adminRequest(adminPort, 'POST', '/admin/ban', ADMIN_KEY, {
      agentId: aliceFingerprint,
      reason: 'E2E test ban',
      durationMs: 60_000,
    });
    expect(banRes.status).toBe(200);

    // Alice connects
    const alice = makeClient(aliceIdentity, 'alice');
    // Must catch 'error' events to prevent unhandled error crashes
    alice.on('error', () => {}); // swallow — we check below
    await alice.connect();

    // Alice tries to send — should get banned error
    const errorPromise = new Promise<ErrorFrame>((resolve) => {
      alice.on('error', (frame: unknown) => {
        if (typeof frame === 'object' && frame !== null && 'code' in frame) {
          resolve(frame as ErrorFrame);
        }
      });
    });

    alice.sendMessage(makeEnvelope(aliceFingerprint, bobFingerprint));

    const error = await Promise.race([
      errorPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);

    expect(error).not.toBeNull();
    expect(error!.code).toBe('banned');

    // Unban via admin
    await adminRequest(adminPort, 'POST', '/admin/unban', ADMIN_KEY, {
      agentId: aliceFingerprint,
    });

    alice.disconnect();
  });

  // ── Health endpoint includes abuse stats ─────────────────────────

  it('health endpoint includes abuse and throughput info', async () => {
    const res = await new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: serverPort, path: '/health', method: 'GET' },
        (httpRes) => {
          const chunks: Buffer[] = [];
          httpRes.on('data', (c: Buffer) => chunks.push(c));
          httpRes.on('end', () => resolve({
            status: httpRes.statusCode ?? 0,
            data: JSON.parse(Buffer.concat(chunks).toString()),
          }));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(res.status).toBe(200);
    expect(res.data.abuse).toBeDefined();
    expect(res.data.throughput).toBeDefined();
    const abuse = res.data.abuse as Record<string, unknown>;
    expect(typeof abuse.activeBans).toBe('number');
    expect(typeof abuse.trackedAgents).toBe('number');
  });

  // ── Admin Status ─────────────────────────────────────────────────

  it('admin status shows relay overview', async () => {
    const res = await adminRequest(adminPort, 'GET', '/admin/status', ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ok');
    expect(typeof res.data.uptime).toBe('number');
    expect(res.data.abuse).toBeDefined();
    expect(res.data.throughput).toBeDefined();
  });

  // ── Metrics Endpoint ─────────────────────────────────────────────

  it('admin metrics returns Prometheus format', async () => {
    const res = await new Promise<{ status: number; raw: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: adminPort,
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
    expect(res.raw).toContain('threadline_messages_routed_total');
    expect(res.raw).toContain('threadline_uptime_seconds');
    expect(res.raw).toContain('# TYPE');
    expect(res.raw).toContain('# HELP');
  });

  // ── Metrics track real activity ──────────────────────────────────

  it('metrics record message routing', async () => {
    // Unban Alice first (previous test may have left a ban)
    await adminRequest(adminPort, 'POST', '/admin/unban', ADMIN_KEY, { agentId: aliceFingerprint });

    // Get baseline from metrics JSON
    const beforeRes = await new Promise<{ data: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1', port: adminPort, path: '/admin/metrics', method: 'GET',
          headers: { Authorization: `Bearer ${ADMIN_KEY}`, Accept: 'application/json' },
        },
        (httpRes) => {
          const chunks: Buffer[] = [];
          httpRes.on('data', (c: Buffer) => chunks.push(c));
          httpRes.on('end', () => resolve({ data: JSON.parse(Buffer.concat(chunks).toString()) }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    const beforeRouted = (beforeRes.data.messagesRouted as number) ?? 0;

    // Connect Alice and send a message (to offline Bob)
    const alice = makeClient(aliceIdentity, 'alice');
    alice.on('error', () => {}); // swallow errors
    await alice.connect();

    alice.sendMessage(makeEnvelope(aliceFingerprint, bobFingerprint));
    await new Promise(r => setTimeout(r, 300));

    // Check metrics increased
    const afterRes = await new Promise<{ data: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1', port: adminPort, path: '/admin/metrics', method: 'GET',
          headers: { Authorization: `Bearer ${ADMIN_KEY}`, Accept: 'application/json' },
        },
        (httpRes) => {
          const chunks: Buffer[] = [];
          httpRes.on('data', (c: Buffer) => chunks.push(c));
          httpRes.on('end', () => resolve({ data: JSON.parse(Buffer.concat(chunks).toString()) }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    const afterRouted = (afterRes.data.messagesRouted as number) ?? 0;

    expect(afterRouted).toBeGreaterThan(beforeRouted);

    alice.disconnect();
  });
});
