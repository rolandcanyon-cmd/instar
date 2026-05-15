/**
 * Conformance suite for ThreadGoalSlot primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { ThreadGoalSlot } from '../../primitives/optional/threadGoalSlot.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runThreadGoalSlotConformance(
  factory: ConformanceFactory<ThreadGoalSlot>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.ThreadGoalSlot);
  expect.hasMethod(impl as object, 'get');
  expect.hasMethod(impl as object, 'set');
  expect.hasMethod(impl as object, 'clear');
  })();
}
