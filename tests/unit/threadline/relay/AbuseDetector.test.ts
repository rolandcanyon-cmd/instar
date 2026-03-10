/**
 * AbuseDetector Unit Tests
 *
 * Tests spam, flooding, connection churn, oversized payload detection,
 * Sybil resistance, ban management, and cleanup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AbuseDetector } from '../../../../src/threadline/relay/AbuseDetector.js';
import type { AbuseEvent } from '../../../../src/threadline/relay/AbuseDetector.js';

describe('AbuseDetector', () => {
  let detector: AbuseDetector;
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1000000;
    detector = new AbuseDetector(
      {
        spamUniqueRecipientsPerMinute: 5,
        spamBanDurationMs: 60_000,
        floodingRateMultiplier: 3,
        floodingSustainedMinutes: 2,
        floodingBanDurationMs: 120_000,
        connectionChurnPerHour: 10,
        connectionChurnBanDurationMs: 60_000,
        oversizedPayloadWarnings: 3,
        oversizedPayloadBanDurationMs: 60_000,
        sybilFirstHourLimit: 5,
        sybilSecondHourLimit: 15,
        sybilGraduationMs: 2 * 60 * 60 * 1000, // 2 hours for testing
        normalRatePerMinute: 10,
      },
      () => now,
    );
  });

  afterEach(() => {
    detector.destroy();
    vi.useRealTimers();
  });

  // ── Ban Management ───────────────────────────────────────────────

  describe('ban management', () => {
    it('isBanned returns null for unbanned agents', () => {
      expect(detector.isBanned('agent1')).toBeNull();
    });

    it('manual ban and unban', () => {
      const ban = detector.ban('agent1', 'test reason', 60_000);
      expect(ban.agentId).toBe('agent1');
      expect(ban.reason).toBe('test reason');
      expect(ban.durationMs).toBe(60_000);

      const check = detector.isBanned('agent1');
      expect(check).not.toBeNull();
      expect(check!.reason).toBe('test reason');

      expect(detector.unban('agent1')).toBe(true);
      expect(detector.isBanned('agent1')).toBeNull();
    });

    it('ban expires after duration', () => {
      detector.ban('agent1', 'test', 30_000);
      expect(detector.isBanned('agent1')).not.toBeNull();

      now += 30_001;
      expect(detector.isBanned('agent1')).toBeNull();
    });

    it('getActiveBans filters expired', () => {
      detector.ban('agent1', 'test1', 30_000);
      detector.ban('agent2', 'test2', 60_000);

      expect(detector.getActiveBans()).toHaveLength(2);

      now += 35_000;
      const active = detector.getActiveBans();
      expect(active).toHaveLength(1);
      expect(active[0].agentId).toBe('agent2');
    });

    it('unban returns false for non-existent ban', () => {
      expect(detector.unban('nonexistent')).toBe(false);
    });
  });

  // ── Spam Detection ───────────────────────────────────────────────

  describe('spam detection', () => {
    it('allows normal messaging to few recipients', () => {
      for (let i = 0; i < 4; i++) {
        expect(detector.recordMessage('agent1', `recipient${i}`)).toBeNull();
      }
    });

    it('bans agent sending to too many unique recipients in 1 minute', () => {
      for (let i = 0; i < 4; i++) {
        expect(detector.recordMessage('agent1', `recipient${i}`)).toBeNull();
      }
      const ban = detector.recordMessage('agent1', 'recipient4');
      expect(ban).not.toBeNull();
      expect(ban!.pattern).toBe('spam');
      expect(ban!.reason).toContain('unique recipients');
    });

    it('resets recipient window after 1 minute', () => {
      for (let i = 0; i < 4; i++) {
        detector.recordMessage('agent1', `recipient${i}`);
      }
      // Advance past window
      now += 61_000;
      // Should be allowed again
      expect(detector.recordMessage('agent1', 'newrecipient')).toBeNull();
    });

    it('does not count same recipient multiple times', () => {
      for (let i = 0; i < 10; i++) {
        expect(detector.recordMessage('agent1', 'same-recipient')).toBeNull();
      }
    });
  });

  // ── Flooding Detection ───────────────────────────────────────────

  describe('flooding detection', () => {
    it('allows normal rate messages', () => {
      for (let i = 0; i < 20; i++) {
        expect(detector.recordMessage('agent1', 'recipient1')).toBeNull();
        now += 1000; // 1 msg/sec = 60/min, within normal range
      }
    });

    it('bans agent flooding sustained high rate', () => {
      // Need 10x normal (10) = 100/min sustained for 2 minutes = 200 total messages
      // normalRatePerMinute=10, floodingRateMultiplier=3 => threshold=30/min
      // sustained for 2 min = 60 total messages at 30/min threshold
      let banned = false;
      for (let i = 0; i < 100; i++) {
        const result = detector.recordMessage('agent1', 'recipient1');
        if (result) {
          banned = true;
          expect(result.pattern).toBe('flooding');
          break;
        }
        now += 100; // 10 msgs/sec = very fast
      }
      expect(banned).toBe(true);
    });
  });

  // ── Connection Churn ─────────────────────────────────────────────

  describe('connection churn', () => {
    it('allows normal connection patterns', () => {
      for (let i = 0; i < 9; i++) {
        expect(detector.recordConnection('agent1')).toBeNull();
      }
    });

    it('bans agent with excessive connection churn', () => {
      for (let i = 0; i < 9; i++) {
        expect(detector.recordConnection('agent1')).toBeNull();
      }
      const ban = detector.recordConnection('agent1');
      expect(ban).not.toBeNull();
      expect(ban!.pattern).toBe('connection_churn');
    });

    it('old connection events expire', () => {
      for (let i = 0; i < 9; i++) {
        detector.recordConnection('agent1');
      }
      // Advance past 1 hour
      now += 61 * 60 * 1000;
      expect(detector.recordConnection('agent1')).toBeNull();
    });
  });

  // ── Oversized Payloads ───────────────────────────────────────────

  describe('oversized payloads', () => {
    it('warns but does not ban on first attempts', () => {
      expect(detector.recordOversizedPayload('agent1')).toBeNull();
      expect(detector.recordOversizedPayload('agent1')).toBeNull();
    });

    it('bans after exceeding warning threshold', () => {
      detector.recordOversizedPayload('agent1');
      detector.recordOversizedPayload('agent1');
      const ban = detector.recordOversizedPayload('agent1');
      expect(ban).not.toBeNull();
      expect(ban!.pattern).toBe('oversized_payload');
    });
  });

  // ── Sybil Resistance ────────────────────────────────────────────

  describe('Sybil resistance', () => {
    it('limits new agents in first hour', () => {
      for (let i = 0; i < 5; i++) {
        const check = detector.checkSybilLimit('newagent');
        expect(check.allowed).toBe(true);
      }
      const check = detector.checkSybilLimit('newagent');
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain('first hour');
    });

    it('allows more messages in second hour', () => {
      // Exhaust first hour
      for (let i = 0; i < 5; i++) {
        detector.checkSybilLimit('newagent');
      }
      expect(detector.checkSybilLimit('newagent').allowed).toBe(false);

      // Advance to second hour
      now += 61 * 60 * 1000;
      for (let i = 0; i < 15; i++) {
        const check = detector.checkSybilLimit('newagent');
        expect(check.allowed).toBe(true);
      }
      expect(detector.checkSybilLimit('newagent').allowed).toBe(false);
    });

    it('graduates after configured time', () => {
      // Register agent
      detector.checkSybilLimit('newagent');
      // Advance past graduation
      now += 2 * 60 * 60 * 1000 + 1;
      const check = detector.checkSybilLimit('newagent');
      expect(check.allowed).toBe(true);
      expect(check.remaining).toBe(Infinity);
    });

    it('tracks first-seen separately per agent', () => {
      // Agent 1 exhausts first hour limit
      for (let i = 0; i < 5; i++) {
        detector.checkSybilLimit('agent1');
      }
      expect(detector.checkSybilLimit('agent1').allowed).toBe(false);

      // Agent 2 should still be fine
      expect(detector.checkSybilLimit('agent2').allowed).toBe(true);
    });
  });

  // ── Event System ─────────────────────────────────────────────────

  describe('event system', () => {
    it('emits abuse events', () => {
      const events: AbuseEvent[] = [];
      detector.onAbuse(e => events.push(e));

      // Trigger spam ban
      for (let i = 0; i < 5; i++) {
        detector.recordMessage('agent1', `r${i}`);
      }

      expect(events).toHaveLength(1);
      expect(events[0].pattern).toBe('spam');
      expect(events[0].agentId).toBe('agent1');
    });

    it('listener errors do not break detection', () => {
      detector.onAbuse(() => { throw new Error('listener crash'); });

      // Should not throw
      for (let i = 0; i < 5; i++) {
        detector.recordMessage('agent1', `r${i}`);
      }
    });
  });

  // ── Stats ────────────────────────────────────────────────────────

  describe('stats', () => {
    it('reports stats', () => {
      detector.recordConnection('agent1');
      detector.recordConnection('agent2');
      detector.ban('agent3', 'test', 60_000);

      const stats = detector.getStats();
      expect(stats.trackedAgents).toBe(2);
      expect(stats.newAgents).toBe(2);
      expect(stats.activeBans).toBe(1);
    });
  });

  // ── Cleanup ──────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('removes expired bans', () => {
      detector.ban('agent1', 'test', 30_000);
      expect(detector.getActiveBans()).toHaveLength(1);

      now += 31_000;
      detector.cleanup();
      expect(detector.getActiveBans()).toHaveLength(0);
    });

    it('removes stale tracking data', () => {
      detector.recordMessage('agent1', 'recipient1');
      // Advance past cleanup threshold (10 minutes)
      now += 11 * 60 * 1000;
      detector.cleanup();
      // No error means cleanup succeeded
    });

    it('removes graduated agents from Sybil tracking', () => {
      detector.checkSybilLimit('agent1');
      now += 2 * 60 * 60 * 1000 + 1;
      detector.cleanup();
      const stats = detector.getStats();
      expect(stats.newAgents).toBe(0);
    });
  });

  // ── Destroy ──────────────────────────────────────────────────────

  describe('destroy', () => {
    it('clears all state', () => {
      detector.ban('agent1', 'test', 60_000);
      detector.recordConnection('agent2');
      detector.recordMessage('agent3', 'r1');

      detector.destroy();

      expect(detector.getActiveBans()).toHaveLength(0);
      expect(detector.isBanned('agent1')).toBeNull();
      expect(detector.getStats().trackedAgents).toBe(0);
    });
  });
});
