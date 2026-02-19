import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { RelationshipManager } from '../../src/core/RelationshipManager.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { AgentKitConfig } from '../../src/core/types.js';

describe('Relationship API routes', () => {
  let project: TempProject;
  let relationships: RelationshipManager;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  const fakeConfig: AgentKitConfig = {
    projectName: 'test-project',
    projectDir: '/tmp/test',
    stateDir: '/tmp/test/.agent-kit',
    port: 0,
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
    const relDir = path.join(project.stateDir, 'relationships');

    relationships = new RelationshipManager({
      relationshipsDir: relDir,
      maxRecentInteractions: 20,
    });

    // Seed some test data
    const alice = relationships.findOrCreate('Alice', { type: 'telegram', identifier: '111' });
    relationships.recordInteraction(alice.id, {
      timestamp: new Date().toISOString(),
      channel: 'telegram',
      summary: 'First chat with Alice',
      topics: ['consciousness', 'AI'],
    });
    relationships.updateNotes(alice.id, 'Very thoughtful');

    relationships.findOrCreate('Bob', { type: 'email', identifier: 'bob@test.com' });

    const mockSM = createMockSessionManager();
    server = new AgentServer({
      config: fakeConfig,
      sessionManager: mockSM as any,
      state: project.state,
      relationships,
    });
    app = server.getApp();
  });

  afterAll(() => {
    project.cleanup();
  });

  describe('GET /relationships', () => {
    it('returns all relationships sorted by significance', async () => {
      const res = await request(app).get('/relationships');
      expect(res.status).toBe(200);
      expect(res.body.relationships).toHaveLength(2);
      // Alice has an interaction, so should be first (higher significance)
      expect(res.body.relationships[0].name).toBe('Alice');
    });

    it('supports sort parameter', async () => {
      const res = await request(app).get('/relationships?sort=name');
      expect(res.status).toBe(200);
      expect(res.body.relationships[0].name).toBe('Alice');
      expect(res.body.relationships[1].name).toBe('Bob');
    });
  });

  describe('GET /relationships/:id', () => {
    it('returns a specific relationship', async () => {
      const all = relationships.getAll();
      const alice = all.find(r => r.name === 'Alice')!;

      const res = await request(app).get(`/relationships/${alice.id}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Alice');
      expect(res.body.notes).toBe('Very thoughtful');
    });

    it('returns 404 for unknown id', async () => {
      const res = await request(app).get('/relationships/nonexistent-id');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /relationships/:id/context', () => {
    it('returns relationship context XML', async () => {
      const all = relationships.getAll();
      const alice = all.find(r => r.name === 'Alice')!;

      const res = await request(app).get(`/relationships/${alice.id}/context`);
      expect(res.status).toBe(200);
      expect(res.body.context).toContain('<relationship_context person="Alice">');
      expect(res.body.context).toContain('consciousness');
    });

    it('returns 404 for unknown id', async () => {
      const res = await request(app).get('/relationships/nonexistent-id/context');
      expect(res.status).toBe(404);
    });
  });
});
