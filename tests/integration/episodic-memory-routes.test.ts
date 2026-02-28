/**
 * Integration tests for Episodic Memory (Activity Sentinel) API routes.
 *
 * Tests the full HTTP pipeline:
 *   HTTP request -> Express route -> SessionActivitySentinel -> EpisodicMemory -> Filesystem -> Response
 *
 * No mocking of EpisodicMemory or filesystem. We mock only the SessionManager
 * and IntelligenceProvider (to avoid spawning tmux/LLM calls).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SessionActivitySentinel } from '../../src/monitoring/SessionActivitySentinel.js';
import { EpisodicMemory } from '../../src/memory/EpisodicMemory.js';
import {
  createTempProject,
  createMockSessionManager,
} from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig, IntelligenceProvider } from '../../src/core/types.js';

describe('Episodic Memory API (integration)', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let sentinel: SessionActivitySentinel;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'episodic-test-token';

  /** Create an intelligence provider that returns controlled JSON responses. */
  function createMockIntelligence(): IntelligenceProvider {
    return {
      evaluate: vi.fn(async () => JSON.stringify({
        summary: 'Built and tested the episodic memory module.',
        actions: ['wrote tests', 'wired routes'],
        learnings: ['Partition boundaries matter for test stability'],
        significance: 7,
        themes: ['testing', 'memory'],
      })),
    };
  }

  beforeAll(async () => {
    project = createTempProject();

    fs.writeFileSync(
      path.join(project.stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'episodic-test', agentName: 'Episodic Test Agent' }),
    );

    mockSM = createMockSessionManager();
    const intelligence = createMockIntelligence();

    // Create sentinel with real EpisodicMemory, mock intelligence
    sentinel = new SessionActivitySentinel({
      stateDir: project.stateDir,
      intelligence,
      getActiveSessions: () => mockSM.listRunningSessions(),
      captureSessionOutput: (tmux) => mockSM.captureOutput(tmux),
    });

    // Pre-seed episodic data for query routes
    const memory = sentinel.getEpisodicMemory();
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Seed two digests in session-A
    memory.saveDigest({
      sessionId: 'session-A',
      sessionName: 'test-session-A',
      startedAt: hourAgo.toISOString(),
      endedAt: now.toISOString(),
      summary: 'Refactored the deployment pipeline for faster builds.',
      actions: ['updated webpack config', 'removed dead code'],
      entities: [],
      learnings: ['Tree-shaking removes 30% of bundle'],
      significance: 6,
      themes: ['deployment', 'performance'],
      boundarySignal: 'task_complete',
    });

    memory.saveDigest({
      sessionId: 'session-A',
      sessionName: 'test-session-A',
      startedAt: dayAgo.toISOString(),
      endedAt: hourAgo.toISOString(),
      summary: 'Investigated memory leak in the scheduler.',
      actions: ['profiled heap', 'found leaked interval'],
      entities: [],
      learnings: ['Always clear intervals in cleanup'],
      significance: 8,
      themes: ['debugging', 'scheduler'],
      boundarySignal: 'topic_shift',
    });

    // Seed a synthesis for session-A
    memory.saveSynthesis({
      sessionId: 'session-A',
      sessionName: 'test-session-A',
      startedAt: dayAgo.toISOString(),
      endedAt: now.toISOString(),
      activityDigestIds: [],
      summary: 'Full session working on deployment and debugging.',
      keyOutcomes: ['Fixed memory leak', 'Faster builds'],
      allEntities: [],
      allLearnings: ['Tree-shaking', 'Clear intervals'],
      significance: 7,
      themes: ['deployment', 'debugging'],
    });

    // Seed a synthesis for session-B (for list/filter testing)
    memory.saveSynthesis({
      sessionId: 'session-B',
      sessionName: 'test-session-B',
      startedAt: dayAgo.toISOString(),
      endedAt: hourAgo.toISOString(),
      activityDigestIds: [],
      summary: 'Wrote documentation for the API.',
      keyOutcomes: ['API docs complete'],
      allEntities: [],
      allLearnings: [],
      significance: 4,
      themes: ['documentation'],
    });

    const config: InstarConfig = {
      projectName: 'episodic-test',
      agentName: 'Episodic Test Agent',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
    };

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
      activitySentinel: sentinel,
    });

    app = server.getApp();
  });

  afterAll(() => {
    project?.cleanup();
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  // ── GET /episodes/stats ──────────────────────────────────────

  describe('GET /episodes/stats', () => {
    it('returns stats with correct counts', async () => {
      const res = await request(app)
        .get('/episodes/stats')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.totalDigests).toBe(2);
      expect(res.body.totalSyntheses).toBe(2);
      expect(res.body.sessionCount).toBe(1); // Only session-A has digests
      expect(res.body.totalPending).toBe(0);
    });
  });

  // ── GET /episodes/sessions ──────────────────────────────────

  describe('GET /episodes/sessions', () => {
    it('lists all syntheses', async () => {
      const res = await request(app)
        .get('/episodes/sessions')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      // Should be ordered by startedAt descending (newest first)
      expect(res.body[0].sessionName).toBeDefined();
    });

    it('respects limit parameter', async () => {
      const res = await request(app)
        .get('/episodes/sessions')
        .set(auth())
        .query({ limit: 1 });

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });
  });

  // ── GET /episodes/sessions/:sessionId ────────────────────────

  describe('GET /episodes/sessions/:sessionId', () => {
    it('returns a specific session synthesis', async () => {
      const res = await request(app)
        .get('/episodes/sessions/session-A')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.sessionId).toBe('session-A');
      expect(res.body.summary).toContain('deployment');
      expect(res.body.keyOutcomes).toBeInstanceOf(Array);
    });

    it('returns 404 for non-existent session', async () => {
      const res = await request(app)
        .get('/episodes/sessions/non-existent')
        .set(auth());

      expect(res.status).toBe(404);
    });
  });

  // ── GET /episodes/sessions/:sessionId/activities ──────────────

  describe('GET /episodes/sessions/:sessionId/activities', () => {
    it('returns activity digests for a session', async () => {
      const res = await request(app)
        .get('/episodes/sessions/session-A/activities')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      // Should be ordered by startedAt ascending
      for (const digest of res.body) {
        expect(digest.sessionId).toBe('session-A');
        expect(digest.summary).toBeTruthy();
      }
    });

    it('returns empty array for session with no activities', async () => {
      const res = await request(app)
        .get('/episodes/sessions/session-B/activities')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });
  });

  // ── GET /episodes/recent ──────────────────────────────────────

  describe('GET /episodes/recent', () => {
    it('returns recent digests with default params', async () => {
      const res = await request(app)
        .get('/episodes/recent')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      for (const digest of res.body) {
        expect(digest.summary).toBeTruthy();
      }
    });

    it('respects hours and limit parameters', async () => {
      const res = await request(app)
        .get('/episodes/recent')
        .set(auth())
        .query({ hours: 2, limit: 1 });

      expect(res.status).toBe(200);
      expect(res.body.length).toBeLessThanOrEqual(1);
    });
  });

  // ── GET /episodes/themes/:theme ───────────────────────────────

  describe('GET /episodes/themes/:theme', () => {
    it('returns digests matching a theme', async () => {
      const res = await request(app)
        .get('/episodes/themes/deployment')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      for (const digest of res.body) {
        expect(digest.themes.some((t: string) => t.toLowerCase().includes('deployment'))).toBe(true);
      }
    });

    it('returns empty for unmatched theme', async () => {
      const res = await request(app)
        .get('/episodes/themes/quantum-physics')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });
  });

  // ── POST /episodes/scan ───────────────────────────────────────

  describe('POST /episodes/scan', () => {
    it('triggers a scan and returns report', async () => {
      // No active sessions — scan should still work, just scan 0
      const res = await request(app)
        .post('/episodes/scan')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.scannedAt).toBeTruthy();
      expect(res.body.sessionsScanned).toBe(0);
      expect(res.body.digestsCreated).toBe(0);
    });

    it('scans active sessions and creates digests', async () => {
      // Spawn a mock session with substantial output
      const longOutput = [
        'Running test suite...',
        'Test 1: EpisodicMemory CRUD operations - PASSED',
        'Test 2: ActivityPartitioner boundary detection - PASSED',
        'Test 3: SessionActivitySentinel scan lifecycle - PASSED',
        'All 3 tests passed in 4.2s',
        '',
        'git add tests/unit/episodic-memory.test.ts',
        'git commit -m "feat(memory): add episodic memory unit tests"',
        '[main abc1234] feat(memory): add episodic memory unit tests',
        ' 1 file changed, 350 insertions(+)',
        '',
        'Now working on integration tests for the HTTP routes.',
        'Reading the E2E testing standard for the correct patterns.',
        'Creating tests/integration/episodic-memory-routes.test.ts...',
      ].join('\n');

      const session = await mockSM.spawnSession({
        name: 'test-scan-session',
        prompt: 'Work on episodic memory',
      });

      // Override captureOutput for this specific session
      mockSM.captureOutput = (tmux: string) => {
        if (tmux === session.tmuxSession) return longOutput;
        return 'mock output';
      };

      const res = await request(app)
        .post('/episodes/scan')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.sessionsScanned).toBe(1);
      // The intelligence mock returns valid JSON, so a digest should be created
      expect(res.body.digestsCreated).toBeGreaterThanOrEqual(1);

      // Clean up: kill the session
      mockSM.killSession(session.id);
    });
  });

  // ── 503 when sentinel not wired ────────────────────────────────

  describe('503 when sentinel not configured', () => {
    let bareApp: ReturnType<AgentServer['getApp']>;

    beforeAll(() => {
      const config: InstarConfig = {
        projectName: 'bare-test',
        agentName: 'Bare Agent',
        projectDir: project.dir,
        stateDir: project.stateDir,
        port: 0,
        authToken: AUTH_TOKEN,
      };

      const bareServer = new AgentServer({
        config,
        sessionManager: mockSM as any,
        state: project.state,
        // No activitySentinel — this is the point
      });

      bareApp = bareServer.getApp();
    });

    it('GET /episodes/stats returns 503', async () => {
      const res = await request(bareApp)
        .get('/episodes/stats')
        .set(auth());
      expect(res.status).toBe(503);
    });

    it('GET /episodes/sessions returns 503', async () => {
      const res = await request(bareApp)
        .get('/episodes/sessions')
        .set(auth());
      expect(res.status).toBe(503);
    });

    it('POST /episodes/scan returns 503', async () => {
      const res = await request(bareApp)
        .post('/episodes/scan')
        .set(auth());
      expect(res.status).toBe(503);
    });
  });

  // ── Authentication ───────────────────────────────────────────

  describe('authentication', () => {
    it('rejects requests without auth token', async () => {
      const res = await request(app).get('/episodes/stats');
      expect(res.status).toBe(401);
    });
  });
});
