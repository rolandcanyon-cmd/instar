/**
 * Tests for the package entry point — verifies all public exports resolve.
 *
 * This ensures `import { X } from 'instar'` works for every exported symbol.
 */

import { describe, it, expect } from 'vitest';

describe('Package exports (src/index.ts)', () => {
  it('exports all core classes', async () => {
    const mod = await import('../../src/index.js');

    // Core classes
    expect(mod.SessionManager).toBeDefined();
    expect(mod.StateManager).toBeDefined();
    expect(mod.RelationshipManager).toBeDefined();
    expect(mod.FeedbackManager).toBeDefined();
    expect(mod.DispatchManager).toBeDefined();
    expect(mod.UpdateChecker).toBeDefined();

    // Users
    expect(mod.UserManager).toBeDefined();

    // Scheduler
    expect(mod.JobScheduler).toBeDefined();
    expect(mod.loadJobs).toBeDefined();
    expect(mod.validateJob).toBeDefined();

    // Server
    expect(mod.AgentServer).toBeDefined();
    expect(mod.createRoutes).toBeDefined();
    expect(mod.formatUptime).toBeDefined();

    // Middleware
    expect(mod.corsMiddleware).toBeDefined();
    expect(mod.authMiddleware).toBeDefined();
    expect(mod.rateLimiter).toBeDefined();
    expect(mod.requestTimeout).toBeDefined();
    expect(mod.errorHandler).toBeDefined();

    // Monitoring
    expect(mod.HealthChecker).toBeDefined();
    expect(mod.QuotaTracker).toBeDefined();
    expect(mod.SleepWakeDetector).toBeDefined();

    // Messaging
    expect(mod.TelegramAdapter).toBeDefined();

    // Config functions
    expect(mod.loadConfig).toBeDefined();
    expect(mod.detectTmuxPath).toBeDefined();
    expect(mod.detectClaudePath).toBeDefined();
    expect(mod.ensureStateDir).toBeDefined();
  });

  it('exports are the correct types (classes vs functions)', async () => {
    const mod = await import('../../src/index.js');

    // Classes should be constructable
    expect(typeof mod.SessionManager).toBe('function');
    expect(typeof mod.StateManager).toBe('function');
    expect(typeof mod.RelationshipManager).toBe('function');
    expect(typeof mod.FeedbackManager).toBe('function');
    expect(typeof mod.DispatchManager).toBe('function');
    expect(typeof mod.UpdateChecker).toBe('function');
    expect(typeof mod.UserManager).toBe('function');
    expect(typeof mod.JobScheduler).toBe('function');
    expect(typeof mod.AgentServer).toBe('function');
    expect(typeof mod.HealthChecker).toBe('function');
    expect(typeof mod.QuotaTracker).toBe('function');
    expect(typeof mod.SleepWakeDetector).toBe('function');
    expect(typeof mod.TelegramAdapter).toBe('function');

    // Functions
    expect(typeof mod.loadJobs).toBe('function');
    expect(typeof mod.validateJob).toBe('function');
    expect(typeof mod.createRoutes).toBe('function');
    expect(typeof mod.formatUptime).toBe('function');
    expect(typeof mod.loadConfig).toBe('function');
    expect(typeof mod.detectTmuxPath).toBe('function');
    expect(typeof mod.detectClaudePath).toBe('function');
    expect(typeof mod.ensureStateDir).toBe('function');

    // Middleware
    expect(typeof mod.corsMiddleware).toBe('function');
    expect(typeof mod.authMiddleware).toBe('function');
    expect(typeof mod.rateLimiter).toBe('function');
    expect(typeof mod.requestTimeout).toBe('function');
    expect(typeof mod.errorHandler).toBe('function');
  });

  it('does not export internal implementation details', async () => {
    const mod = await import('../../src/index.js');
    const keys = Object.keys(mod);

    // Should NOT export CLI internals or scaffold internals
    expect(keys).not.toContain('initProject');
    expect(keys).not.toContain('runSetup');
    expect(keys).not.toContain('runClassicSetup');
    expect(keys).not.toContain('generateClaudeMd');
    expect(keys).not.toContain('generateAgentMd');
  });
});
