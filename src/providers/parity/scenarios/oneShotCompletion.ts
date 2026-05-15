/**
 * Parity scenarios for OneShotCompletion.
 *
 * Both adapters claim CapabilityFlag.OneShotCompletion. These scenarios
 * exercise structural equivalence and (when realApi=1) behavioral
 * equivalence on a small fixed-cost prompt set.
 */

import { CapabilityFlag } from '../../capabilities.js';
import type { OneShotCompletion, OneShotCompletionResult } from '../../primitives/transport/oneShotCompletion.js';
import type { ParityScenario } from '../runner.js';

const ARITHMETIC_PROMPT = 'What is 2+2? Reply with only the number, no other text.';

function getOneShot(adapter: { primitive(c: CapabilityFlag): unknown }): OneShotCompletion {
  return adapter.primitive(CapabilityFlag.OneShotCompletion) as OneShotCompletion;
}

/**
 * Both adapters expose a callable OneShotCompletion primitive.
 *
 * Always runs (no real API). Catches catastrophic misregistration where
 * one adapter forgot to wire the primitive into its impls map.
 */
export const primitiveShape: ParityScenario = async ({ left, right }) => {
  const l = getOneShot(left);
  const r = getOneShot(right);
  if (l.capability !== CapabilityFlag.OneShotCompletion) {
    return { scenario: '', status: 'fail', reason: `left capability flag wrong: ${String(l.capability)}` };
  }
  if (r.capability !== CapabilityFlag.OneShotCompletion) {
    return { scenario: '', status: 'fail', reason: `right capability flag wrong: ${String(r.capability)}` };
  }
  if (typeof l.evaluate !== 'function' || typeof r.evaluate !== 'function') {
    return { scenario: '', status: 'fail', reason: 'evaluate method missing on one side' };
  }
  return { scenario: '', status: 'pass' };
};

/**
 * Both adapters return a structurally-equivalent OneShotCompletionResult
 * for an arithmetic prompt. Equivalence means: both responses contain
 * "4", both have a `usage` field (possibly null), both have `text` as
 * non-empty trimmed string.
 *
 * Gated by realApi. Cost: 2 prompts (one per adapter) of ~20 tokens each.
 */
export const arithmeticParity: ParityScenario = async ({ left, right, ctx }) => {
  if (!ctx.realApi) {
    return { scenario: '', status: 'skip', reason: 'realApi disabled' };
  }
  const l = getOneShot(left);
  const r = getOneShot(right);
  const timeoutMs = ctx.timeoutMs ?? 120_000;

  let leftRes: OneShotCompletionResult;
  let rightRes: OneShotCompletionResult;
  try {
    leftRes = await l.evaluate(ARITHMETIC_PROMPT, { timeoutMs, model: 'fast' });
  } catch (err) {
    return { scenario: '', status: 'fail', reason: `left evaluate threw: ${(err as Error).message}` };
  }
  try {
    rightRes = await r.evaluate(ARITHMETIC_PROMPT, { timeoutMs, model: 'fast' });
  } catch (err) {
    return { scenario: '', status: 'fail', reason: `right evaluate threw: ${(err as Error).message}` };
  }

  const observations = {
    left: { text: leftRes.text, hasUsage: leftRes.usage !== null },
    right: { text: rightRes.text, hasUsage: rightRes.usage !== null },
  };

  if (typeof leftRes.text !== 'string' || leftRes.text.length === 0) {
    return { scenario: '', status: 'fail', reason: 'left text empty', observations };
  }
  if (typeof rightRes.text !== 'string' || rightRes.text.length === 0) {
    return { scenario: '', status: 'fail', reason: 'right text empty', observations };
  }
  if (!/4/.test(leftRes.text) || !/4/.test(rightRes.text)) {
    return { scenario: '', status: 'fail', reason: 'response missing "4"', observations };
  }
  // usage field SHOULD be present-or-null on both (structural equivalence)
  if (!('usage' in leftRes) || !('usage' in rightRes)) {
    return { scenario: '', status: 'fail', reason: 'usage field missing on result', observations };
  }
  return { scenario: '', status: 'pass', observations };
};

/**
 * Both adapters honor an AbortSignal and surface the cancellation as a
 * thrown error rather than resolving with a partial response.
 *
 * Gated by realApi. Cost: 2 short prompts that get aborted immediately.
 */
export const abortSignalParity: ParityScenario = async ({ left, right, ctx }) => {
  if (!ctx.realApi) {
    return { scenario: '', status: 'skip', reason: 'realApi disabled' };
  }
  const l = getOneShot(left);
  const r = getOneShot(right);

  async function abortImmediately(p: OneShotCompletion): Promise<string> {
    const controller = new AbortController();
    // Abort before evaluate runs — should surface as an error or never resolve.
    controller.abort();
    try {
      const result = await Promise.race([
        p.evaluate(ARITHMETIC_PROMPT, { signal: controller.signal, timeoutMs: 5_000 }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('did-not-abort')), 5_000)),
      ]);
      return `resolved:${(result as OneShotCompletionResult).text.slice(0, 20)}`;
    } catch (err) {
      return `threw:${(err as Error).name}`;
    }
  }

  const leftOutcome = await abortImmediately(l);
  const rightOutcome = await abortImmediately(r);
  const observations = { left: leftOutcome, right: rightOutcome };

  // Both should throw, not resolve. Specific error class may differ across
  // adapters but neither should return a fabricated successful response.
  if (leftOutcome.startsWith('resolved:') || rightOutcome.startsWith('resolved:')) {
    return { scenario: '', status: 'fail', reason: 'one side ignored abort and resolved', observations };
  }
  return { scenario: '', status: 'pass', observations };
};

/**
 * Full OneShotCompletion parity scenario set. Adapter packages import
 * this and pass to runParitySuite.
 */
export const oneShotCompletionScenarios = [
  { name: 'oneShot/primitiveShape', run: primitiveShape },
  { name: 'oneShot/arithmeticParity', run: arithmeticParity },
  { name: 'oneShot/abortSignalParity', run: abortSignalParity },
] as const;
