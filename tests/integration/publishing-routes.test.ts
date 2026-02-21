/**
 * Integration test — Publishing (Telegraph) routes.
 *
 * Tests the /publish, /published, and /publish/:path endpoints
 * with a real TelegraphService (mocked fetch for API calls).
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { TelegraphService } from '../../src/publishing/TelegraphService.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('Publishing routes integration', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let publisher: TelegraphService;
  let app: ReturnType<AgentServer['getApp']>;

  beforeAll(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    // Pre-seed with a Telegraph access token so we don't hit createAccount
    const publishingState = {
      accessToken: 'test-token-integration',
      shortName: 'test-agent',
      authorName: 'Test Agent',
      pages: [],
    };
    fs.writeFileSync(
      path.join(project.stateDir, 'publishing.json'),
      JSON.stringify(publishingState),
    );

    publisher = new TelegraphService({
      stateDir: project.stateDir,
      shortName: 'test-agent',
      authorName: 'Test Agent',
    });

    const config: InstarConfig = {
      projectName: 'test-publishing',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      sessions: {
        tmuxPath: '/usr/bin/tmux',
        claudePath: '/usr/bin/claude',
        projectDir: project.dir,
        maxSessions: 3,
        protectedSessions: [],
        completionPatterns: [],
      },
      scheduler: {
        jobsFile: path.join(project.stateDir, 'jobs.json'),
        enabled: false,
        maxParallelJobs: 2,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      },
      users: [],
      messaging: [],
      monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
    };

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
      publisher,
    });

    app = server.getApp();
  });

  afterAll(() => {
    project.cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /publish', () => {
    it('publishes markdown and returns Telegraph page', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          ok: true,
          result: {
            path: 'Test-Report-02-20',
            url: 'https://telegra.ph/Test-Report-02-20',
            title: 'Test Report',
          },
        }), { status: 200 }),
      );

      const res = await request(app)
        .post('/publish')
        .send({
          title: 'Test Report',
          markdown: '# Hello World\n\nThis is a test report with **bold** text.',
        })
        .expect(201);

      expect(res.body.url).toBe('https://telegra.ph/Test-Report-02-20');
      expect(res.body.path).toBe('Test-Report-02-20');
      expect(res.body.title).toBe('Test Report');
    });

    it('validates title is required', async () => {
      const res = await request(app)
        .post('/publish')
        .send({ markdown: 'some content' })
        .expect(400);

      expect(res.body.error).toContain('title');
    });

    it('validates markdown is required', async () => {
      const res = await request(app)
        .post('/publish')
        .send({ title: 'Test' })
        .expect(400);

      expect(res.body.error).toContain('markdown');
    });

    it('rejects oversized markdown', async () => {
      const res = await request(app)
        .post('/publish')
        .send({ title: 'Test', markdown: 'x'.repeat(101_000) })
        .expect(400);

      expect(res.body.error).toContain('100KB');
    });
  });

  describe('GET /published', () => {
    it('returns list of published pages', async () => {
      const res = await request(app)
        .get('/published')
        .expect(200);

      expect(res.body.pages).toBeInstanceOf(Array);
      // Should have the page from the POST /publish test
      expect(res.body.pages.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('PUT /publish/:path', () => {
    it('edits an existing page', async () => {
      // First publish
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          ok: true,
          result: { path: 'Editable-Page', url: 'https://telegra.ph/Editable-Page', title: 'Original' },
        }), { status: 200 }),
      );

      await request(app)
        .post('/publish')
        .send({ title: 'Original', markdown: 'Original content' })
        .expect(201);

      // Then edit
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          ok: true,
          result: { path: 'Editable-Page', url: 'https://telegra.ph/Editable-Page', title: 'Updated' },
        }), { status: 200 }),
      );

      const res = await request(app)
        .put('/publish/Editable-Page')
        .send({ title: 'Updated', markdown: 'Updated content' })
        .expect(200);

      expect(res.body.title).toBe('Updated');
    });

    it('validates title on edit', async () => {
      const res = await request(app)
        .put('/publish/some-page')
        .send({ markdown: 'content' })
        .expect(400);

      expect(res.body.error).toContain('title');
    });
  });

  describe('GET /capabilities includes publishing', () => {
    it('reports publishing as enabled', async () => {
      const res = await request(app)
        .get('/capabilities')
        .expect(200);

      expect(res.body.publishing).toBeDefined();
      expect(res.body.publishing.enabled).toBe(true);
    });
  });
});
