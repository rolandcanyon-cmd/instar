/**
 * Unit tests for buildCanaryLlmFallback.
 *
 * Verifies the helper wraps an IntelligenceProvider into the
 * CanaryLlmFallback shape the canary expects, with correct parsing,
 * fail-safe error handling, and intentionally narrow prompt budget.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildCanaryLlmFallback } from '../../../../../src/providers/adapters/anthropic-interactive-pool/index.js';
import type { IntelligenceProvider } from '../../../../../src/core/types.js';

const CTX = { canaryPrompt: 'say PONG', canaryExpected: /PONG/ };
const PANE = 'header\n...\n❯ ';

function makeProvider(impl: IntelligenceProvider['evaluate']): IntelligenceProvider {
  return { evaluate: impl };
}

describe('buildCanaryLlmFallback', () => {
  it('returns "complete" when the LLM says complete', async () => {
    const evaluate = vi.fn(async () => 'complete');
    const fallback = buildCanaryLlmFallback(makeProvider(evaluate));
    expect(await fallback(PANE, CTX)).toBe('complete');
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('returns "not-complete" when the LLM says not-complete', async () => {
    const fallback = buildCanaryLlmFallback(makeProvider(async () => 'not-complete'));
    expect(await fallback(PANE, CTX)).toBe('not-complete');
  });

  it('returns "not-complete" when the LLM says "not complete" (with space)', async () => {
    const fallback = buildCanaryLlmFallback(makeProvider(async () => 'not complete'));
    expect(await fallback(PANE, CTX)).toBe('not-complete');
  });

  it('tolerates surrounding whitespace and casing', async () => {
    const fallback = buildCanaryLlmFallback(makeProvider(async () => '  COMPLETE  \n'));
    expect(await fallback(PANE, CTX)).toBe('complete');
  });

  it('returns "error" for any verdict that is not complete/not-complete', async () => {
    const fallback = buildCanaryLlmFallback(makeProvider(async () => 'unclear'));
    expect(await fallback(PANE, CTX)).toBe('error');
  });

  it('returns "error" when the provider throws (never propagates)', async () => {
    const fallback = buildCanaryLlmFallback(
      makeProvider(async () => {
        throw new Error('provider exploded');
      }),
    );
    expect(await fallback(PANE, CTX)).toBe('error');
  });

  it('routes to the fast tier with a narrow token budget', async () => {
    const evaluate = vi.fn(async () => 'complete');
    const fallback = buildCanaryLlmFallback(makeProvider(evaluate));
    await fallback(PANE, CTX);
    const opts = evaluate.mock.calls[0]?.[1];
    expect(opts?.model).toBe('fast');
    expect(opts?.maxTokens).toBeLessThanOrEqual(32);
    expect(opts?.temperature).toBe(0);
  });

  it('passes capturedPane (bottom 30 lines) into the prompt', async () => {
    const evaluate = vi.fn(async () => 'complete');
    const fallback = buildCanaryLlmFallback(makeProvider(evaluate));
    const longPane = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
    await fallback(longPane, CTX);
    const prompt = evaluate.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('line99');
    expect(prompt).toContain('line70');  // bottom 30 of 100 starts at line70
    expect(prompt).not.toContain('line10');  // outside the window
  });
});
