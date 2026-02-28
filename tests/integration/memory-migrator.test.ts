/**
 * Integration tests for MemoryMigrator API routes.
 *
 * These tests spin up a REAL AgentServer with SemanticMemory and
 * exercise the full HTTP migration pipeline:
 *
 *   HTTP request → Express route → MemoryMigrator → SemanticMemory → SQLite → response
 *
 * Real filesystem fixtures (MEMORY.md, JSON, JSONL) are created in temp dirs.
 * No mocking of data layers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import {
  createTempProject,
  createMockSessionManager,
} from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('MemoryMigrator API (integration)', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let memory: SemanticMemory;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'migrator-test-token';

  beforeAll(async () => {
    project = createTempProject();

    // Write minimal config
    fs.writeFileSync(
      path.join(project.stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'migrator-test', agentName: 'Migrator Test Agent' }),
    );

    mockSM = createMockSessionManager();

    // Create SemanticMemory with real SQLite
    const dbPath = path.join(project.stateDir, 'semantic.db');
    memory = new SemanticMemory({
      dbPath,
      decayHalfLifeDays: 30,
      lessonDecayHalfLifeDays: 90,
      staleThreshold: 0.2,
    });
    await memory.open();

    const config: InstarConfig = {
      projectName: 'migrator-test',
      agentName: 'Migrator Test Agent',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
    };

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
      semanticMemory: memory,
    });

    app = server.getApp();

    // ── Seed test fixtures ──────────────────────────────────────

    // MEMORY.md in project root
    fs.writeFileSync(
      path.join(project.dir, 'MEMORY.md'),
      `# Agent Memory

## Server Configuration
The server runs on port 3000 locally. Production is on Vercel with auto-deploy from main.

## Database Setup
PostgreSQL on Xata cloud. Always use prisma migrate for schema changes.
`,
    );

    // Quick facts
    fs.writeFileSync(
      path.join(project.stateDir, 'quick-facts.json'),
      JSON.stringify([
        {
          question: 'What is the deploy target?',
          answer: 'Vercel, auto-deploys from main branch.',
          lastVerified: '2026-02-20T00:00:00Z',
          source: 'observation',
        },
      ]),
    );

    // Anti-patterns
    fs.writeFileSync(
      path.join(project.stateDir, 'anti-patterns.json'),
      JSON.stringify([
        {
          id: 'AP-001',
          pattern: 'Deploy without verification',
          consequence: 'Wrong environment',
          alternative: 'Always verify first',
          learnedAt: '2026-02-01T00:00:00Z',
        },
      ]),
    );

    // Project registry
    fs.writeFileSync(
      path.join(project.stateDir, 'project-registry.json'),
      JSON.stringify([
        {
          name: 'TestProject',
          dir: '/tmp/test',
          description: 'A test project',
        },
      ]),
    );

    // Decision journal
    fs.writeFileSync(
      path.join(project.stateDir, 'decision-journal.jsonl'),
      JSON.stringify({
        timestamp: '2026-02-20T10:00:00Z',
        sessionId: 's1',
        decision: 'Use SQLite for storage',
        confidence: 0.9,
      }) + '\n',
    );

    // Relationships
    const relDir = path.join(project.stateDir, 'relationships');
    fs.mkdirSync(relDir, { recursive: true });
    fs.writeFileSync(
      path.join(relDir, 'rel-001.json'),
      JSON.stringify({
        id: 'rel-001',
        name: 'Test Person',
        channels: [],
        firstInteraction: '2026-01-01T00:00:00Z',
        lastInteraction: '2026-02-01T00:00:00Z',
        interactionCount: 10,
        themes: ['testing'],
        notes: 'A test person.',
        significance: 5,
        recentInteractions: [],
      }),
    );
  });

  afterAll(() => {
    memory?.close();
    project?.cleanup();
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  // ─── Full Migration ─────────────────────────────────────────────

  describe('POST /semantic/migrate', () => {
    it('migrates all sources and returns aggregate report', async () => {
      const res = await request(app)
        .post('/semantic/migrate')
        .set(auth())
        .send({
          memoryMdPath: path.join(project.dir, 'MEMORY.md'),
        });

      expect(res.status).toBe(200);
      expect(res.body.totalEntitiesCreated).toBeGreaterThanOrEqual(4);
      expect(res.body.sources).toHaveLength(4);

      const sourceNames = res.body.sources.map((s: any) => s.source);
      expect(sourceNames).toContain('MEMORY.md');
      expect(sourceNames).toContain('relationships');
      expect(sourceNames).toContain('canonical-state');
      expect(sourceNames).toContain('decision-journal');
    });

    it('is idempotent — second run creates no new entities', async () => {
      const res = await request(app)
        .post('/semantic/migrate')
        .set(auth())
        .send({
          memoryMdPath: path.join(project.dir, 'MEMORY.md'),
        });

      expect(res.status).toBe(200);
      expect(res.body.totalEntitiesCreated).toBe(0);
    });
  });

  // ─── Per-Source Migration ───────────────────────────────────────

  describe('POST /semantic/migrate/canonical-state', () => {
    it('migrates canonical state (idempotent after full migration)', async () => {
      const res = await request(app)
        .post('/semantic/migrate/canonical-state')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.source).toBe('canonical-state');
      // Already migrated by the full migration above
      expect(res.body.entitiesSkipped).toBeGreaterThanOrEqual(1);
    });
  });

  describe('POST /semantic/migrate/relationships', () => {
    it('migrates relationships (idempotent after full migration)', async () => {
      const res = await request(app)
        .post('/semantic/migrate/relationships')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.source).toBe('relationships');
    });
  });

  describe('POST /semantic/migrate/decisions', () => {
    it('migrates decision journal (idempotent after full migration)', async () => {
      const res = await request(app)
        .post('/semantic/migrate/decisions')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.source).toBe('decision-journal');
    });
  });

  describe('POST /semantic/migrate/memory-md', () => {
    it('requires filePath parameter', async () => {
      const res = await request(app)
        .post('/semantic/migrate/memory-md')
        .set(auth())
        .send({});

      expect(res.status).toBe(400);
    });

    it('handles non-existent file path', async () => {
      const res = await request(app)
        .post('/semantic/migrate/memory-md')
        .set(auth())
        .send({ filePath: '/tmp/nonexistent-file.md' });

      expect(res.status).toBe(200);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });
  });

  // ─── Verification via Search ────────────────────────────────────

  describe('migrated data is searchable', () => {
    it('finds MEMORY.md content via search', async () => {
      const res = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'server port 3000 Vercel' });

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);
    });

    it('finds canonical state facts via search', async () => {
      const res = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'deploy Vercel' });

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);
    });

    it('finds relationships via search', async () => {
      const res = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'Test Person' });

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);
      expect(res.body.results[0].type).toBe('person');
    });

    it('finds decisions via search', async () => {
      const res = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'SQLite storage' });

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);
      expect(res.body.results[0].type).toBe('decision');
    });
  });

  // ─── Auth ──────────────────────────────────────────────────────

  describe('authentication', () => {
    it('rejects migration without auth token', async () => {
      const res = await request(app)
        .post('/semantic/migrate');

      expect(res.status).toBe(401);
    });
  });
});
