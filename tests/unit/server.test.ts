import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { AgentKitConfig } from '../../src/core/types.js';

describe('AgentServer', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  const fakeConfig: AgentKitConfig = {
    projectName: 'test-project',
    projectDir: '/tmp/test',
    stateDir: '/tmp/test/.agent-kit',
    port: 0, // not actually listening in tests
    sessions: {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/bin/claude',
      projectDir: '/tmp/test',
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: [],
    },
    scheduler: {
      jobsFile: '',
      enabled: false,
      maxParallelJobs: 2,
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

  beforeAll(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    server = new AgentServer({
      config: fakeConfig,
      sessionManager: mockSM as any,
      state: project.state,
    });
    app = server.getApp();
  });

  afterAll(() => {
    project.cleanup();
  });

  describe('GET /health', () => {
    it('returns ok status', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.project).toBe('test-project');
      expect(res.body).toHaveProperty('uptime');
      expect(res.body).toHaveProperty('uptimeHuman');
      expect(res.body).toHaveProperty('version');
    });
  });

  describe('GET /status', () => {
    it('returns session and scheduler info', async () => {
      const res = await request(app).get('/status');
      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveProperty('running');
      expect(res.body.sessions).toHaveProperty('max');
      expect(res.body.scheduler).toBeNull(); // No scheduler provided
    });
  });

  describe('GET /sessions', () => {
    it('returns empty array when no sessions', async () => {
      const res = await request(app).get('/sessions');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('GET /sessions/:name/output', () => {
    it('returns output for valid session', async () => {
      // captureOutput returns 'mock output' for any session
      const res = await request(app).get('/sessions/test-session/output');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('output');
    });
  });

  describe('POST /sessions/:name/input', () => {
    it('rejects missing text', async () => {
      const res = await request(app)
        .post('/sessions/test-session/input')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('text');
    });

    it('returns 404 for non-running session', async () => {
      // sendInput returns false when session not in aliveSet
      const res = await request(app)
        .post('/sessions/nonexistent/input')
        .send({ text: 'hello' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /sessions/spawn', () => {
    it('rejects missing required fields', async () => {
      const res = await request(app)
        .post('/sessions/spawn')
        .send({ name: 'test' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });
  });

  describe('GET /jobs', () => {
    it('returns empty when no scheduler', async () => {
      const res = await request(app).get('/jobs');
      expect(res.status).toBe(200);
      expect(res.body.jobs).toEqual([]);
      expect(res.body.scheduler).toBeNull();
    });
  });

  describe('POST /jobs/:slug/trigger', () => {
    it('returns 503 when no scheduler', async () => {
      const res = await request(app)
        .post('/jobs/test-job/trigger')
        .send({});
      expect(res.status).toBe(503);
    });
  });

  describe('GET /events', () => {
    it('returns events', async () => {
      project.state.appendEvent({
        type: 'test',
        summary: 'Test event',
        timestamp: new Date().toISOString(),
      });

      const res = await request(app).get('/events');
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('error handling', () => {
    it('DELETE /sessions/:id returns 404 for unknown session', async () => {
      const res = await request(app).delete('/sessions/nonexistent');
      expect(res.status).toBe(404);
    });
  });
});
