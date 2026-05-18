/**
 * UsageMeterProvider implementation for openai-codex.
 *
 * Codex has no documented public usage endpoint (per the deep-dive §D).
 * isAuthoritative() returns FALSE; the implementation falls back to local
 * accounting from `turn.completed.usage` events accumulated in the
 * session-event stream. Callers needing exact billable spend must
 * cross-reference with OpenAI's web dashboard.
 *
 * RULE 3.1 RATIONALE
 *   Criticality: high (cost-routing input)
 *   Frequency:   per-poll (5-60min)
 *   Stability:   stable (local accounting won't drift)
 *   Fallback:    return null when no data has been accumulated
 *   Verdict:     deterministic local-accounting; canary verifies turn.completed.usage parsing
 */

import type { CancellationOptions } from '../../../types.js';
import type {
  UsageMeterProvider,
  UsageSnapshot,
  UsageWindow,
} from '../../../primitives/observability/usageMeterProvider.js';
import { CapabilityFlag } from '../../../capabilities.js';

// Module-level accumulator that the agentic-session stream feeds when it
// observes `turn.completed.usage` events.
let totalInputTokens = 0;
let totalOutputTokens = 0;
let lastUpdate: string | null = null;

/** Called by the event stream when a turn.completed event arrives. */
export function recordTurnUsage(inputTokens: number, outputTokens: number): void {
  totalInputTokens += inputTokens;
  totalOutputTokens += outputTokens;
  lastUpdate = new Date().toISOString();
}

class OpenAiCodexUsageMeterProvider implements UsageMeterProvider {
  readonly capability = CapabilityFlag.UsageMeterProvider;
  isAuthoritative(): boolean { return false; }

  async read(_options?: CancellationOptions): Promise<UsageSnapshot | null> {
    if (lastUpdate === null) return null;
    const window: UsageWindow = {
      granularity: 'session',
      resetsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      usedPercent: 0,
      usedAbsolute: totalInputTokens + totalOutputTokens,
      unit: 'tokens',
    };
    return {
      capturedAt: new Date().toISOString(),
      source: 'estimated',
      windows: [window],
      agentSdkCredit: null,
    };
  }
}

export function createUsageMeterProvider(): UsageMeterProvider {
  return new OpenAiCodexUsageMeterProvider();
}

/** Reset local accumulator. Used by tests. */
export function _resetAccumulator(): void {
  totalInputTokens = 0;
  totalOutputTokens = 0;
  lastUpdate = null;
}
