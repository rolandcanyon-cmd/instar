/**
 * Tests for JobLoader's telegramNotify validation (v0.12.6).
 *
 * Separate file because the notification-spam-prevention tests mock croner,
 * which interferes with validateJob's cron parsing.
 */

import { describe, it, expect } from 'vitest';
import { validateJob } from '../../src/scheduler/JobLoader.js';

describe('JobLoader telegramNotify validation', () => {
  function baseJob(overrides?: Record<string, unknown>): Record<string, unknown> {
    return {
      slug: 'test-job',
      name: 'Test Job',
      description: 'A test',
      schedule: '0 * * * *',
      priority: 'medium',
      model: 'sonnet',
      enabled: true,
      expectedDurationMinutes: 5,
      execute: { type: 'prompt', value: 'test' },
      ...overrides,
    };
  }

  it('accepts telegramNotify: true', () => {
    expect(() => validateJob(baseJob({ telegramNotify: true }))).not.toThrow();
  });

  it('accepts telegramNotify: false', () => {
    expect(() => validateJob(baseJob({ telegramNotify: false }))).not.toThrow();
  });

  it('accepts telegramNotify: "on-alert"', () => {
    expect(() => validateJob(baseJob({ telegramNotify: 'on-alert' }))).not.toThrow();
  });

  it('accepts telegramNotify: undefined (omitted)', () => {
    expect(() => validateJob(baseJob())).not.toThrow();
  });

  it('rejects telegramNotify: "always"', () => {
    expect(() => validateJob(baseJob({ telegramNotify: 'always' }))).toThrow('telegramNotify');
  });

  it('rejects telegramNotify: 42', () => {
    expect(() => validateJob(baseJob({ telegramNotify: 42 }))).toThrow('telegramNotify');
  });
});
