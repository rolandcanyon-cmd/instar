/**
 * Conformance suite for ConversationLogTailer primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { ConversationLogTailer } from '../../primitives/observability/conversationLogTailer.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runConversationLogTailerConformance(
  factory: ConformanceFactory<ConversationLogTailer>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.ConversationLogTailer);
  expect.hasMethod(impl as object, 'tail');
  })();
}
