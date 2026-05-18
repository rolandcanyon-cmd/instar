/**
 * Unit tests for the substrate-level stub marker.
 *
 * Verifies that adapter-level createStubPrimitive factories declare
 * themselves via the STUB_MARKER symbol AND that the marker can be read
 * without triggering the stub's throwing-method branch.
 */

import { describe, it, expect } from 'vitest';
import { isStubPrimitive, STUB_MARKER } from '../../../src/providers/markers.js';
import { createStubPrimitive as headlessStub } from '../../../src/providers/adapters/anthropic-headless/stubs.js';
import { createStubPrimitive as poolStub } from '../../../src/providers/adapters/anthropic-interactive-pool/stubs.js';
import { CapabilityFlag } from '../../../src/providers/capabilities.js';

describe('isStubPrimitive', () => {
  it('returns true for the headless stub factory output', () => {
    const stub = headlessStub(CapabilityFlag.StructuredOneShot);
    expect(isStubPrimitive(stub)).toBe(true);
  });

  it('returns true for the pool stub factory output', () => {
    const stub = poolStub(CapabilityFlag.StructuredOneShot);
    expect(isStubPrimitive(stub)).toBe(true);
  });

  it('returns false for a real primitive impl (plain object with capability)', () => {
    const real = { capability: CapabilityFlag.OneShotCompletion, evaluate: () => Promise.resolve({ text: '4', usage: null }) };
    expect(isStubPrimitive(real)).toBe(false);
  });

  it('returns false for null / undefined / non-object', () => {
    expect(isStubPrimitive(null)).toBe(false);
    expect(isStubPrimitive(undefined)).toBe(false);
    expect(isStubPrimitive(42)).toBe(false);
    expect(isStubPrimitive('stub')).toBe(false);
  });

  it('reading the marker does not throw on a stub (the proxy must handle Symbol gets)', () => {
    const stub = headlessStub(CapabilityFlag.WarmSessionInbox);
    // The stub's other props throw — but the marker (Symbol) must NOT.
    expect(() => isStubPrimitive(stub)).not.toThrow();
    // Calling any method should still throw.
    expect(() => (stub as { foo: () => void }).foo()).toThrow();
  });

  it('the marker symbol is the canonical one used by adapters', () => {
    // If the symbol identity drifted (e.g., re-export confusion), this catches it.
    const stub = poolStub(CapabilityFlag.OneShotCompletion);
    expect((stub as Record<symbol, unknown>)[STUB_MARKER]).toBe(true);
  });
});
