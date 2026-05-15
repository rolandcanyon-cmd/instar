/**
 * Conformance suite for TrustedProjectGate primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { TrustedProjectGate } from '../../primitives/optional/trustedProjectGate.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runTrustedProjectGateConformance(
  factory: ConformanceFactory<TrustedProjectGate>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.TrustedProjectGate);
  expect.hasMethod(impl as object, 'isTrusted');
  expect.hasMethod(impl as object, 'trust');
  expect.hasMethod(impl as object, 'revoke');
  expect.hasMethod(impl as object, 'listTrusted');
  })();
}
