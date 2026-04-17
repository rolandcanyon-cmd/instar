/**
 * HTTP route tests for Integrated-Being v2 session-write endpoints
 * (/shared-state/session-bind, /shared-state/append). Slice 1 scope.
 *
 * Covers:
 *  - 503 when v2Enabled is false (spec §"Rollback plan" #1).
 *  - session-bind issues tokens; idempotent replay returns same token.
 *  - append accepts agreement|decision|note with a valid session binding.
 *  - append 401 on missing / invalid session headers.
 *  - append 400 on forbidden fields (commitment|provenance|emittedBy|source|id|t).
 *  - append 501 on commitment kind (deferred to slice 3).
 *  - append 400 on thread-* kinds (reserved for server emitters).
 *  - touchActivity fires on successful append (hasWritten flips).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import crypto from 'node:crypto';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SharedStateLedger } from '../../src/core/SharedStateLedger.js';
import { LedgerSessionRegistry } from '../../src/core/LedgerSessionRegistry.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

function baseConfig(stateDir: string): InstarConfig {
  return {
    projectName: 'test',
    projectDir: path.dirname(stateDir),
    stateDir,
    port: 0,
    authToken: 'test-bearer-token',
    sessions: {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/bin/claude',
      projectDir: path.dirname(stateDir),
      maxSessions: 1,
      protectedSessions: [],
      completionPatterns: [],
    },
    scheduler: {
      jobsFile: '',
      enabled: false,
      maxParallelJobs: 1,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    },
    users: [],
    messaging: [],
    monitoring: {
      quotaTracking: false,
      memoryMonitoring: false,
      healthCheckIntervalMs: 30000,
    },
  };
}

function uuid(): string {
  return crypto.randomUUID();
}

const AUTH = { Authorization: 'Bearer test-bearer-token' };

describe('Shared-state v2 routes — v2Enabled=false (default)', () => {
  let project: TempProject;
  let ledger: SharedStateLedger;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  beforeAll(() => {
    project = createTempProject();
    const cfg = baseConfig(project.stateDir);
    cfg.integratedBeing = { enabled: true }; // v2Enabled defaults to false
    ledger = new SharedStateLedger({
      stateDir: project.stateDir,
      config: cfg.integratedBeing,
      salt: 'test-salt',
    });
    server = new AgentServer({
      config: cfg,
      sessionManager: createMockSessionManager() as any,
      state: project.state,
      sharedStateLedger: ledger,
      // No ledgerSessionRegistry — v2 is disabled.
    });
    app = server.getApp();
  });

  afterAll(() => {
    ledger.shutdown();
    project.cleanup();
  });

  it('session-bind returns 503 with X-Disabled: v2 when v2Enabled=false', async () => {
    const res = await request(app)
      .post('/shared-state/session-bind')
      .set(AUTH)
      .send({ sessionId: uuid() });
    expect(res.status).toBe(503);
    expect(res.headers['x-disabled']).toBe('v2');
  });

  it('append returns 503 when v2Enabled=false', async () => {
    const res = await request(app)
      .post('/shared-state/append')
      .set(AUTH)
      .send({ kind: 'note', subject: 'x' });
    expect(res.status).toBe(503);
  });

  it('v1 endpoints remain functional', async () => {
    const res = await request(app).get('/shared-state/recent').set(AUTH);
    expect(res.status).toBe(200);
  });
});

describe('Shared-state v2 routes — v2Enabled=true', () => {
  let project: TempProject;
  let ledger: SharedStateLedger;
  let registry: LedgerSessionRegistry;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  beforeAll(() => {
    project = createTempProject();
    const cfg = baseConfig(project.stateDir);
    cfg.integratedBeing = { enabled: true, v2Enabled: true };
    ledger = new SharedStateLedger({
      stateDir: project.stateDir,
      config: cfg.integratedBeing,
      salt: 'test-salt',
    });
    registry = new LedgerSessionRegistry({
      stateDir: project.stateDir,
      config: cfg.integratedBeing,
    });
    server = new AgentServer({
      config: cfg,
      sessionManager: createMockSessionManager() as any,
      state: project.state,
      sharedStateLedger: ledger,
      ledgerSessionRegistry: registry,
    });
    app = server.getApp();
  });

  afterAll(() => {
    ledger.shutdown();
    project.cleanup();
  });

  describe('session-bind', () => {
    it('issues a 32-byte hex token', async () => {
      const res = await request(app)
        .post('/shared-state/session-bind')
        .set(AUTH)
        .send({ sessionId: uuid() });
      expect(res.status).toBe(200);
      expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
      expect(res.headers['cache-control']).toContain('no-store');
    });

    it('is idempotent on duplicate sessionId within TTL', async () => {
      const sid = uuid();
      const first = await request(app)
        .post('/shared-state/session-bind')
        .set(AUTH)
        .send({ sessionId: sid });
      const second = await request(app)
        .post('/shared-state/session-bind')
        .set(AUTH)
        .send({ sessionId: sid });
      expect(first.body.token).toBe(second.body.token);
      expect(second.body.idempotentReplay).toBe(true);
    });

    it('rejects malformed sessionId with 400', async () => {
      const res = await request(app)
        .post('/shared-state/session-bind')
        .set(AUTH)
        .send({ sessionId: 'not-a-uuid' });
      expect(res.status).toBe(400);
    });

    it('rejects missing sessionId with 400', async () => {
      const res = await request(app)
        .post('/shared-state/session-bind')
        .set(AUTH)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('append', () => {
    let sessionId: string;
    let token: string;

    beforeAll(async () => {
      sessionId = uuid();
      const res = await request(app)
        .post('/shared-state/session-bind')
        .set(AUTH)
        .send({ sessionId });
      token = res.body.token;
    });

    const headers = () => ({
      ...AUTH,
      'X-Instar-Session-Id': sessionId,
      'X-Instar-Session-Token': token,
    });

    it('accepts a valid note and returns {id, t}', async () => {
      const res = await request(app)
        .post('/shared-state/append')
        .set(headers())
        .send({
          kind: 'note',
          subject: 'slice-1 smoke note',
          counterparty: { type: 'self', name: 'self' },
          dedupKey: 'slice1-smoke-note-1',
        });
      expect(res.status).toBe(200);
      expect(res.body.id).toMatch(/^[0-9a-f]{12}$/);
      expect(typeof res.body.t).toBe('string');
    });

    it('flips hasWritten on the registration after successful append', async () => {
      const reg = registry._getRegistrationForTest(sessionId);
      expect(reg?.hasWritten).toBe(true);
    });

    it('accepts decision kind', async () => {
      const res = await request(app)
        .post('/shared-state/append')
        .set(headers())
        .send({
          kind: 'decision',
          subject: 'picked slice-1 scope',
          counterparty: { type: 'self', name: 'self' },
          dedupKey: 'slice1-decision-1',
        });
      expect(res.status).toBe(200);
    });

    it('accepts agreement kind', async () => {
      const res = await request(app)
        .post('/shared-state/append')
        .set(headers())
        .send({
          kind: 'agreement',
          subject: 'agreed to sliced approach',
          counterparty: { type: 'user', name: 'justin' },
          dedupKey: 'slice1-agreement-1',
        });
      expect(res.status).toBe(200);
    });

    it('returns 501 on commitment kind (deferred to slice 3)', async () => {
      const res = await request(app)
        .post('/shared-state/append')
        .set(headers())
        .send({
          kind: 'commitment',
          subject: 'x',
          counterparty: { type: 'self', name: 'self' },
          dedupKey: 'slice1-comm-1',
        });
      expect(res.status).toBe(501);
      expect(res.headers['x-pending-slice']).toBe('3');
    });

    it('returns 400 on thread-* kinds (reserved for server emitters)', async () => {
      for (const k of ['thread-opened', 'thread-closed', 'thread-abandoned']) {
        const res = await request(app)
          .post('/shared-state/append')
          .set(headers())
          .send({
            kind: k,
            subject: 'x',
            counterparty: { type: 'self', name: 'self' },
            dedupKey: `slice1-${k}`,
          });
        expect(res.status).toBe(400);
      }
    });

    it('returns 401 on missing session headers', async () => {
      const res = await request(app)
        .post('/shared-state/append')
        .set(AUTH)
        .send({
          kind: 'note',
          subject: 'x',
          counterparty: { type: 'self', name: 'self' },
          dedupKey: 'slice1-no-session',
        });
      expect(res.status).toBe(401);
    });

    it('returns 401 on invalid session token', async () => {
      const res = await request(app)
        .post('/shared-state/append')
        .set(AUTH)
        .set('X-Instar-Session-Id', sessionId)
        .set('X-Instar-Session-Token', 'a'.repeat(64))
        .send({
          kind: 'note',
          subject: 'x',
          counterparty: { type: 'self', name: 'self' },
          dedupKey: 'slice1-wrong-token',
        });
      expect(res.status).toBe(401);
    });

    it('returns 400 when client supplies server-bound fields', async () => {
      for (const field of [
        'commitment',
        'provenance',
        'emittedBy',
        'source',
        'id',
        't',
      ]) {
        const body: Record<string, unknown> = {
          kind: 'note',
          subject: 'x',
          counterparty: { type: 'self', name: 'self' },
          dedupKey: `slice1-forbid-${field}`,
        };
        body[field] = 'forbidden';
        const res = await request(app)
          .post('/shared-state/append')
          .set(headers())
          .send(body);
        expect(res.status).toBe(400);
        expect(res.headers['x-invalid-field']).toBe(field);
      }
    });

    it('returns 400 on oversize subject', async () => {
      const res = await request(app)
        .post('/shared-state/append')
        .set(headers())
        .send({
          kind: 'note',
          subject: 'x'.repeat(201),
          counterparty: { type: 'self', name: 'self' },
          dedupKey: 'slice1-oversize',
        });
      expect(res.status).toBe(400);
    });

    it('returns 400 on malformed dedupKey', async () => {
      const res = await request(app)
        .post('/shared-state/append')
        .set(headers())
        .send({
          kind: 'note',
          subject: 'x',
          counterparty: { type: 'self', name: 'self' },
          dedupKey: 'has spaces',
        });
      expect(res.status).toBe(400);
      expect(res.headers['x-invalid-field']).toBe('dedupKey');
    });

    it('appended entries appear in /shared-state/recent with session subsystem', async () => {
      const res = await request(app).get('/shared-state/recent').set(AUTH);
      expect(res.status).toBe(200);
      const sessionEntries = (res.body.entries as any[]).filter(
        (e) => e.emittedBy?.subsystem === 'session'
      );
      expect(sessionEntries.length).toBeGreaterThan(0);
      expect(sessionEntries[0].provenance).toBe('session-asserted');
    });
  });
});
