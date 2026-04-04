import { describe, it, expect } from 'vitest';
import {
  evaluateTrust,
  canUpgradeTrust,
  evaluateSameMachineTrust,
  type TrustSignals,
} from '../../../src/threadline/TrustEvaluator.js';

describe('TrustEvaluator', () => {
  const baseSignals: TrustSignals = {
    localLevel: 'verified',
    source: 'user-granted',
    lastInteraction: new Date().toISOString(),
    successCount: 10,
    failureCount: 0,
    circuitBreakerActivations: 0,
  };

  describe('evaluateTrust', () => {
    it('returns local trust level when no decay or breaker', () => {
      const result = evaluateTrust(baseSignals);
      expect(result.level).toBe('verified');
      expect(result.downgraded).toBe(false);
    });

    it('downgrades on circuit breaker activations >= 3', () => {
      const result = evaluateTrust({ ...baseSignals, circuitBreakerActivations: 3 });
      expect(result.level).toBe('untrusted');
      expect(result.downgraded).toBe(true);
      expect(result.reason).toContain('circuit breaker');
    });

    it('decays trusted → verified after 90 days inactivity', () => {
      const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
      const result = evaluateTrust({
        ...baseSignals, localLevel: 'trusted', lastInteraction: old,
      });
      expect(result.level).toBe('verified');
      expect(result.downgraded).toBe(true);
    });

    it('does NOT decay trusted → untrusted directly (must go through verified)', () => {
      const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      const result = evaluateTrust({
        ...baseSignals, localLevel: 'trusted', lastInteraction: old,
      });
      // 100 days > 90 → decays to verified, but < 270 → stays verified
      expect(result.level).toBe('verified');
    });

    it('decays to untrusted after 270+ days', () => {
      const old = new Date(Date.now() - 271 * 24 * 60 * 60 * 1000).toISOString();
      const result = evaluateTrust({
        ...baseSignals, localLevel: 'trusted', lastInteraction: old,
      });
      expect(result.level).toBe('untrusted');
    });

    it('adds network advisory for low IQS', () => {
      const result = evaluateTrust({ ...baseSignals, networkIQS: 'low' });
      expect(result.networkAdvisory).toContain('LOW');
    });

    it('adds network advisory for high IQS on untrusted agent', () => {
      const result = evaluateTrust({
        ...baseSignals, localLevel: 'untrusted', networkIQS: 'high',
      });
      expect(result.networkAdvisory).toContain('HIGH');
    });

    it('no advisory when IQS and local trust align', () => {
      const result = evaluateTrust({ ...baseSignals, networkIQS: 'high' });
      expect(result.networkAdvisory).toBeUndefined();
    });
  });

  describe('canUpgradeTrust', () => {
    it('allows user-granted upgrade', () => {
      const result = canUpgradeTrust('untrusted', 'verified', 'user-granted');
      expect(result.allowed).toBe(true);
    });

    it('allows paired-machine-granted upgrade', () => {
      const result = canUpgradeTrust('verified', 'trusted', 'paired-machine-granted');
      expect(result.allowed).toBe(true);
    });

    it('allows invitation-based upgrade', () => {
      const result = canUpgradeTrust('untrusted', 'verified', 'invitation');
      expect(result.allowed).toBe(true);
    });

    it('rejects setup-default upgrade', () => {
      const result = canUpgradeTrust('untrusted', 'verified', 'setup-default');
      expect(result.allowed).toBe(false);
    });

    it('rejects downgrade attempt via upgrade path', () => {
      const result = canUpgradeTrust('trusted', 'verified', 'user-granted');
      expect(result.allowed).toBe(false);
    });

    it('rejects same-level upgrade', () => {
      const result = canUpgradeTrust('verified', 'verified', 'user-granted');
      expect(result.allowed).toBe(false);
    });
  });

  describe('evaluateSameMachineTrust', () => {
    it('eligible when same user + local transport', () => {
      const result = evaluateSameMachineTrust(501, 501, true);
      expect(result.eligible).toBe(true);
    });

    it('not eligible with different user', () => {
      const result = evaluateSameMachineTrust(501, 502, true);
      expect(result.eligible).toBe(false);
    });

    it('not eligible without local transport', () => {
      const result = evaluateSameMachineTrust(501, 501, false);
      expect(result.eligible).toBe(false);
    });
  });
});
