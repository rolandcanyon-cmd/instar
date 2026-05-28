/**
 * Wiring-integrity test (Ingestion-sources spec §11; the silently-stopped-trio
 * lesson): the CiFailurePoller must be CONSTRUCTED by AgentServer iff
 * failureLearning.enabled && sources.ci — not dead code, not always-on.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

function baseConfig(project: TempProject, failureLearning: unknown): InstarConfig {
  return {
    projectName: 'ci-poller-wiring', projectDir: project.dir, stateDir: project.stateDir, port: 0,
    authToken: 't',
    sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude', projectDir: project.dir, maxSessions: 3, protectedSessions: [], completionPatterns: [] },
    scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
    users: [], messaging: [],
    monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000, failureLearning } as never,
  } as InstarConfig;
}

const trackerStub = { findByMergeCommit: () => undefined, findByPrNumber: () => undefined, get: () => undefined } as never;

function build(project: TempProject, failureLearning: unknown) {
  return new AgentServer({
    config: baseConfig(project, failureLearning),
    sessionManager: createMockSessionManager() as never,
    state: project.state,
    initiativeTracker: trackerStub,
  } as never) as unknown as { ciFailurePoller: unknown; failureLedger: unknown };
}

describe('CiFailurePoller wiring (constructed iff gated)', () => {
  let project: TempProject;
  afterEach(() => project?.cleanup?.());

  it('constructed when failureLearning.enabled && sources.ci', () => {
    project = createTempProject();
    const s = build(project, { enabled: true, sources: { ci: true } });
    expect(s.failureLedger).not.toBeNull();
    expect(s.ciFailurePoller).not.toBeNull();
  });

  it('NOT constructed when sources.ci is false (but the ledger still is)', () => {
    project = createTempProject();
    const s = build(project, { enabled: true, sources: { ci: false } });
    expect(s.failureLedger).not.toBeNull();
    expect(s.ciFailurePoller).toBeNull();
  });

  it('NOT constructed when failureLearning is disabled', () => {
    project = createTempProject();
    const s = build(project, { enabled: false, sources: { ci: true } });
    expect(s.failureLedger).toBeNull();
    expect(s.ciFailurePoller).toBeNull();
  });
});
