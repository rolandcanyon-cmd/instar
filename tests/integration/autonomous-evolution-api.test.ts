/**
 * Integration test — Autonomous Evolution API routes via HTTP.
 *
 * Tests sidecar management, evaluation, notification, and revert APIs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import { AutonomousEvolution } from '../../src/core/AutonomousEvolution.js';
import { AutonomyProfileManager } from '../../src/core/AutonomyProfileManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { TrustElevationTracker } from '../../src/core/TrustElevationTracker.js';
import type { InstarConfig } from '../../src/core/types.js';
import express from 'express';
import { createRoutes } from '../../src/server/routes.js';
import type { Server } from 'node:http';

let project: TempProject;
let server: Server;
let baseUrl: string;

describe('Autonomous Evolution API Routes (integration)', () => {
  beforeAll(async () => {
    project = createTempProject();
    const config: InstarConfig = {
      projectDir: project.dir,
      stateDir: project.stateDir,
      projectName: 'test-project',
      agentName: 'test-agent',
      autonomyProfile: 'autonomous',
    } as InstarConfig;
    const state = new StateManager(project.stateDir);

    const autonomyManager = new AutonomyProfileManager({
      stateDir: project.stateDir,
      config,
    });

    const autonomousEvolution = new AutonomousEvolution({
      stateDir: project.stateDir,
      enabled: true,
    });

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
      workingMemory: null,
      quotaManager: null,
      systemReviewer: null,
      capabilityMapper: null,
      topicResumeMap: null,
      autonomyManager,
      trustElevationTracker: new TrustElevationTracker({ stateDir: project.stateDir }),
      autonomousEvolution,
      discoveryEvaluator: null,
      startTime: new Date(),
    });

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
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    project.cleanup();
  });

  // ── GET /autonomy/evolution ────────────────────────────────────

  describe('GET /autonomy/evolution', () => {
    it('returns dashboard', async () => {
      const res = await fetch(`${baseUrl}/autonomy/evolution`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.enabled).toBe(true);
      expect(body.pendingSidecars).toBeInstanceOf(Array);
      expect(body.appliedSidecars).toBeInstanceOf(Array);
      expect(body.notificationQueue).toBeInstanceOf(Array);
    });
  });

  // ── POST /autonomy/evolution/evaluate ──────────────────────────

  describe('POST /autonomy/evolution/evaluate', () => {
    it('auto-implements safe changes in autonomous mode', async () => {
      const res = await fetch(`${baseUrl}/autonomy/evolution/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          review: {
            decision: 'approve',
            reason: 'Looks safe',
            affectedFields: ['definedSteps'],
            confidence: 0.95,
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.action).toBe('auto-implement');
      expect(body.scope).toBe('safe');
      expect(body.autonomousMode).toBe(true);
    });

    it('queues unsafe changes', async () => {
      const res = await fetch(`${baseUrl}/autonomy/evolution/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          review: {
            decision: 'approve',
            reason: 'Schedule change',
            affectedFields: ['schedule'],
            confidence: 0.9,
          },
        }),
      });

      const body = await res.json();
      expect(body.action).toBe('queue-for-approval');
      expect(body.scope).toBe('unsafe');
    });

    it('rejects invalid input', async () => {
      const res = await fetch(`${baseUrl}/autonomy/evolution/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ review: { decision: 'approve' } }),
      });
      expect(res.status).toBe(400);
    });
  });

  // ── POST /autonomy/evolution/sidecar ───────────────────────────

  describe('POST /autonomy/evolution/sidecar', () => {
    it('creates a sidecar', async () => {
      const res = await fetch(`${baseUrl}/autonomy/evolution/sidecar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobSlug: 'health-check',
          proposalId: 'EVO-010',
          changes: { definedSteps: ['check-redis'] },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.created).toBe(true);
      expect(body.sidecar.jobSlug).toBe('health-check');
    });

    it('rejects missing fields', async () => {
      const res = await fetch(`${baseUrl}/autonomy/evolution/sidecar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobSlug: 'test' }),
      });
      expect(res.status).toBe(400);
    });
  });

  // ── POST /autonomy/evolution/sidecar/apply ─────────────────────

  describe('POST /autonomy/evolution/sidecar/apply', () => {
    it('applies a pending sidecar', async () => {
      const res = await fetch(`${baseUrl}/autonomy/evolution/sidecar/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId: 'EVO-010' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.applied).toBe(true);
    });

    it('returns false for non-existent', async () => {
      const res = await fetch(`${baseUrl}/autonomy/evolution/sidecar/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId: 'NONEXISTENT' }),
      });

      const body = await res.json();
      expect(body.applied).toBe(false);
    });
  });

  // ── POST /autonomy/evolution/revert ────────────────────────────

  describe('POST /autonomy/evolution/revert', () => {
    it('reverts an applied sidecar', async () => {
      const res = await fetch(`${baseUrl}/autonomy/evolution/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId: 'EVO-010' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reverted).toBe(true);
    });

    it('rejects missing proposalId', async () => {
      const res = await fetch(`${baseUrl}/autonomy/evolution/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  // ── GET /autonomy/evolution/notifications ──────────────────────

  describe('GET /autonomy/evolution/notifications', () => {
    it('returns notification state', async () => {
      const res = await fetch(`${baseUrl}/autonomy/evolution/notifications`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.pending).toBeInstanceOf(Array);
      expect(body.recentHistory).toBeInstanceOf(Array);
    });
  });

  // ── POST /autonomy/evolution/notifications/drain ───────────────

  describe('POST /autonomy/evolution/notifications/drain', () => {
    it('drains notification queue', async () => {
      const res = await fetch(`${baseUrl}/autonomy/evolution/notifications/drain`, {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.drained).toBe('number');
      expect(body.notifications).toBeInstanceOf(Array);
    });
  });
});
