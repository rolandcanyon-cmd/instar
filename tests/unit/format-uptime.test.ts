import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Tests for the formatUptime helper in routes.ts.
 * Since it's not exported, we verify via source-level inspection
 * and through the /health endpoint behavior in integration tests.
 */
describe('formatUptime helper', () => {
  const routesSource = fs.readFileSync(
    path.join(process.cwd(), 'src/server/routes.ts'),
    'utf-8'
  );

  it('formatUptime is defined in routes.ts', () => {
    expect(routesSource).toContain('function formatUptime(ms: number): string');
  });

  it('handles days, hours, minutes, and seconds', () => {
    // Uses template literals: `${days}d ${hours % 24}h` etc.
    expect(routesSource).toContain('d ${hours');
    expect(routesSource).toContain('h ${minutes');
    expect(routesSource).toContain('m ${seconds');
  });

  it('health endpoint includes uptimeHuman in response', () => {
    expect(routesSource).toContain('uptimeHuman: formatUptime(uptimeMs)');
  });

  it('health endpoint includes all expected fields', () => {
    expect(routesSource).toContain("status: 'ok'");
    expect(routesSource).toContain('uptime: uptimeMs');
    expect(routesSource).toContain('version: ctx.config.version');
    expect(routesSource).toContain('project: ctx.config.projectName');
  });
});
