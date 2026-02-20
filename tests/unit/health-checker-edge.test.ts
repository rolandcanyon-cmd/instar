/**
 * Edge case tests for HealthChecker.
 *
 * Covers: invalid periodic check interval, session check failure handling,
 * multiple stop calls, and timestamp format.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HealthChecker } from '../../src/monitoring/HealthChecker.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('HealthChecker — edge cases', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let checker: HealthChecker;

  const makeConfig = (overrides?: Partial<InstarConfig>): InstarConfig => ({
    projectName: 'test-project',
    projectDir: '/tmp/test',
    stateDir: '', // set in beforeEach
    port: 4040,
    sessions: {
      tmuxPath: '/opt/homebrew/bin/tmux',
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
      healthCheckIntervalMs: 5000,
    },
    ...overrides,
  });

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
  });

  afterEach(() => {
    checker?.stopPeriodicChecks();
    project.cleanup();
  });

  describe('invalid periodic check interval', () => {
    it('throws on zero interval', () => {
      const config = makeConfig({ stateDir: project.stateDir });
      checker = new HealthChecker(config, mockSM as any);
      expect(() => checker.startPeriodicChecks(0)).toThrow('positive');
    });

    it('throws on negative interval', () => {
      const config = makeConfig({ stateDir: project.stateDir });
      checker = new HealthChecker(config, mockSM as any);
      expect(() => checker.startPeriodicChecks(-1000)).toThrow('positive');
    });
  });

  describe('multiple stop calls', () => {
    it('stopPeriodicChecks is safe to call multiple times', () => {
      const config = makeConfig({ stateDir: project.stateDir });
      checker = new HealthChecker(config, mockSM as any);

      checker.startPeriodicChecks(1000);
      checker.stopPeriodicChecks();
      checker.stopPeriodicChecks(); // Should not throw
      checker.stopPeriodicChecks(); // Still safe
    });

    it('stopPeriodicChecks is safe when never started', () => {
      const config = makeConfig({ stateDir: project.stateDir });
      checker = new HealthChecker(config, mockSM as any);

      // Never started — should not throw
      checker.stopPeriodicChecks();
    });
  });

  describe('timestamp format', () => {
    it('health status timestamp is ISO 8601', () => {
      const config = makeConfig({ stateDir: project.stateDir });
      checker = new HealthChecker(config, mockSM as any);

      const status = checker.check();
      // Should be parseable as a date
      const parsed = new Date(status.timestamp);
      expect(parsed.getTime()).not.toBeNaN();
      // Should end with Z (UTC)
      expect(status.timestamp).toMatch(/Z$/);
    });

    it('component lastCheck is ISO 8601', () => {
      const config = makeConfig({ stateDir: project.stateDir });
      checker = new HealthChecker(config, mockSM as any);

      const status = checker.check();
      for (const component of Object.values(status.components)) {
        const parsed = new Date(component.lastCheck);
        expect(parsed.getTime()).not.toBeNaN();
      }
    });
  });

  describe('session check with error', () => {
    it('reports unhealthy when session manager throws', () => {
      const config = makeConfig({ stateDir: project.stateDir });
      const brokenSM = {
        listRunningSessions: () => { throw new Error('tmux crashed'); },
      };
      checker = new HealthChecker(config, brokenSM as any);

      const status = checker.check();
      expect(status.components.sessions.status).toBe('unhealthy');
      expect(status.components.sessions.message).toContain('tmux crashed');
      expect(status.status).toBe('unhealthy'); // Overall should be unhealthy too
    });
  });

  describe('state directory checks', () => {
    it('reports unhealthy for non-writable state dir', () => {
      const config = makeConfig({ stateDir: '/dev/null/fake' });
      checker = new HealthChecker(config, mockSM as any);

      const status = checker.check();
      expect(status.components.stateDir.status).toBe('unhealthy');
    });
  });

  describe('scheduler null safety', () => {
    it('scheduler component absent when scheduler is null', () => {
      const config = makeConfig({ stateDir: project.stateDir });
      checker = new HealthChecker(config, mockSM as any, null);

      const status = checker.check();
      expect(status.components.scheduler).toBeUndefined();
      // Overall should still be healthy
      expect(status.status).toBe('healthy');
    });
  });
});
