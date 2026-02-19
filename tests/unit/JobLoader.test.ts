import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadJobs, validateJob } from '../../src/scheduler/JobLoader.js';

describe('JobLoader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kit-loader-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const validJob = {
    slug: 'test-job',
    name: 'Test Job',
    description: 'A test job',
    schedule: '0 */4 * * *',
    priority: 'medium',
    expectedDurationMinutes: 5,
    model: 'sonnet',
    enabled: true,
    execute: { type: 'skill', value: 'scan' },
  };

  function writeJobsFile(jobs: unknown[]): string {
    const filePath = path.join(tmpDir, 'jobs.json');
    fs.writeFileSync(filePath, JSON.stringify(jobs));
    return filePath;
  }

  describe('loadJobs', () => {
    it('loads a valid jobs file', () => {
      const file = writeJobsFile([validJob]);
      const jobs = loadJobs(file);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].slug).toBe('test-job');
    });

    it('loads empty array', () => {
      const file = writeJobsFile([]);
      const jobs = loadJobs(file);
      expect(jobs).toHaveLength(0);
    });

    it('loads multiple jobs', () => {
      const file = writeJobsFile([
        validJob,
        { ...validJob, slug: 'second-job', name: 'Second' },
      ]);
      const jobs = loadJobs(file);
      expect(jobs).toHaveLength(2);
    });

    it('includes disabled jobs (filtering is caller responsibility)', () => {
      const file = writeJobsFile([
        validJob,
        { ...validJob, slug: 'off', enabled: false },
      ]);
      const jobs = loadJobs(file);
      expect(jobs).toHaveLength(2);
      expect(jobs[1].enabled).toBe(false);
    });

    it('throws for missing file', () => {
      expect(() => loadJobs('/nonexistent/jobs.json'))
        .toThrow('Jobs file not found');
    });

    it('throws for non-array JSON', () => {
      const file = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(file, JSON.stringify({ jobs: [] }));
      expect(() => loadJobs(file))
        .toThrow('must contain a JSON array');
    });
  });

  describe('validateJob', () => {
    it('accepts a valid job', () => {
      expect(() => validateJob(validJob)).not.toThrow();
    });

    it('rejects null', () => {
      expect(() => validateJob(null)).toThrow('must be an object');
    });

    it('rejects missing slug', () => {
      const { slug, ...noSlug } = validJob;
      expect(() => validateJob(noSlug)).toThrow('"slug" is required');
    });

    it('rejects empty slug', () => {
      expect(() => validateJob({ ...validJob, slug: '  ' }))
        .toThrow('"slug" is required');
    });

    it('rejects missing name', () => {
      const { name, ...noName } = validJob;
      expect(() => validateJob(noName)).toThrow('"name" is required');
    });

    it('rejects missing description', () => {
      const { description, ...noDesc } = validJob;
      expect(() => validateJob(noDesc)).toThrow('"description" is required');
    });

    it('rejects missing schedule', () => {
      const { schedule, ...noSchedule } = validJob;
      expect(() => validateJob(noSchedule)).toThrow('"schedule" is required');
    });

    it('rejects invalid priority', () => {
      expect(() => validateJob({ ...validJob, priority: 'urgent' }))
        .toThrow('"priority" must be one of');
    });

    it('rejects invalid cron expression', () => {
      expect(() => validateJob({ ...validJob, schedule: 'not a cron' }))
        .toThrow('invalid cron expression');
    });

    it('rejects non-boolean enabled', () => {
      expect(() => validateJob({ ...validJob, enabled: 'yes' }))
        .toThrow('"enabled" must be a boolean');
    });

    it('rejects missing execute', () => {
      const { execute, ...noExec } = validJob;
      expect(() => validateJob(noExec))
        .toThrow('"execute" must be an object');
    });

    it('rejects invalid execute.type', () => {
      expect(() => validateJob({ ...validJob, execute: { type: 'unknown', value: 'x' } }))
        .toThrow('execute.type must be');
    });

    it('rejects empty execute.value', () => {
      expect(() => validateJob({ ...validJob, execute: { type: 'skill', value: '' } }))
        .toThrow('execute.value is required');
    });

    it('includes index in error message', () => {
      expect(() => validateJob(null, 3)).toThrow('Job[3]');
    });
  });
});
