/**
 * Conformance suite for ProviderScaffolder primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { ProviderScaffolder } from '../../primitives/integration/providerScaffolder.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runProviderScaffolderConformance(
  factory: ConformanceFactory<ProviderScaffolder>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.ProviderScaffolder);
  expect.hasMethod(impl as object, 'install');
  expect.hasMethod(impl as object, 'verify');
  expect.hasMethod(impl as object, 'uninstall');
  })();
}
