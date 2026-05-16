/**
 * Unit tests for PreferenceStore (Phase 5b.1 — storage layer).
 *
 * Uses ':memory:' sqlite so tests don't touch the filesystem.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PreferenceStore,
  type FrameworkModelPreference,
} from '../../../../src/providers/uxConfirm/PreferenceStore.js';
import type { CostStateSnapshot } from '../../../../src/providers/costAwareRouting.js';

const COST: CostStateSnapshot = {
  capturedAt: '2026-05-15T00:00:00Z',
  agentSdkCredit: {
    remainingUsd: 180,
    totalUsd: 200,
    safetyMarginUsd: 20,
    belowMargin: false,
    consumedFraction: 0.1,
  },
};

function makePref(overrides: Partial<FrameworkModelPreference> = {}): FrameworkModelPreference {
  return {
    framework: 'claude-code',
    model: 'opus-4.7',
    confirmedAt: '2026-05-15T00:00:00Z',
    costStateSnapshot: COST,
    catalogVersionAtCache: 'v0.1',
    confidenceAtCache: 'HIGH',
    ...overrides,
  };
}

describe('PreferenceStore', () => {
  let store: PreferenceStore;

  beforeEach(() => {
    store = new PreferenceStore({ dbPath: ':memory:' });
  });

  afterEach(() => {
    store.close();
  });

  it('returns null for a never-set (user, pattern)', () => {
    expect(store.get('justin', 'code-refactor-typescript')).toBeNull();
  });

  it('stores and retrieves a preference', () => {
    const pref = makePref();
    store.set('justin', 'code-refactor-typescript', pref);
    const got = store.get('justin', 'code-refactor-typescript');
    expect(got).toEqual(pref);
  });

  it('overwrites on duplicate set (last write wins)', () => {
    store.set('justin', 'task-x', makePref({ framework: 'claude-code', model: 'opus-4.7' }));
    store.set('justin', 'task-x', makePref({ framework: 'codex-cli', model: 'gpt-5.3-codex' }));
    const got = store.get('justin', 'task-x');
    expect(got?.framework).toBe('codex-cli');
    expect(got?.model).toBe('gpt-5.3-codex');
  });

  it('keys per-user — same pattern under different users does not collide', () => {
    store.set('justin', 'task-x', makePref({ framework: 'claude-code' }));
    store.set('alice', 'task-x', makePref({ framework: 'codex-cli' }));
    expect(store.get('justin', 'task-x')?.framework).toBe('claude-code');
    expect(store.get('alice', 'task-x')?.framework).toBe('codex-cli');
  });

  it('roundtrips a complex CostStateSnapshot through JSON storage', () => {
    const pref = makePref();
    store.set('justin', 'task-x', pref);
    const got = store.get('justin', 'task-x');
    expect(got?.costStateSnapshot.agentSdkCredit?.remainingUsd).toBe(180);
    expect(got?.costStateSnapshot.agentSdkCredit?.belowMargin).toBe(false);
  });

  it('handles null agentSdkCredit in snapshot', () => {
    const pref = makePref({
      costStateSnapshot: { capturedAt: '2026-05-15T00:00:00Z', agentSdkCredit: null },
    });
    store.set('justin', 'task-x', pref);
    const got = store.get('justin', 'task-x');
    expect(got?.costStateSnapshot.agentSdkCredit).toBeNull();
  });

  it('clear removes one (user, pattern) and leaves others alone', () => {
    store.set('justin', 'task-x', makePref());
    store.set('justin', 'task-y', makePref());
    store.clear('justin', 'task-x');
    expect(store.get('justin', 'task-x')).toBeNull();
    expect(store.get('justin', 'task-y')).not.toBeNull();
  });

  it('clear is a no-op for a non-existent pair', () => {
    expect(() => store.clear('justin', 'never-set')).not.toThrow();
  });

  it('clearAll removes every preference for a user', () => {
    store.set('justin', 'task-x', makePref());
    store.set('justin', 'task-y', makePref());
    store.set('alice', 'task-x', makePref());
    store.clearAll('justin');
    expect(store.get('justin', 'task-x')).toBeNull();
    expect(store.get('justin', 'task-y')).toBeNull();
    expect(store.get('alice', 'task-x')).not.toBeNull();
  });

  it('listPatterns returns patterns this user has confirmed, sorted', () => {
    store.set('justin', 'task-b', makePref());
    store.set('justin', 'task-a', makePref());
    store.set('alice', 'task-x', makePref());
    expect(store.listPatterns('justin')).toEqual(['task-a', 'task-b']);
  });

  it('listPatterns returns empty array for a user with no preferences', () => {
    expect(store.listPatterns('nobody')).toEqual([]);
  });
});
