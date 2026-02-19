import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTempProject, createSampleJobsFile } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';

/**
 * CLI command tests — validate that user/job commands
 * correctly read/write state files.
 *
 * We test the underlying logic by importing the UserManager and
 * JobLoader directly, since the CLI commands are thin wrappers.
 */

describe('CLI Commands', () => {
  let project: TempProject;

  beforeEach(() => {
    project = createTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  describe('user add', () => {
    it('creates user via UserManager', async () => {
      const { UserManager } = await import('../../src/users/UserManager.js');
      const um = new UserManager(project.stateDir);

      um.upsertUser({
        id: 'justin',
        name: 'Justin',
        channels: [
          { type: 'telegram', identifier: '42' },
          { type: 'email', identifier: 'test@example.com' },
        ],
        permissions: ['admin'],
        preferences: {},
      });

      const users = um.listUsers();
      expect(users).toHaveLength(1);
      expect(users[0].name).toBe('Justin');
      expect(users[0].channels).toHaveLength(2);

      // Verify it was persisted to disk
      const usersFile = path.join(project.stateDir, 'users.json');
      expect(fs.existsSync(usersFile)).toBe(true);
      const savedUsers = JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
      expect(savedUsers).toHaveLength(1);
    });

    it('resolves user from channel', async () => {
      const { UserManager } = await import('../../src/users/UserManager.js');
      const um = new UserManager(project.stateDir);

      um.upsertUser({
        id: 'justin',
        name: 'Justin',
        channels: [{ type: 'telegram', identifier: '42' }],
        permissions: ['admin'],
        preferences: {},
      });

      const resolved = um.resolveFromChannel({ type: 'telegram', identifier: '42' });
      expect(resolved).not.toBeNull();
      expect(resolved!.id).toBe('justin');

      const notFound = um.resolveFromChannel({ type: 'telegram', identifier: '999' });
      expect(notFound).toBeNull();
    });
  });

  describe('job add', () => {
    it('adds a job to jobs.json', async () => {
      const jobsFile = path.join(project.stateDir, 'jobs.json');
      fs.writeFileSync(jobsFile, '[]');

      const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));
      jobs.push({
        slug: 'test-job',
        name: 'Test Job',
        description: 'A test job',
        schedule: '0 */4 * * *',
        priority: 'medium',
        expectedDurationMinutes: 5,
        model: 'sonnet',
        enabled: true,
        execute: { type: 'prompt', value: 'Do the thing' },
      });
      fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));

      // Verify via JobLoader
      const { loadJobs } = await import('../../src/scheduler/JobLoader.js');
      const loaded = loadJobs(jobsFile);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].slug).toBe('test-job');
    });

    it('validates job before saving', async () => {
      const { validateJob } = await import('../../src/scheduler/JobLoader.js');

      // Valid job passes
      expect(() => validateJob({
        slug: 'ok',
        name: 'OK',
        description: 'Fine',
        schedule: '0 * * * *',
        priority: 'medium',
        enabled: true,
        execute: { type: 'prompt', value: 'test' },
      })).not.toThrow();

      // Invalid priority caught
      expect(() => validateJob({
        slug: 'bad',
        name: 'Bad',
        description: 'Bad',
        schedule: '0 * * * *',
        priority: 'urgent',
        enabled: true,
        execute: { type: 'prompt', value: 'test' },
      })).toThrow('priority');
    });
  });

  describe('job list', () => {
    it('loads and displays jobs with state', async () => {
      const jobsFile = createSampleJobsFile(project.stateDir);
      const { loadJobs } = await import('../../src/scheduler/JobLoader.js');

      const jobs = loadJobs(jobsFile);
      expect(jobs).toHaveLength(3);
      expect(jobs.filter((j: any) => j.enabled)).toHaveLength(2);
    });
  });
});
