/**
 * A2A Bridge E2E Tests
 *
 * Full integration: RelayServer + A2ABridge + RelayClient
 * Tests real HTTP requests to A2A endpoints with connected Threadline agents.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { RelayClient } from '../../../src/threadline/client/RelayClient.js';
import { computeFingerprint, deriveX25519PublicKey } from '../../../src/threadline/client/MessageEncryptor.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import type { MessageEnvelope } from '../../../src/threadline/relay/types.js';

// ── Helpers ─────────────────────────────────────────────────────────

function httpRequest(
  url: string,
  options: http.RequestOptions & { body?: string } = {},
): Promise<{ status: number; body: string; json: () => unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode ?? 0,
            body,
            json: () => JSON.parse(body),
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('A2A Bridge E2E', () => {
  let server: RelayServer;
  let serverPort: number;
  let baseUrl: string;

  // Agent identities
  const agentIdentity = generateIdentityKeyPair();
  const agentFingerprint = computeFingerprint(agentIdentity.publicKey);
  let agentClient: RelayClient;
  let receivedMessages: MessageEnvelope[];

  const makeClient = (identity: ReturnType<typeof generateIdentityKeyPair>, name: string, opts?: { visibility?: 'public' | 'unlisted' | 'private' }) => {
    const fingerprint = computeFingerprint(identity.publicKey);
    return new RelayClient(
      {
        relayUrl: `ws://127.0.0.1:${serverPort}/v1/connect`,
        name,
        framework: 'test',
        capabilities: ['conversation', 'code-review'],
        version: '1.0.0',
        visibility: opts?.visibility ?? 'public',
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

  beforeAll(async () => {
    server = new RelayServer({
      port: 0,
      rateLimitConfig: {
        perAgentPerMinute: 1000,
        perAgentPerHour: 10000,
        perIPPerMinute: 10000,
        globalPerMinute: 50000,
        discoveryPerMinute: 100,
        authAttemptsPerMinute: 100,
      },
      a2aRateLimitConfig: {
        requestsPerMinutePerIP: 1000,
        requestsPerHourPerIP: 10000,
      },
      abuseDetectorConfig: {
        sybilFirstHourLimit: 10000,
        sybilSecondHourLimit: 10000,
        spamUniqueRecipientsPerMinute: 10000,
      },
    });
    await server.start();
    serverPort = server.address!.port;
    baseUrl = `http://127.0.0.1:${serverPort}`;

    // Connect a Threadline agent
    receivedMessages = [];
    agentClient = makeClient(agentIdentity, 'test-e2e-agent');
    agentClient.on('message', (envelope: MessageEnvelope) => {
      receivedMessages.push(envelope);

      // Auto-respond to A2A messages
      const payload = JSON.parse(Buffer.from(envelope.payload, 'base64').toString());
      if (payload.type === 'a2a-message') {
        // Send a response back on the same thread using sendMessage
        const responseEnvelope: MessageEnvelope = {
          from: agentFingerprint,
          to: envelope.from, // Reply to the bridge
          threadId: envelope.threadId,
          messageId: `resp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          timestamp: new Date().toISOString(),
          nonce: '',
          ephemeralPubKey: '',
          salt: '',
          payload: Buffer.from(JSON.stringify({
            content: `Echo: ${payload.content}`,
            type: 'a2a-response',
          })).toString('base64'),
          signature: '',
        };
        // Send back via the relay
        agentClient.sendMessage(responseEnvelope);
      }
    });
    await agentClient.connect();

    // Wait for agent to be fully registered
    await new Promise(r => setTimeout(r, 100));
  });

  afterAll(async () => {
    agentClient.disconnect();
    await server.stop();
  });

  // ── Agent Card Tests ─────────────────────────────────────────────

  describe('Agent Card via HTTP', () => {
    it('returns agent card for connected public agent', async () => {
      const res = await httpRequest(`${baseUrl}/a2a/${agentFingerprint}/.well-known/agent-card.json`);
      expect(res.status).toBe(200);

      const card = res.json() as Record<string, unknown>;
      expect(card.name).toBe('test-e2e-agent');
      // URL uses configured baseUrl (0.0.0.0:0) not actual listen address — just check it contains the agent ID
      expect(card.url).toContain(`/a2a/${agentFingerprint}`);
      expect(card).toHaveProperty('skills');
      expect(card).toHaveProperty('capabilities');
      expect(card).toHaveProperty('extensions');

      const extensions = card.extensions as { threadline: { transport: string } };
      expect(extensions.threadline.transport).toBe('a2a-bridge');
    });

    it('returns agent card with capabilities mapped to skills', async () => {
      const res = await httpRequest(`${baseUrl}/a2a/${agentFingerprint}/.well-known/agent-card.json`);
      const card = res.json() as { skills: Array<{ id: string; name: string }> };

      const skillIds = card.skills.map(s => s.id);
      expect(skillIds).toContain('conversation');
      expect(skillIds).toContain('code-review');
    });

    it('returns 404 for non-existent agent', async () => {
      const res = await httpRequest(`${baseUrl}/a2a/0000000000000000/.well-known/agent-card.json`);
      expect(res.status).toBe(404);

      const body = res.json() as { error: { code: number } };
      expect(body.error.code).toBe(-32001);
    });

    it('returns 404 for unlisted agent', async () => {
      const unlistedIdentity = generateIdentityKeyPair();
      const unlistedClient = makeClient(unlistedIdentity, 'unlisted-agent', { visibility: 'unlisted' });
      await unlistedClient.connect();
      await new Promise(r => setTimeout(r, 100));

      const fp = computeFingerprint(unlistedIdentity.publicKey);
      const res = await httpRequest(`${baseUrl}/a2a/${fp}/.well-known/agent-card.json`);
      expect(res.status).toBe(404);

      unlistedClient.disconnect();
    });
  });

  // ── Message Sending Tests ────────────────────────────────────────

  describe('A2A Message → Threadline Agent', () => {
    it('delivers message and returns agent response', async () => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 'e2e-req-1',
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'Hello from A2A E2E test!' }],
          },
        },
      });

      const res = await httpRequest(`${baseUrl}/a2a/${agentFingerprint}/messages`, {
        method: 'POST',
        body,
      });

      expect(res.status).toBe(200);
      const result = res.json() as { jsonrpc: string; id: string; result: { status: string; id: string } };
      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe('e2e-req-1');
      expect(result.result.status).toBe('completed');
      expect(result.result.id).toMatch(/^task-/);
    });

    it('preserves context across multiple requests', async () => {
      const makeBody = (text: string) => JSON.stringify({
        jsonrpc: '2.0',
        id: 'ctx-req',
        method: 'message/send',
        params: {
          message: { role: 'user', parts: [{ type: 'text', text }] },
          contextId: 'e2e-persistent-context',
        },
      });

      // First message
      const res1 = await httpRequest(`${baseUrl}/a2a/${agentFingerprint}/messages`, {
        method: 'POST',
        body: makeBody('First message'),
      });
      expect(res1.status).toBe(200);

      // Second message with same contextId
      const res2 = await httpRequest(`${baseUrl}/a2a/${agentFingerprint}/messages`, {
        method: 'POST',
        body: makeBody('Second message'),
      });
      expect(res2.status).toBe(200);

      // Both should have been received by the agent
      // Check that the second message used the same threadId
      const contextMessages = receivedMessages.filter(m => {
        const p = JSON.parse(Buffer.from(m.payload, 'base64').toString());
        return p.metadata?.contextId === 'e2e-persistent-context';
      });
      expect(contextMessages.length).toBeGreaterThanOrEqual(2);
      expect(contextMessages[1].threadId).toBe(contextMessages[0].threadId);
    });

    it('includes transport metadata in delivered envelope', async () => {
      const msgCountBefore = receivedMessages.length;
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 'meta-req',
        method: 'message/send',
        params: {
          message: { role: 'user', parts: [{ type: 'text', text: 'Metadata test' }] },
          contextId: 'meta-test-ctx',
        },
      });

      await httpRequest(`${baseUrl}/a2a/${agentFingerprint}/messages`, {
        method: 'POST',
        body,
      });

      // Find the message that was just delivered
      const newMessages = receivedMessages.slice(msgCountBefore);
      expect(newMessages.length).toBeGreaterThanOrEqual(1);

      const payload = JSON.parse(Buffer.from(newMessages[0].payload, 'base64').toString());
      expect(payload.metadata.transport).toBe('a2a-bridge');
      expect(payload.metadata.a2aTaskId).toMatch(/^task-/);
      expect(payload.metadata.contextId).toBe('meta-test-ctx');
      expect(payload.content).toBe('Metadata test');
    });
  });

  // ── Error Handling Tests ─────────────────────────────────────────

  describe('Error handling', () => {
    it('returns 404 for messages to non-existent agent', async () => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 'err-1',
        method: 'message/send',
        params: {
          message: { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
        },
      });

      const res = await httpRequest(`${baseUrl}/a2a/0000000000000000/messages`, {
        method: 'POST',
        body,
      });
      expect(res.status).toBe(404);
    });

    it('returns parse error for invalid JSON body', async () => {
      const res = await httpRequest(`${baseUrl}/a2a/${agentFingerprint}/messages`, {
        method: 'POST',
        body: 'not valid json {{{',
      });
      expect(res.status).toBe(400);

      const result = res.json() as { error: { code: number; message: string } };
      expect(result.error.code).toBe(-32700);
    });

    it('returns error for missing message parts', async () => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 'err-2',
        method: 'message/send',
        params: { message: {} },
      });

      const res = await httpRequest(`${baseUrl}/a2a/${agentFingerprint}/messages`, {
        method: 'POST',
        body,
      });
      expect(res.status).toBe(400);

      const result = res.json() as { error: { code: number } };
      expect(result.error.code).toBe(-32602);
    });

    it('returns error for unsupported A2A method', async () => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 'err-3',
        method: 'tasks/list',
        params: {},
      });

      const res = await httpRequest(`${baseUrl}/a2a/${agentFingerprint}/messages`, {
        method: 'POST',
        body,
      });
      expect(res.status).toBe(400);

      const result = res.json() as { error: { code: number } };
      expect(result.error.code).toBe(-32601);
    });

    it('returns 404 for unknown A2A subpath', async () => {
      const res = await httpRequest(`${baseUrl}/a2a/${agentFingerprint}/unknown-endpoint`);
      expect(res.status).toBe(404);
    });
  });

  // ── Task Management Tests ────────────────────────────────────────

  describe('Task lifecycle', () => {
    it('task status reflects pending while waiting for agent', async () => {
      // Create a separate agent that does NOT auto-respond
      const slowIdentity = generateIdentityKeyPair();
      const slowFingerprint = computeFingerprint(slowIdentity.publicKey);
      const slowClient = makeClient(slowIdentity, 'slow-agent');
      let lastSlowMessage: MessageEnvelope | null = null;

      slowClient.on('message', (envelope: MessageEnvelope) => {
        lastSlowMessage = envelope;
        // Deliberately NOT responding — to test task status
      });

      await slowClient.connect();
      await new Promise(r => setTimeout(r, 100));

      // Send a message — this will block waiting for response
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 'slow-req',
        method: 'message/send',
        params: {
          message: { role: 'user', parts: [{ type: 'text', text: 'Are you there?' }] },
        },
      });

      // Fire the request in background (it will hang waiting for response)
      const responsePromise = httpRequest(`${baseUrl}/a2a/${slowFingerprint}/messages`, {
        method: 'POST',
        body,
      });

      // Wait for message to arrive at agent
      await new Promise(r => setTimeout(r, 200));
      expect(lastSlowMessage).not.toBeNull();

      // Extract task ID from the delivered envelope
      const payload = JSON.parse(Buffer.from(lastSlowMessage!.payload, 'base64').toString());
      const taskId = payload.metadata.a2aTaskId;

      // Query task status — should be submitted
      const statusRes = await httpRequest(`${baseUrl}/a2a/${slowFingerprint}/tasks/${taskId}`);
      expect(statusRes.status).toBe(200);
      const statusResult = (statusRes.json() as { result: { status: string } });
      expect(statusResult.result.status).toBe('submitted');

      // Cancel the task to unblock the request
      const cancelRes = await httpRequest(`${baseUrl}/a2a/${slowFingerprint}/tasks/${taskId}:cancel`, {
        method: 'POST',
      });
      expect(cancelRes.status).toBe(200);
      const cancelResult = (cancelRes.json() as { result: { status: string } });
      expect(cancelResult.result.status).toBe('canceled');

      // The original request should now resolve
      const result = await responsePromise;
      expect(result.status).toBe(200);
      const resultBody = result.json() as { result: { status: string } };
      expect(resultBody.result.status).toBe('canceled');

      slowClient.disconnect();
    });

    it('returns 404 for non-existent task ID', async () => {
      const res = await httpRequest(`${baseUrl}/a2a/${agentFingerprint}/tasks/task-nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  // ── Health & Routing Tests ───────────────────────────────────────

  describe('Server routing', () => {
    it('health endpoint still works alongside A2A routes', async () => {
      const res = await httpRequest(`${baseUrl}/health`);
      expect(res.status).toBe(200);

      const health = res.json() as { status: string; agents: number };
      expect(health.status).toBe('ok');
      expect(health.agents).toBeGreaterThanOrEqual(1);
    });

    it('returns 404 for non-A2A, non-health paths', async () => {
      const res = await httpRequest(`${baseUrl}/some/random/path`);
      expect(res.status).toBe(404);
    });
  });

  // ── Rate Limiting Tests ──────────────────────────────────────────

  describe('Bridge rate limiting', () => {
    it('allows normal request flow', async () => {
      // Send a few requests — should all work
      for (let i = 0; i < 3; i++) {
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: `rate-${i}`,
          method: 'message/send',
          params: {
            message: { role: 'user', parts: [{ type: 'text', text: `Rate test ${i}` }] },
          },
        });

        const res = await httpRequest(`${baseUrl}/a2a/${agentFingerprint}/messages`, {
          method: 'POST',
          body,
        });
        expect(res.status).toBe(200);
      }
    });
  });
});
