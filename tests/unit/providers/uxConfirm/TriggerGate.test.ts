/**
 * Unit tests for TriggerGate (Phase 5b.1 — decision logic).
 *
 * Verifies the priority order new-pattern > cost-shift > low-confidence
 * > silent-use, and that each path produces the documented reason.
 */

import { describe, it, expect } from 'vitest';
import { runTriggerGate } from '../../../../src/providers/uxConfirm/TriggerGate.js';
import type {
  FrameworkModelPreference,
  ConfidenceLevel,
} from '../../../../src/providers/uxConfirm/PreferenceStore.js';
import { CostStateTracker, type CostStateSnapshot } from '../../../../src/providers/costAwareRouting.js';

const tracker = new CostStateTracker({
  readSdkCredit: async () => null,
  safetyMarginFraction: 0.10,
  materialDriftFraction: 0.25,
});

function snap(remaining: number | null, total: number = 200): CostStateSnapshot {
  if (remaining === null) {
    return { capturedAt: '2026-05-15T00:00:00Z', agentSdkCredit: null };
  }
  const safetyMarginUsd = 0.10 * total;
  return {
    capturedAt: '2026-05-15T00:00:00Z',
    agentSdkCredit: {
      remainingUsd: remaining,
      totalUsd: total,
      safetyMarginUsd,
      belowMargin: remaining <= safetyMarginUsd,
      consumedFraction: total > 0 ? 1 - remaining / total : 0,
    },
  };
}

function makePref(overrides: Partial<FrameworkModelPreference> = {}): FrameworkModelPreference {
  return {
    framework: 'claude-code',
    model: 'opus-4.7',
    confirmedAt: '2026-05-15T00:00:00Z',
    costStateSnapshot: snap(180),
    catalogVersionAtCache: 'v0.1',
    confidenceAtCache: 'HIGH',
    ...overrides,
  };
}

describe('TriggerGate priority and outcomes', () => {
  it('ask-new-pattern when cached is null', () => {
    const outcome = runTriggerGate({
      cached: null,
      currentCostState: snap(180),
      currentCatalogVersion: 'v0.1',
      costStateTracker: tracker,
    });
    expect(outcome.kind).toBe('ask-new-pattern');
  });

  it('silent-use when cache is fresh, cost stable, catalog unchanged', () => {
    const cached = makePref();
    const outcome = runTriggerGate({
      cached,
      currentCostState: snap(180), // identical
      currentCatalogVersion: 'v0.1', // identical
      costStateTracker: tracker,
    });
    expect(outcome.kind).toBe('silent-use');
    if (outcome.kind === 'silent-use') {
      expect(outcome.preference).toEqual(cached);
    }
  });

  it('ask-cost-shift when SDK credit drops below margin', () => {
    const outcome = runTriggerGate({
      cached: makePref({ costStateSnapshot: snap(180) }),
      currentCostState: snap(10), // crossed below margin
      currentCatalogVersion: 'v0.1',
      costStateTracker: tracker,
    });
    expect(outcome.kind).toBe('ask-cost-shift');
    if (outcome.kind === 'ask-cost-shift') {
      expect(outcome.reason).toContain('crossed-below-safety-margin');
    }
  });

  it('ask-cost-shift wins over silent-use even when confidence is HIGH', () => {
    const outcome = runTriggerGate({
      cached: makePref({ confidenceAtCache: 'HIGH', costStateSnapshot: snap(180) }),
      currentCostState: snap(60), // 60% drift — material
      currentCatalogVersion: 'v0.1',
      currentConfidence: 'HIGH',
      costStateTracker: tracker,
    });
    expect(outcome.kind).toBe('ask-cost-shift');
  });

  it('ask-low-confidence when catalog version bumped and confidence dropped', () => {
    const outcome = runTriggerGate({
      cached: makePref({ confidenceAtCache: 'HIGH' }),
      currentCostState: snap(180),
      currentCatalogVersion: 'v0.2', // bumped
      currentConfidence: 'MEDIUM',
      costStateTracker: tracker,
    });
    expect(outcome.kind).toBe('ask-low-confidence');
    if (outcome.kind === 'ask-low-confidence') {
      expect(outcome.reason).toContain('HIGH→MEDIUM');
    }
  });

  it('ask-low-confidence when catalog version bumped and current confidence is LOW', () => {
    const outcome = runTriggerGate({
      cached: makePref({ confidenceAtCache: 'LOW' }),
      currentCostState: snap(180),
      currentCatalogVersion: 'v0.2',
      currentConfidence: 'LOW',
      costStateTracker: tracker,
    });
    expect(outcome.kind).toBe('ask-low-confidence');
  });

  it('ask-low-confidence when catalog version bumped and current confidence is PROVISIONAL', () => {
    const outcome = runTriggerGate({
      cached: makePref({ confidenceAtCache: 'MEDIUM' }),
      currentCostState: snap(180),
      currentCatalogVersion: 'v0.2',
      currentConfidence: 'PROVISIONAL',
      costStateTracker: tracker,
    });
    expect(outcome.kind).toBe('ask-low-confidence');
  });

  it('silent-use when catalog bumped but confidence is still HIGH and unchanged', () => {
    const outcome = runTriggerGate({
      cached: makePref({ confidenceAtCache: 'HIGH' }),
      currentCostState: snap(180),
      currentCatalogVersion: 'v0.2', // bumped
      currentConfidence: 'HIGH', // unchanged
      costStateTracker: tracker,
    });
    expect(outcome.kind).toBe('silent-use');
  });

  it('silent-use when catalog unchanged, regardless of cached confidence level', () => {
    // Even cached at PROVISIONAL — if catalog hasn't moved, re-asking would
    // produce the same answer. Don't re-ask.
    const outcome = runTriggerGate({
      cached: makePref({ confidenceAtCache: 'PROVISIONAL' }),
      currentCostState: snap(180),
      currentCatalogVersion: 'v0.1', // same as cache
      currentConfidence: 'PROVISIONAL',
      costStateTracker: tracker,
    });
    expect(outcome.kind).toBe('silent-use');
  });

  it('priority: ask-new-pattern beats everything else', () => {
    const outcome = runTriggerGate({
      cached: null,
      currentCostState: snap(10), // would be cost-shift
      currentCatalogVersion: 'v0.2', // would be catalog bump
      costStateTracker: tracker,
    });
    expect(outcome.kind).toBe('ask-new-pattern');
  });

  it('priority: ask-cost-shift beats ask-low-confidence', () => {
    const outcome = runTriggerGate({
      cached: makePref({ confidenceAtCache: 'HIGH', costStateSnapshot: snap(180) }),
      currentCostState: snap(10), // crossed margin → cost-shift
      currentCatalogVersion: 'v0.2', // bumped
      currentConfidence: 'LOW', // would be low-confidence
      costStateTracker: tracker,
    });
    expect(outcome.kind).toBe('ask-cost-shift');
  });

  it('handles currentConfidence omitted by falling back to cached confidence', () => {
    // When the caller doesn't supply currentConfidence, the gate treats it
    // as unchanged. Same as cachedConfidence → no drop.
    const outcome = runTriggerGate({
      cached: makePref({ confidenceAtCache: 'HIGH' }),
      currentCostState: snap(180),
      currentCatalogVersion: 'v0.2', // bumped
      // currentConfidence omitted
      costStateTracker: tracker,
    });
    expect(outcome.kind).toBe('silent-use');
  });
});
