/**
 * Conformance suite for AuthCredentialInjection primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { AuthCredentialInjection } from '../../primitives/control/authCredentialInjection.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runAuthCredentialInjectionConformance(
  factory: ConformanceFactory<AuthCredentialInjection>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.AuthCredentialInjection);
  expect.hasMethod(impl as object, 'buildSpec');
  expect.hasMethod(impl as object, 'validate');
  expect.hasMethod(impl as object, 'probe');
  })();
}
