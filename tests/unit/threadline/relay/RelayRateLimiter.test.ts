import { describe, it, expect, beforeEach } from 'vitest';
import { RelayRateLimiter } from '../../../../src/threadline/relay/RelayRateLimiter.js';

describe('RelayRateLimiter', () => {
  let limiter: RelayRateLimiter;
  let now: number;

  beforeEach(() => {
    now = 1000000;
    limiter = new RelayRateLimiter(
      {
        perAgentPerMinute: 5,
        perAgentPerHour: 20,
        perIPPerMinute: 10,
        globalPerMinute: 50,
        discoveryPerMinute: 3,
        authAttemptsPerMinute: 2,
      },
      () => now,
    );
  });

  describe('message rate limiting', () => {
    it('allows messages within limits', () => {
      const result = limiter.checkMessage('agent-1', '1.2.3.4');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5); // check doesn't consume a slot
    });

    it('blocks after per-agent-minute limit exceeded', () => {
      for (let i = 0; i < 5; i++) {
        limiter.recordMessage('agent-1', '1.2.3.4');
      }
      const result = limiter.checkMessage('agent-1', '1.2.3.4');
      expect(result.allowed).toBe(false);
      expect(result.limitType).toBe('per_agent_minute');
    });

    it('blocks after per-IP limit exceeded', () => {
      for (let i = 0; i < 10; i++) {
        limiter.recordMessage(`agent-${i}`, '1.2.3.4');
      }
      const result = limiter.checkMessage('agent-new', '1.2.3.4');
      expect(result.allowed).toBe(false);
      expect(result.limitType).toBe('per_ip_minute');
    });

    it('resets after window expires', () => {
      for (let i = 0; i < 5; i++) {
        limiter.recordMessage('agent-1', '1.2.3.4');
      }
      expect(limiter.checkMessage('agent-1', '1.2.3.4').allowed).toBe(false);

      // Advance past 1 minute window
      now += 61_000;
      expect(limiter.checkMessage('agent-1', '1.2.3.4').allowed).toBe(true);
    });

    it('different agents have independent limits', () => {
      for (let i = 0; i < 5; i++) {
        limiter.recordMessage('agent-1', '1.2.3.4');
      }
      expect(limiter.checkMessage('agent-1', '1.2.3.4').allowed).toBe(false);
      expect(limiter.checkMessage('agent-2', '5.6.7.8').allowed).toBe(true);
    });

    it('per-hour limit enforced across minutes', () => {
      // Send 5 per minute for 4 minutes = 20 total
      for (let minute = 0; minute < 4; minute++) {
        now += 61_000; // advance past minute window
        for (let i = 0; i < 5; i++) {
          limiter.recordMessage('agent-1', '1.2.3.4');
        }
      }
      now += 61_000; // next minute
      const result = limiter.checkMessage('agent-1', '1.2.3.4');
      expect(result.allowed).toBe(false);
      expect(result.limitType).toBe('per_agent_hour');
    });
  });

  describe('discovery rate limiting', () => {
    it('allows discoveries within limit', () => {
      expect(limiter.checkDiscovery('agent-1').allowed).toBe(true);
    });

    it('blocks after discovery limit exceeded', () => {
      for (let i = 0; i < 3; i++) {
        limiter.recordDiscovery('agent-1');
      }
      expect(limiter.checkDiscovery('agent-1').allowed).toBe(false);
    });
  });

  describe('auth rate limiting', () => {
    it('allows auth within limit', () => {
      expect(limiter.checkAuth('1.2.3.4').allowed).toBe(true);
    });

    it('blocks after auth limit exceeded', () => {
      for (let i = 0; i < 2; i++) {
        limiter.recordAuth('1.2.3.4');
      }
      expect(limiter.checkAuth('1.2.3.4').allowed).toBe(false);
    });

    it('different IPs have independent auth limits', () => {
      for (let i = 0; i < 2; i++) {
        limiter.recordAuth('1.2.3.4');
      }
      expect(limiter.checkAuth('1.2.3.4').allowed).toBe(false);
      expect(limiter.checkAuth('5.6.7.8').allowed).toBe(true);
    });
  });

  describe('reset', () => {
    it('clears all limits', () => {
      for (let i = 0; i < 5; i++) {
        limiter.recordMessage('agent-1', '1.2.3.4');
      }
      expect(limiter.checkMessage('agent-1', '1.2.3.4').allowed).toBe(false);
      limiter.reset();
      expect(limiter.checkMessage('agent-1', '1.2.3.4').allowed).toBe(true);
    });
  });
});
