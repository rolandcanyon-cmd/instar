import { describe, it, expect, beforeEach } from 'vitest';
import { TelemetryCollector, type CollectorDeps } from '../../src/monitoring/TelemetryCollector.js';
import type { JobDefinition, SkipReason } from '../../src/core/types.js';
import type { JobRun } from '../../src/scheduler/JobRunHistory.js';

describe('TelemetryCollector', () => {
  const INSTALL_ID = '12345678-abcd-efgh-ijkl-123456789012';
  const VERSION = '0.15.0-test';
  const START_TIME = Date.now() - 3600000; // 1 hour ago

  function makeSkip(slug: string, reason: SkipReason, ts?: string) {
    return {
      slug,
      reason,
      timestamp: ts ?? new Date().toISOString(),
      jobSlug: slug,
    };
  }

  function makeRun(overrides: Partial<JobRun> & { slug: string }): JobRun {
    return {
      runId: `${overrides.slug}-${Date.now()}`,
      sessionId: 'test-session',
      trigger: 'scheduled',
      startedAt: new Date().toISOString(),
      result: 'success',
      ...overrides,
    };
  }

  function makeJob(slug: string, schedule = '*/30 * * * *', enabled = true): JobDefinition {
    return {
      slug,
      schedule,
      enabled,
      prompt: 'test',
    } as JobDefinition;
  }

  function createCollector(overrides: Partial<CollectorDeps> = {}): { collector: TelemetryCollector; deps: CollectorDeps } {
    const deps: CollectorDeps = {
      skipLedger: {
        getSkips: () => [],
      } as any,
      runHistory: {
        query: () => ({ runs: [], total: 0 }),
      } as any,
      getJobs: () => [],
      version: VERSION,
      startTime: START_TIME,
      getSessionCount24h: () => 0,
      getConfig: () => ({}),
      ...overrides,
    };
    return { collector: new TelemetryCollector(deps), deps };
  }

  describe('collect() — basic structure', () => {
    it('should produce a valid v1 submission', () => {
      const { collector } = createCollector();
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 6 * 3600000);

      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.v).toBe(1);
      expect(result.installationId).toBe(INSTALL_ID);
      expect(result.version).toBe(VERSION);
      expect(result.windowStart).toBe(windowStart.toISOString());
      expect(result.windowEnd).toBe(windowEnd.toISOString());
      expect(result.agent).toBeDefined();
      expect(result.jobs).toBeDefined();
      expect(result.jobs.skips).toEqual([]);
      expect(result.jobs.results).toEqual([]);
      expect(result.jobs.durations).toEqual([]);
      expect(result.jobs.models).toEqual([]);
      expect(result.jobs.adherence).toEqual([]);
    });
  });

  describe('agent metrics', () => {
    it('should report version and system info', () => {
      const { collector } = createCollector();
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 6 * 3600000);
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.agent.version).toBe(VERSION);
      expect(result.agent.os).toBeTruthy();
      expect(result.agent.arch).toBeTruthy();
      expect(result.agent.nodeVersion).toBeTruthy();
    });

    it('should compute uptime in hours', () => {
      const { collector } = createCollector({ startTime: Date.now() - 7200000 }); // 2h ago
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 6 * 3600000);
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.agent.uptimeHours).toBeGreaterThanOrEqual(1.9);
      expect(result.agent.uptimeHours).toBeLessThanOrEqual(2.1);
    });

    it('should count total, enabled, and disabled jobs', () => {
      const jobs = [
        makeJob('job-a', '*/30 * * * *', true),
        makeJob('job-b', '*/30 * * * *', true),
        makeJob('job-c', '*/30 * * * *', false),
      ];
      const { collector } = createCollector({ getJobs: () => jobs });
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 6 * 3600000);
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.agent.totalJobs).toBe(3);
      expect(result.agent.enabledJobs).toBe(2);
      expect(result.agent.disabledJobs).toBe(1);
    });

    it('should bucket sessions correctly', () => {
      for (const [count, expected] of [
        [0, '0'],
        [1, '1-5'],
        [5, '1-5'],
        [6, '6-20'],
        [20, '6-20'],
        [21, '20+'],
        [100, '20+'],
      ] as const) {
        const { collector } = createCollector({ getSessionCount24h: () => count });
        const windowEnd = new Date();
        const windowStart = new Date(windowEnd.getTime() - 6 * 3600000);
        const result = collector.collect(INSTALL_ID, windowStart, windowEnd);
        expect(result.agent.sessionsBucket).toBe(expected);
      }
    });

    it('should extract feature flags from config', () => {
      const config = {
        monitoring: {
          triage: { enabled: true },
          triageOrchestrator: { enabled: false },
        },
        threadline: { enabled: true },
        telemetry: true,
        evolution: false,
        tunnel: { enabled: true },
      };
      const { collector } = createCollector({ getConfig: () => config as any });
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 6 * 3600000);
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.agent.features.triage).toBe(true);
      expect(result.agent.features.triageOrchestrator).toBe(false);
      expect(result.agent.features.threadline).toBe(true);
      expect(result.agent.features.telemetry).toBe(true);
      expect(result.agent.features.evolution).toBe(false);
      expect(result.agent.features.tunnel).toBe(true);
    });

    it('should include watchdog metrics when provider is available', () => {
      const { collector } = createCollector({
        getWatchdogStats: () => ({
          interventionsTotal: 5,
          interventionsByLevel: { 'ctrl-c': 3, sigterm: 2 },
          recoveries: 4,
          sessionDeaths: 1,
          llmGateOverrides: 7,
        }),
      });
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 6 * 3600000);
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.agent.watchdog).toBeDefined();
      expect(result.agent.watchdog!.interventions).toBe(5);
      expect(result.agent.watchdog!.byLevel).toEqual({ 'ctrl-c': 3, sigterm: 2 });
      expect(result.agent.watchdog!.recoveries).toBe(4);
      expect(result.agent.watchdog!.deaths).toBe(1);
      expect(result.agent.watchdog!.llmGateOverrides).toBe(7);
    });

    it('should omit watchdog metrics when provider is not available', () => {
      const { collector } = createCollector();
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 6 * 3600000);
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.agent.watchdog).toBeUndefined();
    });
  });

  describe('skip reason mapping', () => {
    it('should map quota → quota', () => {
      const { collector } = createCollector({
        skipLedger: {
          getSkips: () => [makeSkip('health-check', 'quota')],
        } as any,
      });
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 6 * 3600000);
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.jobs.skips).toContainEqual({
        slug: 'health-check',
        reason: 'quota',
        count: 1,
      });
    });

    it('should map disabled → disabled', () => {
      const { collector } = createCollector({
        skipLedger: {
          getSkips: () => [makeSkip('health-check', 'disabled')],
        } as any,
      });
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 6 * 3600000);
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.jobs.skips).toContainEqual({
        slug: 'health-check',
        reason: 'disabled',
        count: 1,
      });
    });

    it('should map paused → disabled', () => {
      const { collector } = createCollector({
        skipLedger: {
          getSkips: () => [makeSkip('health-check', 'paused')],
        } as any,
      });
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 6 * 3600000);
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.jobs.skips).toContainEqual({
        slug: 'health-check',
        reason: 'disabled',
        count: 1,
      });
    });

    it('should map capacity → priority', () => {
      const { collector } = createCollector({
        skipLedger: {
          getSkips: () => [makeSkip('health-check', 'capacity')],
        } as any,
      });
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 6 * 3600000);
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.jobs.skips).toContainEqual({
        slug: 'health-check',
        reason: 'priority',
        count: 1,
      });
    });

    it('should drop claimed (multi-machine internal)', () => {
      const { collector } = createCollector({
        skipLedger: {
          getSkips: () => [makeSkip('health-check', 'claimed')],
        } as any,
      });
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 6 * 3600000);
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.jobs.skips).toEqual([]);
    });

    it('should drop machine-scope (multi-machine internal)', () => {
      const { collector } = createCollector({
        skipLedger: {
          getSkips: () => [makeSkip('health-check', 'machine-scope' as SkipReason)],
        } as any,
      });
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 6 * 3600000);
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.jobs.skips).toEqual([]);
    });

    it('should aggregate counts by slug:reason pair', () => {
      const { collector } = createCollector({
        skipLedger: {
          getSkips: () => [
            makeSkip('health-check', 'quota'),
            makeSkip('health-check', 'quota'),
            makeSkip('health-check', 'quota'),
            makeSkip('health-check', 'disabled'),
            makeSkip('ci-monitor', 'quota'),
          ],
        } as any,
      });
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 6 * 3600000);
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.jobs.skips).toContainEqual({ slug: 'health-check', reason: 'quota', count: 3 });
      expect(result.jobs.skips).toContainEqual({ slug: 'health-check', reason: 'disabled', count: 1 });
      expect(result.jobs.skips).toContainEqual({ slug: 'ci-monitor', reason: 'quota', count: 1 });
    });

    it('should filter out slugs that do not match slug regex', () => {
      const { collector } = createCollector({
        skipLedger: {
          getSkips: () => [
            makeSkip('INVALID-UPPERCASE', 'quota'),
            makeSkip('../../etc/passwd', 'quota'),
            makeSkip('valid-slug', 'quota'),
          ],
        } as any,
      });
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 6 * 3600000);
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.jobs.skips).toHaveLength(1);
      expect(result.jobs.skips[0].slug).toBe('valid-slug');
    });
  });

  describe('result metrics', () => {
    it('should aggregate success/error/timeout by slug', () => {
      const now = new Date();
      const windowEnd = now;
      const windowStart = new Date(now.getTime() - 6 * 3600000);
      const runs = [
        makeRun({ slug: 'health-check', result: 'success', startedAt: now.toISOString() }),
        makeRun({ slug: 'health-check', result: 'success', startedAt: now.toISOString() }),
        makeRun({ slug: 'health-check', result: 'failure', startedAt: now.toISOString() }),
        makeRun({ slug: 'health-check', result: 'timeout', startedAt: now.toISOString() }),
        makeRun({ slug: 'health-check', result: 'spawn-error', startedAt: now.toISOString() }),
      ];
      const { collector } = createCollector({
        runHistory: {
          query: () => ({ runs, total: runs.length }),
        } as any,
      });
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      const hc = result.jobs.results.find(r => r.slug === 'health-check');
      expect(hc).toBeDefined();
      expect(hc!.success).toBe(2);
      expect(hc!.error).toBe(2); // failure + spawn-error
      expect(hc!.timeout).toBe(1);
    });

    it('should exclude pending runs', () => {
      const now = new Date();
      const windowEnd = now;
      const windowStart = new Date(now.getTime() - 6 * 3600000);
      const runs = [
        makeRun({ slug: 'health-check', result: 'pending', startedAt: now.toISOString() }),
        makeRun({ slug: 'health-check', result: 'success', startedAt: now.toISOString() }),
      ];
      const { collector } = createCollector({
        runHistory: {
          query: () => ({ runs, total: runs.length }),
        } as any,
      });
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      const hc = result.jobs.results.find(r => r.slug === 'health-check');
      expect(hc).toBeDefined();
      expect(hc!.success).toBe(1);
    });
  });

  describe('duration metrics', () => {
    it('should compute mean duration per slug', () => {
      const now = new Date();
      const windowEnd = now;
      const windowStart = new Date(now.getTime() - 6 * 3600000);
      const runs = [
        makeRun({ slug: 'health-check', result: 'success', durationSeconds: 10, startedAt: now.toISOString() }),
        makeRun({ slug: 'health-check', result: 'success', durationSeconds: 20, startedAt: now.toISOString() }),
        makeRun({ slug: 'health-check', result: 'success', durationSeconds: 30, startedAt: now.toISOString() }),
      ];
      const { collector } = createCollector({
        runHistory: {
          query: () => ({ runs, total: runs.length }),
        } as any,
      });
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      const hc = result.jobs.durations.find(d => d.slug === 'health-check');
      expect(hc).toBeDefined();
      expect(hc!.meanMs).toBe(20000); // (10k + 20k + 30k) / 3
      expect(hc!.count).toBe(3);
    });

    it('should skip runs without durationSeconds', () => {
      const now = new Date();
      const windowEnd = now;
      const windowStart = new Date(now.getTime() - 6 * 3600000);
      const runs = [
        makeRun({ slug: 'health-check', result: 'success', durationSeconds: 10, startedAt: now.toISOString() }),
        makeRun({ slug: 'health-check', result: 'success', startedAt: now.toISOString() }), // no duration
      ];
      const { collector } = createCollector({
        runHistory: {
          query: () => ({ runs, total: runs.length }),
        } as any,
      });
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      const hc = result.jobs.durations.find(d => d.slug === 'health-check');
      expect(hc).toBeDefined();
      expect(hc!.count).toBe(1);
      expect(hc!.meanMs).toBe(10000);
    });
  });

  describe('model metrics', () => {
    it('should count runs per slug:model pair', () => {
      const now = new Date();
      const windowEnd = now;
      const windowStart = new Date(now.getTime() - 6 * 3600000);
      const runs = [
        makeRun({ slug: 'health-check', result: 'success', model: 'haiku', startedAt: now.toISOString() }),
        makeRun({ slug: 'health-check', result: 'success', model: 'haiku', startedAt: now.toISOString() }),
        makeRun({ slug: 'health-check', result: 'success', model: 'sonnet', startedAt: now.toISOString() }),
        makeRun({ slug: 'ci-monitor', result: 'success', model: 'opus', startedAt: now.toISOString() }),
      ];
      const { collector } = createCollector({
        runHistory: {
          query: () => ({ runs, total: runs.length }),
        } as any,
      });
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.jobs.models).toContainEqual({ slug: 'health-check', model: 'haiku', runCount: 2 });
      expect(result.jobs.models).toContainEqual({ slug: 'health-check', model: 'sonnet', runCount: 1 });
      expect(result.jobs.models).toContainEqual({ slug: 'ci-monitor', model: 'opus', runCount: 1 });
    });

    it('should use "unknown" when model is not set', () => {
      const now = new Date();
      const windowEnd = now;
      const windowStart = new Date(now.getTime() - 6 * 3600000);
      const runs = [
        makeRun({ slug: 'health-check', result: 'success', startedAt: now.toISOString() }), // no model
      ];
      const { collector } = createCollector({
        runHistory: {
          query: () => ({ runs, total: runs.length }),
        } as any,
      });
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.jobs.models).toContainEqual({ slug: 'health-check', model: 'unknown', runCount: 1 });
    });
  });

  describe('adherence metrics', () => {
    it('should estimate expected runs from cron schedule', () => {
      const now = new Date();
      const windowEnd = now;
      const windowStart = new Date(now.getTime() - 6 * 3600000); // 6h window
      const jobs = [
        makeJob('frequent-job', '*/30 * * * *', true), // every 30 min = 12 expected in 6h
        makeJob('hourly-job', '0 */2 * * *', true),     // every 2h = 3 expected in 6h
      ];
      const { collector } = createCollector({
        getJobs: () => jobs,
        runHistory: {
          query: () => ({ runs: [], total: 0 }),
        } as any,
      });
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      const frequent = result.jobs.adherence.find(a => a.slug === 'frequent-job');
      expect(frequent).toBeDefined();
      expect(frequent!.expectedRuns).toBe(12);

      const hourly = result.jobs.adherence.find(a => a.slug === 'hourly-job');
      expect(hourly).toBeDefined();
      expect(hourly!.expectedRuns).toBe(3);
    });

    it('should not include disabled jobs in adherence', () => {
      const now = new Date();
      const windowEnd = now;
      const windowStart = new Date(now.getTime() - 6 * 3600000);
      const jobs = [
        makeJob('active-job', '*/30 * * * *', true),
        makeJob('disabled-job', '*/30 * * * *', false),
      ];
      const { collector } = createCollector({
        getJobs: () => jobs,
        runHistory: {
          query: () => ({ runs: [], total: 0 }),
        } as any,
      });
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      const slugs = result.jobs.adherence.map(a => a.slug);
      expect(slugs).toContain('active-job');
      expect(slugs).not.toContain('disabled-job');
    });
  });

  describe('count capping', () => {
    it('should cap all count fields at 10,000', () => {
      const now = new Date();
      const windowEnd = now;
      const windowStart = new Date(now.getTime() - 6 * 3600000);

      // Create 15,000 skip entries for one slug
      const skips = Array.from({ length: 15000 }, () => makeSkip('health-check', 'quota'));

      const { collector } = createCollector({
        skipLedger: {
          getSkips: () => skips,
        } as any,
      });
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      const hc = result.jobs.skips.find(s => s.slug === 'health-check');
      expect(hc).toBeDefined();
      expect(hc!.count).toBe(10000);
    });

    it('should cap job count fields at 10,000', () => {
      const manyJobs = Array.from({ length: 15000 }, (_, i) =>
        makeJob(`job-${i}`, '*/30 * * * *', true)
      );
      const { collector } = createCollector({ getJobs: () => manyJobs });
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 6 * 3600000);
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.agent.totalJobs).toBe(10000);
      expect(result.agent.enabledJobs).toBe(10000);
    });
  });

  describe('slug validation', () => {
    it('should accept valid slugs', () => {
      const now = new Date();
      const windowEnd = now;
      const windowStart = new Date(now.getTime() - 6 * 3600000);
      const runs = [
        makeRun({ slug: 'health-check', result: 'success', startedAt: now.toISOString() }),
        makeRun({ slug: 'a', result: 'success', startedAt: now.toISOString() }),
        makeRun({ slug: 'ci-monitor-v2', result: 'success', startedAt: now.toISOString() }),
      ];
      const { collector } = createCollector({
        runHistory: {
          query: () => ({ runs, total: runs.length }),
        } as any,
      });
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.jobs.results).toHaveLength(3);
    });

    it('should reject slugs starting with a number', () => {
      const now = new Date();
      const windowEnd = now;
      const windowStart = new Date(now.getTime() - 6 * 3600000);
      const runs = [
        makeRun({ slug: '1-invalid', result: 'success', startedAt: now.toISOString() }),
      ];
      const { collector } = createCollector({
        runHistory: {
          query: () => ({ runs, total: runs.length }),
        } as any,
      });
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.jobs.results).toHaveLength(0);
    });

    it('should reject slugs with uppercase', () => {
      const now = new Date();
      const windowEnd = now;
      const windowStart = new Date(now.getTime() - 6 * 3600000);
      const runs = [
        makeRun({ slug: 'Invalid-Slug', result: 'success', startedAt: now.toISOString() }),
      ];
      const { collector } = createCollector({
        runHistory: {
          query: () => ({ runs, total: runs.length }),
        } as any,
      });
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.jobs.results).toHaveLength(0);
    });

    it('should reject slugs longer than 64 characters', () => {
      const now = new Date();
      const windowEnd = now;
      const windowStart = new Date(now.getTime() - 6 * 3600000);
      const longSlug = 'a' + '-b'.repeat(40); // > 64 chars
      const runs = [
        makeRun({ slug: longSlug, result: 'success', startedAt: now.toISOString() }),
      ];
      const { collector } = createCollector({
        runHistory: {
          query: () => ({ runs, total: runs.length }),
        } as any,
      });
      const result = collector.collect(INSTALL_ID, windowStart, windowEnd);

      expect(result.jobs.results).toHaveLength(0);
    });
  });
});
