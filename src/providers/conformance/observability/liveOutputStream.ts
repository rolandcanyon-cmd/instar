/**
 * Conformance suite for LiveOutputStream primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { LiveOutputStream } from '../../primitives/observability/liveOutputStream.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runLiveOutputStreamConformance(
  factory: ConformanceFactory<LiveOutputStream>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.LiveOutputStream);
  expect.hasMethod(impl as object, 'snapshot');
  expect.hasMethod(impl as object, 'tail');
  })();
}
