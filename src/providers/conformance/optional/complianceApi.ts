/**
 * Conformance suite for ComplianceApi primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { ComplianceApi } from '../../primitives/optional/complianceApi.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runComplianceApiConformance(
  factory: ConformanceFactory<ComplianceApi>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.ComplianceApi);
  expect.hasMethod(impl as object, 'config');
  expect.hasMethod(impl as object, 'setConfig');
  expect.hasMethod(impl as object, 'subscribe');
  })();
}
