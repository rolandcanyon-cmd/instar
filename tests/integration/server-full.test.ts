/**
 * Integration test — full server with all Tier 1 systems wired.
 *
 * Tests the server with relationships, auth, scheduler, and
 * mocked Telegram running together. Verifies cross-system interactions.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { RelationshipManager } from '../../src/core/RelationshipManager.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import {
  createTempProject,
  createMockSessionManager,
  createSampleJobsFile,
} from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { AgentKitConfig } from '../../src/core/types.js';

describe('Full server integration', () => {
  let project: TempProject;
  let relationships: RelationshipManager;
  let scheduler: JobScheduler;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-auth-token-integration';

  beforeAll(() => {
    project = createTempProject();

    // Set up relationships
    const relDir = path.join(project.stateDir, 'relationships');
    fs.mkdirSync(relDir, { recursive: true });
    relationships = new RelationshipManager({
      relationshipsDir: relDir,
      maxRecentInteractions: 20,
    });

    // Seed relationship data
    const alice = relationships.findOrCreate('Alice', { type: 'telegram', identifier: '111' });
    relationships.recordInteraction(alice.id, {
      timestamp: new Date().toISOString(),
      channel: 'telegram',
      summary: 'Integration test chat',
      topics: ['testing', 'CI'],
    });

    const bob = relationships.findOrCreate('Bob', { type: 'email', identifier: 'bob@test.com' });
    relationships.recordInteraction(bob.id, {
      timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
      channel: 'email',
      summary: 'Old email exchange',
      topics: ['philosophy'],
    });
    // Boost Bob's significance enough to appear in stale
    for (let i = 0; i < 5; i++) {
      relationships.recordInteraction(bob.id, {
        timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        channel: 'email',
        summary: `Discussion ${i}`,
        topics: [`topic-${i}`],
      });
    }

    // Set up scheduler
    mockSM = createMockSessionManager();
    const jobsFile = createSampleJobsFile(project.stateDir);
    scheduler = new JobScheduler(
      {
        jobsFile,
        enabled: true,
        maxParallelJobs: 3,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      },
      mockSM as any,
      project.state,
    );
    scheduler.start();

    const config: AgentKitConfig = {
      projectName: 'integration-test',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      sessions: {
        tmuxPath: '/usr/bin/tmux',
        claudePath: '/usr/bin/claude',
        projectDir: project.dir,
        maxSessions: 5,
        protectedSessions: [],
        completionPatterns: [],
      },
      scheduler: {
        jobsFile,
        enabled: true,
        maxParallelJobs: 3,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      },
      users: [],
      messaging: [],
      monitoring: {
        quotaTracking: false,
        memoryMonitoring: false,
        healthCheckIntervalMs: 30000,
      },
      relationships: {
        relationshipsDir: relDir,
        maxRecentInteractions: 20,
      },
    };

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
      scheduler,
      relationships,
    });
    app = server.getApp();
  });

  afterAll(() => {
    scheduler?.stop();
    project.cleanup();
  });

  // ── Auth enforcement ─────────────────────────────────────────

  describe('auth enforcement across all endpoints', () => {
    it('allows /health without auth', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    });

    it('blocks /status without auth', async () => {
      const res = await request(app).get('/status');
      expect(res.status).toBe(401);
    });

    it('blocks /sessions without auth', async () => {
      const res = await request(app).get('/sessions');
      expect(res.status).toBe(401);
    });

    it('blocks /jobs without auth', async () => {
      const res = await request(app).get('/jobs');
      expect(res.status).toBe(401);
    });

    it('blocks /relationships without auth', async () => {
      const res = await request(app).get('/relationships');
      expect(res.status).toBe(401);
    });

    it('blocks /events without auth', async () => {
      const res = await request(app).get('/events');
      expect(res.status).toBe(401);
    });

    it('allows all with valid auth', async () => {
      const auth = { Authorization: `Bearer ${AUTH_TOKEN}` };

      const [health, status, sessions, jobs, rels, events] = await Promise.all([
        request(app).get('/health'),
        request(app).get('/status').set(auth),
        request(app).get('/sessions').set(auth),
        request(app).get('/jobs').set(auth),
        request(app).get('/relationships').set(auth),
        request(app).get('/events').set(auth),
      ]);

      expect(health.status).toBe(200);
      expect(status.status).toBe(200);
      expect(sessions.status).toBe(200);
      expect(jobs.status).toBe(200);
      expect(rels.status).toBe(200);
      expect(events.status).toBe(200);
    });
  });

  // ── Cross-system: status includes scheduler ──────────────────

  describe('cross-system status', () => {
    it('includes scheduler status with job counts', async () => {
      const res = await request(app)
        .get('/status')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.scheduler).not.toBeNull();
      expect(res.body.scheduler.running).toBe(true);
      expect(res.body.scheduler.enabledJobs).toBe(2);
    });
  });

  // ── Cross-system: job trigger + session spawn ────────────────

  describe('job trigger via API', () => {
    it('triggers a job and creates a session', async () => {
      const res = await request(app)
        .post('/jobs/health-check/trigger')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({ reason: 'integration-test' });

      expect(res.status).toBe(200);
      expect(res.body.result).toBe('triggered');
      expect(mockSM._spawnCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Cross-system: relationships + API ────────────────────────

  describe('relationship API with persistence', () => {
    it('GET /relationships returns seeded data with auth', async () => {
      const res = await request(app)
        .get('/relationships')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.relationships).toHaveLength(2);
      const names = res.body.relationships.map((r: any) => r.name);
      expect(names).toContain('Alice');
      expect(names).toContain('Bob');
    });

    it('GET /relationships/:id/context returns enriched context', async () => {
      const alice = relationships.getAll().find(r => r.name === 'Alice')!;
      const res = await request(app)
        .get(`/relationships/${alice.id}/context`)
        .set('Authorization', `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.context).toContain('testing');
      expect(res.body.context).toContain('CI');
      expect(res.body.context).toContain('Integration test chat');
    });

    it('stale endpoint correctly identifies old relationships', async () => {
      const res = await request(app)
        .get('/relationships/stale?days=14')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(200);
      // Bob's last interaction was 30 days ago and significance >= 3
      expect(res.body.stale.length).toBeGreaterThanOrEqual(1);
      expect(res.body.stale.some((r: any) => r.name === 'Bob')).toBe(true);
    });

    it('relationship data persists to new manager instance', async () => {
      const relDir = path.join(project.stateDir, 'relationships');

      // Create a fresh manager from the same directory
      const manager2 = new RelationshipManager({
        relationshipsDir: relDir,
        maxRecentInteractions: 20,
      });

      expect(manager2.getAll()).toHaveLength(2);
      const alice = manager2.resolveByChannel({ type: 'telegram', identifier: '111' });
      expect(alice).not.toBeNull();
      expect(alice!.name).toBe('Alice');
      expect(alice!.recentInteractions).toHaveLength(1);
    });
  });

  // ── Cross-system: events capture scheduler activity ──────────

  describe('event log captures cross-system activity', () => {
    it('events include scheduler_start and job_triggered', async () => {
      const res = await request(app)
        .get('/events?since=1')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(200);
      const types = res.body.map((e: any) => e.type);
      expect(types).toContain('scheduler_start');
    });
  });
});
