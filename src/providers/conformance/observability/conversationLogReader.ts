/**
 * Conformance suite for ConversationLogReader primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { ConversationLogReader } from '../../primitives/observability/conversationLogReader.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runConversationLogReaderConformance(
  factory: ConformanceFactory<ConversationLogReader>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.ConversationLogReader);
  expect.hasMethod(impl as object, 'read');
  expect.hasMethod(impl as object, 'readStream');
  })();
}
