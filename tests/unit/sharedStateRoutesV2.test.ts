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

    it('returns 400 on commitment kind without commitment object (slice 3 opened the path)', async () => {
      const res = await request(app)
        .post('/shared-state/append')
        .set(headers())
        .send({
          kind: 'commitment',
          subject: 'x',
          counterparty: { type: 'self', name: 'self' },
          dedupKey: 'slice1-comm-1',
        });
      // Slice 3: commitment kind now accepted, but requires `commitment` field.
      expect(res.status).toBe(400);
      expect(res.headers['x-invalid-field']).toBe('commitment');
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

  describe('commitment kind (slice 3)', () => {
    let sid: string;
    let tok: string;

    beforeAll(async () => {
      sid = uuid();
      const b = await request(app).post('/shared-state/session-bind').set(AUTH).send({ sessionId: sid });
      tok = b.body.token;
    });

    const h = () => ({
      ...AUTH,
      'X-Instar-Session-Id': sid,
      'X-Instar-Session-Token': tok,
    });

    const deadlineIn = (secsFromNow: number) =>
      new Date(Date.now() + secsFromNow * 1000).toISOString();

    it('accepts a scheduled-job commitment with deadline + ref', async () => {
      const res = await request(app)
        .post('/shared-state/append')
        .set(h())
        .send({
          kind: 'commitment',
          subject: 'call Dawn back when her response lands',
          counterparty: { type: 'agent', name: 'dawn' },
          dedupKey: 'slice3-commit-sched-1',
          commitment: {
            mechanism: { type: 'scheduled-job', ref: 'job-42' },
            deadline: deadlineIn(3600),
          },
        });
      expect(res.status).toBe(200);
      expect(res.body.id).toMatch(/^[0-9a-f]{12}$/);
    });

    it('accepts a passive-wait commitment only when deadline present', async () => {
      const noDeadline = await request(app)
        .post('/shared-state/append')
        .set(h())
        .send({
          kind: 'commitment',
          subject: 'wait for ping',
          counterparty: { type: 'self', name: 'self' },
          dedupKey: 'slice3-pw-nodl',
          commitment: { mechanism: { type: 'passive-wait' } },
        });
      expect(noDeadline.status).toBe(400);
      expect(noDeadline.headers['x-invalid-field']).toBe('commitment.deadline');

      const withDeadline = await request(app)
        .post('/shared-state/append')
        .set(h())
        .send({
          kind: 'commitment',
          subject: 'wait for ping',
          counterparty: { type: 'self', name: 'self' },
          dedupKey: 'slice3-pw-ok',
          commitment: {
            mechanism: { type: 'passive-wait' },
            deadline: deadlineIn(3600),
          },
        });
      expect(withDeadline.status).toBe(200);
    });

    it('forbids ref on passive-wait', async () => {
      const res = await request(app)
        .post('/shared-state/append')
        .set(h())
        .send({
          kind: 'commitment',
          subject: 'passive with forbidden ref',
          counterparty: { type: 'self', name: 'self' },
          dedupKey: 'slice3-pw-ref',
          commitment: {
            mechanism: { type: 'passive-wait', ref: 'nope' },
            deadline: deadlineIn(3600),
          },
        });
      expect(res.status).toBe(400);
      expect(res.headers['x-invalid-field']).toBe('commitment.mechanism.ref');
    });

    it('rejects past-dated deadline (adversarial spoofing)', async () => {
      const res = await request(app)
        .post('/shared-state/append')
        .set(h())
        .send({
          kind: 'commitment',
          subject: 'deadline in the past',
          counterparty: { type: 'self', name: 'self' },
          dedupKey: 'slice3-past-dl',
          commitment: {
            mechanism: { type: 'scheduled-job' },
            deadline: new Date(Date.now() - 60 * 1000).toISOString(),
          },
        });
      expect(res.status).toBe(400);
      expect(res.headers['x-invalid-field']).toBe('commitment.deadline');
    });

    it('rejects deadline beyond 90 days', async () => {
      const res = await request(app)
        .post('/shared-state/append')
        .set(h())
        .send({
          kind: 'commitment',
          subject: 'far-future deadline',
          counterparty: { type: 'self', name: 'self' },
          dedupKey: 'slice3-far-dl',
          commitment: {
            mechanism: { type: 'scheduled-job' },
            deadline: deadlineIn(91 * 24 * 60 * 60),
          },
        });
      expect(res.status).toBe(400);
    });

    it('rejects bad mechanism.type', async () => {
      const res = await request(app)
        .post('/shared-state/append')
        .set(h())
        .send({
          kind: 'commitment',
          subject: 'bad mech',
          counterparty: { type: 'self', name: 'self' },
          dedupKey: 'slice3-bad-mech',
          commitment: {
            mechanism: { type: 'magic-future' },
            deadline: deadlineIn(3600),
          },
        });
      expect(res.status).toBe(400);
      expect(res.headers['x-invalid-field']).toBe('commitment.mechanism.type');
    });

    it('rejects client-supplied commitment.status and commitment.resolution', async () => {
      const r1 = await request(app)
        .post('/shared-state/append')
        .set(h())
        .send({
          kind: 'commitment',
          subject: 'tries to resolve on create',
          counterparty: { type: 'self', name: 'self' },
          dedupKey: 'slice3-status-supply',
          commitment: {
            mechanism: { type: 'scheduled-job' },
            deadline: deadlineIn(3600),
            status: 'resolved',
          },
        });
      expect(r1.status).toBe(400);

      const r2 = await request(app)
        .post('/shared-state/append')
        .set(h())
        .send({
          kind: 'commitment',
          subject: 'tries to resolution-stuff on create',
          counterparty: { type: 'self', name: 'self' },
          dedupKey: 'slice3-res-supply',
          commitment: {
            mechanism: { type: 'scheduled-job' },
            deadline: deadlineIn(3600),
            resolution: { at: new Date().toISOString(), by: 'self-asserted' },
          },
        });
      expect(r2.status).toBe(400);
    });

    it('appended commitment renders with server-bound fields', async () => {
      const res = await request(app).get('/shared-state/recent').set(AUTH);
      const commits = (res.body.entries as any[]).filter((e) => e.kind === 'commitment');
      expect(commits.length).toBeGreaterThan(0);
      const latest = commits[0];
      // Server-bound fields present:
      expect(latest.provenance).toBe('session-asserted');
      expect(latest.emittedBy.subsystem).toBe('session');
      expect(latest.commitment.status).toBe('open');
      expect(latest.commitment.mechanism.refStatus).toBe('unverified');
      expect(typeof latest.commitment.mechanism.refResolvedAt).toBe('string');
    });
  });

  describe('rate limits (slice 3)', () => {
    it('429 on per-session-open-commitments cap', async () => {
      // Fresh agent/app with a tiny open-commitments cap.
      const p = createTempProject();
      const cfg = baseConfig(p.stateDir);
      cfg.integratedBeing = {
        enabled: true,
        v2Enabled: true,
        openCommitmentsPerSession: 2,
        sessionWriteRatePerMinute: 1000,
      };
      const l = new SharedStateLedger({ stateDir: p.stateDir, config: cfg.integratedBeing, salt: 's' });
      const r = new LedgerSessionRegistry({ stateDir: p.stateDir, config: cfg.integratedBeing });
      const s = new AgentServer({
        config: cfg,
        sessionManager: createMockSessionManager() as any,
        state: p.state,
        sharedStateLedger: l,
        ledgerSessionRegistry: r,
      });
      const a = s.getApp();

      const sid2 = uuid();
      const b = await request(a).post('/shared-state/session-bind').set(AUTH).send({ sessionId: sid2 });
      const tok2 = b.body.token;
      const headers2 = { ...AUTH, 'X-Instar-Session-Id': sid2, 'X-Instar-Session-Token': tok2 };

      const make = (n: number) =>
        request(a).post('/shared-state/append').set(headers2).send({
          kind: 'commitment',
          subject: `c${n}`,
          counterparty: { type: 'self', name: 'self' },
          dedupKey: `slice3-cap-${n}`,
          commitment: {
            mechanism: { type: 'scheduled-job' },
            deadline: new Date(Date.now() + 3600 * 1000).toISOString(),
          },
        });

      expect((await make(1)).status).toBe(200);
      expect((await make(2)).status).toBe(200);
      const over = await make(3);
      expect(over.status).toBe(429);
      expect(over.headers['x-cap-reason']).toBe('over-open-commitments');

      l.shutdown();
      p.cleanup();
    });

    it('429 on per-session write rate', async () => {
      const p = createTempProject();
      const cfg = baseConfig(p.stateDir);
      cfg.integratedBeing = {
        enabled: true,
        v2Enabled: true,
        sessionWriteRatePerMinute: 2,
      };
      const l = new SharedStateLedger({ stateDir: p.stateDir, config: cfg.integratedBeing, salt: 's' });
      const r = new LedgerSessionRegistry({ stateDir: p.stateDir, config: cfg.integratedBeing });
      const s = new AgentServer({
        config: cfg,
        sessionManager: createMockSessionManager() as any,
        state: p.state,
        sharedStateLedger: l,
        ledgerSessionRegistry: r,
      });
      const a = s.getApp();

      const sid3 = uuid();
      const b = await request(a).post('/shared-state/session-bind').set(AUTH).send({ sessionId: sid3 });
      const tok3 = b.body.token;
      const hh = { ...AUTH, 'X-Instar-Session-Id': sid3, 'X-Instar-Session-Token': tok3 };

      const note = (n: number) =>
        request(a).post('/shared-state/append').set(hh).send({
          kind: 'note',
          subject: `n${n}`,
          counterparty: { type: 'self', name: 'self' },
          dedupKey: `slice3-rate-${n}`,
        });

      expect((await note(1)).status).toBe(200);
      expect((await note(2)).status).toBe(200);
      const over = await note(3);
      expect(over.status).toBe(429);
      expect(over.headers['x-cap-reason']).toBe('over-session-rate');

      l.shutdown();
      p.cleanup();
    });
  });

  describe('session-bind-confirm (slice 2)', () => {
    it('clears hook-in-progress flag', async () => {
      const sid = uuid();
      await request(app).post('/shared-state/session-bind').set(AUTH).send({ sessionId: sid });
      // Flag should be set now.
      expect(registry.isHookInProgress(sid)).toBe(true);
      const res = await request(app)
        .post('/shared-state/session-bind-confirm')
        .set(AUTH)
        .send({ sessionId: sid });
      expect(res.status).toBe(200);
      expect(res.body.confirmed).toBe(true);
      expect(registry.isHookInProgress(sid)).toBe(false);
    });

    it('400 on missing sessionId', async () => {
      const res = await request(app)
        .post('/shared-state/session-bind-confirm')
        .set(AUTH)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('session-bind-interactive (slice 2)', () => {
    it('403 when no hook-in-progress flag is set', async () => {
      const sid = uuid();
      const res = await request(app)
        .post('/shared-state/session-bind-interactive')
        .set(AUTH)
        .send({ sessionId: sid });
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('attestation-missing');
    });

    it('403 when the flag has been cleared (e.g. via confirm)', async () => {
      const sid = uuid();
      // Bind + confirm — this is the happy path. Hook-in-progress flag now cleared.
      await request(app).post('/shared-state/session-bind').set(AUTH).send({ sessionId: sid });
      await request(app).post('/shared-state/session-bind-confirm').set(AUTH).send({ sessionId: sid });
      const res = await request(app)
        .post('/shared-state/session-bind-interactive')
        .set(AUTH)
        .send({ sessionId: sid });
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('attestation-missing');
    });

    it('200 after session-bind when the file-handoff failed (flag still set)', async () => {
      // Models the real lifecycle: session-bind succeeds (registers + sets
      // flag + mints token), hook fails to write the token file (mode mismatch,
      // read-only FS, etc.), then the session falls back to interactive.
      // Interactive should re-issue a fresh token against the existing
      // registration and clear the flag.
      const sid = uuid();
      const bindRes = await request(app)
        .post('/shared-state/session-bind')
        .set(AUTH)
        .send({ sessionId: sid });
      const origToken = bindRes.body.token;

      const res = await request(app)
        .post('/shared-state/session-bind-interactive')
        .set(AUTH)
        .send({ sessionId: sid });
      expect(res.status).toBe(200);
      expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
      // Re-issued token must be different from the original, and the original
      // must no longer verify — the hash was replaced.
      expect(res.body.token).not.toBe(origToken);
      // Flag cleared — a replay attempt returns 403.
      const replay = await request(app)
        .post('/shared-state/session-bind-interactive')
        .set(AUTH)
        .send({ sessionId: sid });
      expect(replay.status).toBe(403);
      expect(replay.body.reason).toBe('attestation-missing');
    });
  });

  describe('session-bind-rotate (slice 2)', () => {
    it('200 with new token on valid current token', async () => {
      const sid = uuid();
      const bind = await request(app)
        .post('/shared-state/session-bind')
        .set(AUTH)
        .send({ sessionId: sid });
      const origToken = bind.body.token;

      const rot = await request(app)
        .post('/shared-state/session-bind-rotate')
        .set({ ...AUTH, 'X-Instar-Session-Token': origToken })
        .send({ sessionId: sid });
      expect(rot.status).toBe(200);
      expect(rot.body.token).toMatch(/^[0-9a-f]{64}$/);
      expect(rot.body.token).not.toBe(origToken);
    });

    it('401 on wrong current token', async () => {
      const sid = uuid();
      await request(app).post('/shared-state/session-bind').set(AUTH).send({ sessionId: sid });
      const rot = await request(app)
        .post('/shared-state/session-bind-rotate')
        .set({ ...AUTH, 'X-Instar-Session-Token': 'a'.repeat(64) })
        .send({ sessionId: sid });
      expect(rot.status).toBe(401);
    });

    it('400 on missing sessionId or header', async () => {
      const r1 = await request(app)
        .post('/shared-state/session-bind-rotate')
        .set({ ...AUTH, 'X-Instar-Session-Token': 'x'.repeat(64) })
        .send({});
      expect(r1.status).toBe(400);

      const r2 = await request(app)
        .post('/shared-state/session-bind-rotate')
        .set(AUTH)
        .send({ sessionId: uuid() });
      expect(r2.status).toBe(400);
    });
  });
});
