/**
 * Unit tests for the empty-prompt detector signature store.
 *
 * The store backs the Rule 3 self-healing path for the interactive-pool
 * adapter: the startup canary derives a new signature when Claude Code's
 * UI evolves and persists it via setSignature(). The completion detector
 * in promptRunner.ts reads via getSignature() so a self-heal is observable
 * to detection logic the same tick it's applied.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSignature,
  setSignature,
  resetSignatureForTests,
} from '../../../../../src/providers/adapters/anthropic-interactive-pool/canary/emptyPromptSignature.js';

describe('emptyPromptSignature store', () => {
  beforeEach(() => {
    resetSignatureForTests();
  });

  it('returns the default signature when nothing has been set', () => {
    const sig = getSignature();
    expect(sig.source).toBe('default');
    expect(sig.emptyPromptPattern.test('❯')).toBe(true);
    expect(sig.emptyPromptPattern.test('❯ ')).toBe(true);
    expect(sig.emptyPromptPattern.test('❯ hello')).toBe(false);
    expect(sig.anyPromptLinePattern.test('❯')).toBe(true);
    expect(sig.anyPromptLinePattern.test('❯ hello')).toBe(true);
  });

  it('setSignature replaces the active signature and stamps derivedAt', () => {
    const before = new Date().getTime();
    setSignature({
      emptyPromptPattern: /^>\s*$/,
      anyPromptLinePattern: /^>(\s|$)/,
      source: 'canary-derived',
    });
    const after = getSignature();
    expect(after.source).toBe('canary-derived');
    expect(after.emptyPromptPattern.test('>')).toBe(true);
    expect(after.emptyPromptPattern.test('> ')).toBe(true);
    expect(after.emptyPromptPattern.test('❯')).toBe(false);
    expect(new Date(after.derivedAt).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('a canary-derived signature with a different prompt char displaces the default', () => {
    // Simulate a future Claude Code update that changes the prompt glyph.
    setSignature({
      emptyPromptPattern: /^▶\s*$/,
      anyPromptLinePattern: /^▶(\s|$)/,
      source: 'canary-derived',
    });
    const sig = getSignature();
    expect(sig.emptyPromptPattern.test('▶')).toBe(true);
    expect(sig.emptyPromptPattern.test('❯')).toBe(false);
  });

  it('resetSignatureForTests restores the default for clean test isolation', () => {
    setSignature({
      emptyPromptPattern: /^!\s*$/,
      anyPromptLinePattern: /^!(\s|$)/,
      source: 'canary-derived',
    });
    expect(getSignature().source).toBe('canary-derived');
    resetSignatureForTests();
    expect(getSignature().source).toBe('default');
    expect(getSignature().emptyPromptPattern.test('❯')).toBe(true);
  });
});
