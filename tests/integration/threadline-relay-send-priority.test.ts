/**
 * Integration test — /threadline/relay-send accepts caller-supplied priority.
 *
 * REGRESSION: prior to this fix, the route hardcoded `priority: 'medium'`
 * in the local-delivery envelope regardless of caller intent. Critical
 * coordination traffic was indistinguishable from routine sends on the
 * recipient side, which starved spawn-cap override policies and caused
 * urgent cross-agent messages to be denied at the session cap.
 *
 * Fix: the route now accepts a `priority` field on the request body,
 * validates it against MessagePriority ('critical' | 'high' | 'medium' |
 * 'low'), defaults to 'medium' when omitted, and rejects invalid values
 * with 400.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { createRoutes } from '../../src/server/routes.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let projectDir: string;
let stateDir: string;
let server: Server;
let baseUrl: string;
let fakeTargetServer: Server;
let fakeTargetPort: number;
let capturedEnvelopes: Array<unknown>;
let tokenFilePath: string;
const TEST_TARGET_NAME = `priority-test-target-${randomBytes(3).toString('hex')}`;

describe('/threadline/relay-send caller-supplied priority', () => {
  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-relay-priority-'));
    stateDir = path.join(projectDir, '.instar');

    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ projectName: 'echo-priority-test' }),
    );

    // ── Fake local target server ─────────────────────────────────────
    // Returns 200 on /threadline/health (alive); captures envelopes
    // POSTed to /messages/relay-agent so we can assert their priority.
    capturedEnvelopes = [];
    const targetApp = express();
    targetApp.use(express.json({ limit: '128kb' }));
    targetApp.get('/threadline/health', (_req, res) => res.json({ ok: true }));
    targetApp.post('/messages/relay-agent', (req, res) => {
      capturedEnvelopes.push(req.body);
      res.json({ ok: true, threadline: { handled: true, gateDecision: 'allow' } });
    });
    await new Promise<void>((resolve) => {
      fakeTargetServer = targetApp.listen(0, '127.0.0.1', () => {
        fakeTargetPort = (fakeTargetServer.address() as { port: number }).port;
        resolve();
      });
    });

    // ── known-agents.json points at the fake target ──────────────────
    fs.writeFileSync(
      path.join(stateDir, 'threadline', 'known-agents.json'),
      JSON.stringify({
        agents: [
          {
            name: TEST_TARGET_NAME,
            port: fakeTargetPort,
            fingerprint: 'aabbccddeeff00112233445566778899',
            publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          },
        ],
      }),
      'utf-8',
    );

    // ── Agent token (so the route's getAgentToken returns non-null) ──
    const tokenDir = path.join(os.homedir(), '.instar', 'agent-tokens');
    fs.mkdirSync(tokenDir, { recursive: true });
    tokenFilePath = path.join(tokenDir, `${TEST_TARGET_NAME}.token`);
    fs.writeFileSync(tokenFilePath, randomBytes(32).toString('hex'), 'utf-8');

    const config = {
      projectDir,
      stateDir,
      projectName: 'echo-priority-test',
      port: 4042,
    } as InstarConfig;

    const state = new StateManager(stateDir);

    // The route's local-delivery branch is what we're exercising; the
    // remote relay client isn't reached, so a minimal stub suffices.
    const stubRelayClient = {
      connectionState: 'connected',
      resolveAgent: async () => null,
      sendAuto: () => 'msg-stub',
    };

    const app = express();
    app.use(express.json());

    const router = createRoutes({
      config,
      state,
      sessionManager: null as any,
      scheduler: null,
      telegram: null,
      relationships: null,
      feedback: null,
      dispatches: null,
      updateChecker: null,
      autoUpdater: null,
      autoDispatcher: null,
      quotaTracker: null,
      publisher: null,
      viewer: null,
      tunnel: null,
      evolution: null,
      watchdog: null,
      triageNurse: null,
      topicMemory: null,
      feedbackAnomalyDetector: null,
      projectMapper: null,
      coherenceGate: null,
      contextHierarchy: null,
      canonicalState: null,
      operationGate: null,
      sentinel: null,
      adaptiveTrust: null,
      memoryMonitor: null,
      orphanReaper: null,
      coherenceMonitor: null,
      commitmentTracker: null,
      semanticMemory: null,
      activitySentinel: null,
      messageRouter: null,
      summarySentinel: null,
      spawnManager: null,
      workingMemory: null,
      quotaManager: null,
      systemReviewer: null,
      capabilityMapper: null,
      selfKnowledgeTree: null,
      coverageAuditor: null,
      topicResumeMap: null,
      autonomyManager: null,
      trustElevationTracker: null,
      autonomousEvolution: null,
      whatsapp: null,
      messageBridge: null,
      hookEventReceiver: null,
      worktreeMonitor: null,
      subagentTracker: null,
      instructionsVerifier: null,
      threadlineRouter: null,
      handshakeManager: null,
      threadlineRelayClient: stubRelayClient as any,
      listenerManager: null,
      responseReviewGate: null,
      telemetryHeartbeat: null,
      pasteManager: null,
      wsManager: null,
      soulManager: null,
      discoveryEvaluator: null,
      startTime: new Date(),
    } as any);

    app.use(router);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fakeTargetServer) await new Promise<void>((resolve) => fakeTargetServer.close(() => resolve()));
    try { fs.unlinkSync(tokenFilePath); } catch { /* @silent-fallback-ok */ }
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/threadline-relay-send-priority.test.ts:cleanup',
    });
  });

  it('propagates priority="critical" through the local-delivery envelope', async () => {
    capturedEnvelopes.length = 0;
    const res = await fetch(`${baseUrl}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAgent: TEST_TARGET_NAME,
        message: 'urgent cross-agent coordination',
        priority: 'critical',
        waitForReply: false,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.deliveryPath).toBe('local');
    expect(capturedEnvelopes).toHaveLength(1);
    const envelope = capturedEnvelopes[0] as { message: { priority: string } };
    expect(envelope.message.priority).toBe('critical');
  });

  it('propagates priority="high" through the local-delivery envelope', async () => {
    capturedEnvelopes.length = 0;
    const res = await fetch(`${baseUrl}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAgent: TEST_TARGET_NAME,
        message: 'high-priority message',
        priority: 'high',
        waitForReply: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(capturedEnvelopes).toHaveLength(1);
    const envelope = capturedEnvelopes[0] as { message: { priority: string } };
    expect(envelope.message.priority).toBe('high');
  });

  it('propagates priority="low" through the local-delivery envelope', async () => {
    capturedEnvelopes.length = 0;
    const res = await fetch(`${baseUrl}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAgent: TEST_TARGET_NAME,
        message: 'low-priority message',
        priority: 'low',
        waitForReply: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(capturedEnvelopes).toHaveLength(1);
    const envelope = capturedEnvelopes[0] as { message: { priority: string } };
    expect(envelope.message.priority).toBe('low');
  });

  it('defaults priority to "medium" when caller omits the field', async () => {
    capturedEnvelopes.length = 0;
    const res = await fetch(`${baseUrl}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAgent: TEST_TARGET_NAME,
        message: 'no priority specified',
        waitForReply: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(capturedEnvelopes).toHaveLength(1);
    const envelope = capturedEnvelopes[0] as { message: { priority: string } };
    expect(envelope.message.priority).toBe('medium');
  });

  it('rejects unknown priority values with 400', async () => {
    capturedEnvelopes.length = 0;
    const res = await fetch(`${baseUrl}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAgent: TEST_TARGET_NAME,
        message: 'this should be rejected',
        priority: 'urgent', // not in the enum
        waitForReply: false,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Invalid priority/i);
    expect(capturedEnvelopes).toHaveLength(0);
  });

  it('rejects non-string priority values with 400', async () => {
    capturedEnvelopes.length = 0;
    const res = await fetch(`${baseUrl}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAgent: TEST_TARGET_NAME,
        message: 'this should be rejected',
        priority: 5, // wrong type
        waitForReply: false,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid priority/i);
    expect(capturedEnvelopes).toHaveLength(0);
  });
});
