/**
 * Unit tests for FeedbackAnomalyDetector — in-memory sliding window anomaly detection.
 *
 * Tests cover:
 * - Rapid fire detection (min interval between submissions)
 * - Hourly rate burst detection
 * - Daily limit detection
 * - First submission always allowed
 * - Stats reporting with flagged agents
 * - Independent tracking per agent
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FeedbackAnomalyDetector } from '../../src/monitoring/FeedbackAnomalyDetector.js';

describe('FeedbackAnomalyDetector', () => {
  let detector: FeedbackAnomalyDetector;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    detector = new FeedbackAnomalyDetector({
      maxPerAgentPerHour: 5,
      maxPerAgentPerDay: 10,
      minIntervalMs: 2000,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows first submission from any agent', () => {
    const result = detector.check('agent-abc123');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.anomalyType).toBeUndefined();
  });

  it('allows submission after recording when interval has passed', () => {
    // Use fake timers to control time
    vi.useFakeTimers();
    const now = Date.now();

    detector.recordSubmission('agent-abc123');

    // Advance past the min interval
    vi.setSystemTime(now + 3000);

    const result = detector.check('agent-abc123');
    expect(result.allowed).toBe(true);

    vi.useRealTimers();
  });

  describe('rapid fire detection', () => {
    it('blocks submissions within minIntervalMs', () => {
      vi.useFakeTimers();
      const now = Date.now();

      detector.recordSubmission('agent-rapid');

      // Only 500ms later — should be blocked
      vi.setSystemTime(now + 500);

      const result = detector.check('agent-rapid');
      expect(result.allowed).toBe(false);
      expect(result.anomalyType).toBe('rapid_fire');
      expect(result.reason).toContain('wait');

      vi.useRealTimers();
    });

    it('allows after minIntervalMs has passed', () => {
      vi.useFakeTimers();
      const now = Date.now();

      detector.recordSubmission('agent-rapid');

      // Advance past threshold
      vi.setSystemTime(now + 2500);

      const result = detector.check('agent-rapid');
      expect(result.allowed).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('hourly rate burst detection', () => {
    it('blocks after maxPerAgentPerHour submissions', () => {
      vi.useFakeTimers();
      const now = Date.now();

      // Record 5 submissions spaced out (within the hour)
      for (let i = 0; i < 5; i++) {
        vi.setSystemTime(now + i * 10000); // 10s apart
        detector.recordSubmission('agent-burst');
      }

      // Next check should be blocked
      vi.setSystemTime(now + 60000);
      const result = detector.check('agent-burst');
      expect(result.allowed).toBe(false);
      expect(result.anomalyType).toBe('rate_burst');
      expect(result.reason).toContain('Hourly');

      vi.useRealTimers();
    });

    it('allows after old submissions age out of hourly window', () => {
      vi.useFakeTimers();
      const now = Date.now();

      // Fill up hourly limit
      for (let i = 0; i < 5; i++) {
        vi.setSystemTime(now + i * 5000);
        detector.recordSubmission('agent-aging');
      }

      // Blocked now
      vi.setSystemTime(now + 30000);
      expect(detector.check('agent-aging').allowed).toBe(false);

      // Advance past 1 hour — old submissions age out
      vi.setSystemTime(now + 3600 * 1000 + 10000);
      expect(detector.check('agent-aging').allowed).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('daily limit detection', () => {
    it('blocks after maxPerAgentPerDay submissions', () => {
      vi.useFakeTimers();
      const now = Date.now();

      // Use higher hourly limit to test daily limit specifically
      detector = new FeedbackAnomalyDetector({
        maxPerAgentPerHour: 100, // won't trigger
        maxPerAgentPerDay: 3,
        minIntervalMs: 100,
      });

      // Record 3 submissions across hours
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(now + i * 3600 * 1000); // 1 hour apart
        detector.recordSubmission('agent-daily');
      }

      // Next check should be daily-limited
      vi.setSystemTime(now + 3 * 3600 * 1000 + 5000);
      const result = detector.check('agent-daily');
      expect(result.allowed).toBe(false);
      expect(result.anomalyType).toBe('daily_limit');
      expect(result.reason).toContain('Daily');

      vi.useRealTimers();
    });
  });

  describe('independent agent tracking', () => {
    it('tracks agents independently', () => {
      vi.useFakeTimers();
      const now = Date.now();

      // Fill up agent A
      for (let i = 0; i < 5; i++) {
        vi.setSystemTime(now + i * 5000);
        detector.recordSubmission('agent-a');
      }

      // Agent A should be blocked
      vi.setSystemTime(now + 30000);
      expect(detector.check('agent-a').allowed).toBe(false);

      // Agent B should still be fine
      expect(detector.check('agent-b').allowed).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('getStats()', () => {
    it('returns zero stats with no submissions', () => {
      const stats = detector.getStats();
      expect(stats.totalTracked).toBe(0);
      expect(stats.flaggedAgents).toEqual([]);
    });

    it('tracks total agents', () => {
      detector.recordSubmission('agent-1');
      detector.recordSubmission('agent-2');
      detector.recordSubmission('agent-3');

      const stats = detector.getStats();
      expect(stats.totalTracked).toBe(3);
    });

    it('flags agents near hourly limit (80%+)', () => {
      vi.useFakeTimers();
      const now = Date.now();

      // 4 out of 5 = 80% — should be flagged
      for (let i = 0; i < 4; i++) {
        vi.setSystemTime(now + i * 5000);
        detector.recordSubmission('agent-near');
      }

      // 1 out of 5 = 20% — should not be flagged
      vi.setSystemTime(now + 25000);
      detector.recordSubmission('agent-fine');

      const stats = detector.getStats();
      expect(stats.flaggedAgents).toContain('agent-near');
      expect(stats.flaggedAgents).not.toContain('agent-fine');

      vi.useRealTimers();
    });
  });

  describe('default config', () => {
    it('uses sensible defaults when no config provided', () => {
      const defaultDetector = new FeedbackAnomalyDetector();

      // First submission should always be allowed
      const result = defaultDetector.check('agent-default');
      expect(result.allowed).toBe(true);
    });
  });
});
