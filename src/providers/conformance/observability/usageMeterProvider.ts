/**
 * Conformance suite for UsageMeterProvider primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { UsageMeterProvider } from '../../primitives/observability/usageMeterProvider.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runUsageMeterProviderConformance(
  factory: ConformanceFactory<UsageMeterProvider>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.UsageMeterProvider);
  expect.hasMethod(impl as object, 'isAuthoritative');
  expect.hasMethod(impl as object, 'read');
  })();
}
