/**
 * Integration test — scheduler with real cron timing.
 *
 * Uses a fast cron (every second) and mock claude to verify
 * the scheduler triggers jobs and tracks state.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { detectTmuxPath } from '../../src/core/Config.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import {
  createTempProject,
  createMockClaude,
  cleanupTmuxSessions,
  waitFor,
} from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { JobDefinition } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';

const TMUX_PREFIX = 'akit-sched-';

const tmuxPath = detectTmuxPath();
const describeMaybe = tmuxPath ? describe : describe.skip;

describeMaybe('JobScheduler (integration)', () => {
  let project: TempProject;
  let mockClaudePath: string;
  let sm: SessionManager;
  let scheduler: JobScheduler;

  beforeAll(() => {
    project = createTempProject();
    mockClaudePath = createMockClaude(project.dir);

    sm = new SessionManager(
      {
        tmuxPath: tmuxPath!,
        claudePath: mockClaudePath,
        projectDir: project.dir,
        maxSessions: 5,
        protectedSessions: [],
        completionPatterns: ['Session ended'],
      },
      project.state,
    );
  });

  afterAll(() => {
    scheduler?.stop();
    sm.stopMonitoring();
    cleanupTmuxSessions(TMUX_PREFIX);
    project.cleanup();
  });

  it('triggers a job via cron and spawns a session', async () => {
    // Create a jobs file with a fast-firing cron (every second)
    const fastJob: JobDefinition = {
      slug: 'fast-test',
      name: 'Fast Test',
      description: 'Triggers every second for testing',
      schedule: '* * * * * *', // Every second (croner supports seconds)
      priority: 'medium',
      expectedDurationMinutes: 1,
      model: 'haiku',
      enabled: true,
      execute: { type: 'prompt', value: 'Quick test' },
    };

    const jobsFile = path.join(project.stateDir, 'jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify([fastJob]));

    scheduler = new JobScheduler(
      {
        jobsFile,
        enabled: true,
        maxParallelJobs: 3,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      },
      sm,
      project.state,
    );

    scheduler.start();

    // Wait for cron to fire and a session to be spawned
    await waitFor(
      () => {
        const events = project.state.queryEvents({ type: 'job_triggered' });
        return events.length > 0;
      },
      5000,
    );

    scheduler.stop();

    // Verify a job_triggered event was recorded
    const events = project.state.queryEvents({ type: 'job_triggered' });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].summary).toContain('fast-test');

    // Verify job state was saved
    const jobState = project.state.getJobState('fast-test');
    expect(jobState).not.toBeNull();
    expect(jobState!.lastRun).toBeTruthy();
  });
});
