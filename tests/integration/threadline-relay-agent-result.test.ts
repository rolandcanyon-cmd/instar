/**
 * Integration test — /messages/relay-agent now returns the ThreadlineRouter
 * result synchronously (PR-1: stop lying about delivery).
 *
 * Previously the handler fire-and-forgot ThreadlineRouter.handleInboundMessage
 * and returned `{ok:true}` immediately. This meant callers could never tell
 * whether the message was actually spawned, resumed, or dropped.
 *
 * After PR-1 the handler awaits the router and includes the result in the
 * response body under `threadline`.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageRouter } from '../../src/messaging/MessageRouter.js';
import { SessionSummarySentinel } from '../../src/messaging/SessionSummarySentinel.js';
import { SpawnRequestManager } from '../../src/messaging/SpawnRequestManager.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';
import type { ThreadlineHandleResult } from '../../src/threadline/ThreadlineRouter.js';

describe('/messages/relay-agent — threadline result propagation (PR-1)', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let messageStore: MessageStore;
  let messageRouter: MessageRouter;
  let app: ReturnType<AgentServer['getApp']>;
  let relayAgentToken: string;
  let handleInboundMessage: ReturnType<typeof vi.fn>;
  let handlerOrder: string[];
  const AUTH_TOKEN = 'test-auth-pr1';
  const PROJECT = 'test-pr1-project';

  beforeAll(async () => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    const messagingDir = path.join(project.stateDir, 'messages');
    fs.mkdirSync(messagingDir, { recursive: true });

    messageStore = new MessageStore(messagingDir);
    await messageStore.initialize();

    const formatter = new MessageFormatter();
    const mockTmux = {
      getForegroundProcess: () => 'bash',
      isSessionAlive: () => true,
      hasActiveHumanInput: () => false,
      sendKeys: () => true,
      getOutputLineCount: () => 100,
    };
    const delivery = new MessageDelivery(formatter, mockTmux);
    messageRouter = new MessageRouter(messageStore, delivery, {
      localAgent: PROJECT,
      localMachine: 'test-machine',
      serverUrl: 'http://localhost:0',
    });

    relayAgentToken = generateAgentToken(PROJECT);

    const config: InstarConfig = {
      projectName: PROJECT,
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 5000,
      version: '0.9.81',
      sessions: {
        claudePath: '/usr/bin/echo',
        maxSessions: 3,
        defaultMaxDurationMinutes: 30,
        protectedSessions: [],
        monitorIntervalMs: 5000,
      },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
      users: [],
    };

    handlerOrder = [];
    handleInboundMessage = vi.fn(async (): Promise<ThreadlineHandleResult> => {
      handlerOrder.push('router-start');
      // Simulate async work so we can verify the handler awaited us.
      await new Promise((r) => setTimeout(r, 25));
      handlerOrder.push('router-end');
      return {
        handled: true,
        spawned: true,
        threadId: 'thread-abc',
        sessionName: 'session-xyz',
      };
    });

    const fakeRouter = { handleInboundMessage } as any;

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
      messageRouter,
      summarySentinel: new SessionSummarySentinel({
        stateDir: project.stateDir,
        getActiveSessions: () => [],
        captureOutput: () => null,
      }),
      spawnManager: new SpawnRequestManager({
        maxSessions: 5,
        getActiveSessions: () => [],
        spawnSession: async () => 'test-spawned-session',
        cooldownMs: 1000,
      }),
      threadlineRouter: fakeRouter,
    });

    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    await messageStore.destroy();
    deleteAgentToken(PROJECT);
    project.cleanup();
  });

  function validEnvelope() {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      message: {
        id: `pr1-${Date.now()}-${Math.random()}`,
        from: { agent: 'other-agent', session: 's', machine: 'remote' },
        to: { agent: PROJECT, session: 'best', machine: 'local' },
        type: 'request',
        priority: 'medium',
        subject: 'hello',
        body: 'world',
        threadId: crypto.randomUUID(),
        createdAt: now,
        ttlMinutes: 30,
      },
      transport: {
        relayChain: ['remote'],
        originServer: 'http://remote:3000',
        nonce: `${crypto.randomUUID()}:${now}`,
        timestamp: now,
      },
      delivery: { phase: 'sent', transitions: [], attempts: 0 },
    };
  }

  it('returns the threadline router result in the response', async () => {
    const res = await request(app)
      .post('/messages/relay-agent')
      .set('Authorization', `Bearer ${relayAgentToken}`)
      .send(validEnvelope())
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.threadline).toBeDefined();
    expect(res.body.threadline.handled).toBe(true);
    expect(res.body.threadline.spawned).toBe(true);
    expect(res.body.threadline.threadId).toBe('thread-abc');
    expect(res.body.threadline.sessionName).toBe('session-xyz');
    expect(handleInboundMessage).toHaveBeenCalled();
  });

  it('awaits the router before responding (not fire-and-forget)', async () => {
    handlerOrder.length = 0;
    await request(app)
      .post('/messages/relay-agent')
      .set('Authorization', `Bearer ${relayAgentToken}`)
      .send(validEnvelope())
      .expect(200);

    // router-start AND router-end must both be in the order array before
    // we get here — this only holds if the handler awaited.
    expect(handlerOrder).toEqual(['router-start', 'router-end']);
  });

  it('returns handled:false threadline result cleanly', async () => {
    handleInboundMessage.mockResolvedValueOnce({ handled: false });
    const res = await request(app)
      .post('/messages/relay-agent')
      .set('Authorization', `Bearer ${relayAgentToken}`)
      .send(validEnvelope())
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.threadline).toEqual({ handled: false });
  });

  it('still returns 200 if the router throws, with error surfaced', async () => {
    handleInboundMessage.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app)
      .post('/messages/relay-agent')
      .set('Authorization', `Bearer ${relayAgentToken}`)
      .send(validEnvelope())
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.threadline.handled).toBe(false);
    expect(res.body.threadline.error).toBe('boom');
  });
});
