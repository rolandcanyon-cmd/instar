import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Source-level validation that all routes have expected patterns.
 */
describe('Route completeness and safety', () => {
  const routesSource = fs.readFileSync(
    path.join(process.cwd(), 'src/server/routes.ts'),
    'utf-8'
  );

  it('all 22 endpoint routes are defined', () => {
    const expectedRoutes = [
      "router.get('/health'",
      "router.get('/status'",
      "router.get('/sessions/tmux'",
      "router.get('/sessions'",
      "router.get('/sessions/:name/output'",
      "router.post('/sessions/:name/input'",
      "router.post('/sessions/spawn'",
      "router.delete('/sessions/:id'",
      "router.get('/jobs'",
      "router.post('/jobs/:slug/trigger'",
      "router.post('/telegram/reply/:topicId'",
      "router.get('/relationships'",
      "router.get('/relationships/stale'",
      "router.get('/relationships/:id'",
      "router.get('/relationships/:id/context'",
      "router.post('/feedback'",
      "router.get('/feedback'",
      "router.post('/feedback/retry'",
      "router.get('/updates'",
      "router.get('/updates/last'",
      "router.get('/quota'",
      "router.get('/events'",
    ];

    for (const route of expectedRoutes) {
      expect(routesSource).toContain(route);
    }
  });

  it('session spawn has rate limiting', () => {
    expect(routesSource).toContain('spawnLimiter');
    expect(routesSource).toContain('rateLimiter');
  });

  it('session spawn validates name, prompt, and model', () => {
    expect(routesSource).toContain('"name" must be a string under 200 characters');
    expect(routesSource).toContain('"prompt" must be a string under 500KB');
    expect(routesSource).toContain('"model" must be one of');
  });

  it('session input validates text', () => {
    expect(routesSource).toContain("must include \"text\" field");
    expect(routesSource).toContain('100_000');
  });

  it('telegram reply validates topicId as number', () => {
    expect(routesSource).toContain('isNaN(topicId)');
    expect(routesSource).toContain("topicId must be a number");
  });

  it('no catch (err: any) patterns remain', () => {
    expect(routesSource).not.toContain('err: any');
  });

  it('literal routes defined before parameterized routes to avoid capture', () => {
    // /sessions/tmux must come before /sessions/:name
    const tmuxIdx = routesSource.indexOf("'/sessions/tmux'");
    const paramIdx = routesSource.indexOf("'/sessions/:name/output'");
    expect(tmuxIdx).toBeLessThan(paramIdx);

    // /relationships/stale must come before /relationships/:id
    const staleIdx = routesSource.indexOf("'/relationships/stale'");
    const relIdIdx = routesSource.indexOf("'/relationships/:id'");
    expect(staleIdx).toBeLessThan(relIdIdx);
  });

  it('all error responses include instanceof Error check', () => {
    // Count catch blocks that should have instanceof Error
    const catchBlocks = routesSource.match(/catch \(err\)/g) || [];
    const instanceofChecks = routesSource.match(/err instanceof Error/g) || [];
    // Every catch block should have an instanceof check
    expect(instanceofChecks.length).toBeGreaterThanOrEqual(catchBlocks.length);
  });
});
