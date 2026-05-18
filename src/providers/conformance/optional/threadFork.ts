/**
 * Conformance suite for ThreadFork primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { ThreadFork } from '../../primitives/optional/threadFork.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runThreadForkConformance(
  factory: ConformanceFactory<ThreadFork>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.ThreadFork);
  expect.hasMethod(impl as object, 'canFork');
  expect.hasMethod(impl as object, 'fork');
  })();
}
