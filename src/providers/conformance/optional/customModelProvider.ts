/**
 * Conformance suite for CustomModelProvider primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { CustomModelProvider } from '../../primitives/optional/customModelProvider.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runCustomModelProviderConformance(
  factory: ConformanceFactory<CustomModelProvider>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.CustomModelProvider);
  expect.hasMethod(impl as object, 'list');
  expect.hasMethod(impl as object, 'active');
  expect.hasMethod(impl as object, 'register');
  expect.hasMethod(impl as object, 'switchTo');
  expect.hasMethod(impl as object, 'remove');
  })();
}
