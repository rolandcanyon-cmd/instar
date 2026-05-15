/**
 * Conformance suite for CompactionLifecycle primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { CompactionLifecycle } from '../../primitives/control/compactionLifecycle.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runCompactionLifecycleConformance(
  factory: ConformanceFactory<CompactionLifecycle>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.CompactionLifecycle);
  expect.hasMethod(impl as object, 'hasNativePreCompactHook');
  expect.hasMethod(impl as object, 'subscribePreCompact');
  expect.hasMethod(impl as object, 'subscribePostCompact');
  expect.hasMethod(impl as object, 'triggerCompact');
  })();
}
