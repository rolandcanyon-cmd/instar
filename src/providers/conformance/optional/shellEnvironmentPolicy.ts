/**
 * Conformance suite for ShellEnvironmentPolicy primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { ShellEnvironmentPolicy } from '../../primitives/optional/shellEnvironmentPolicy.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runShellEnvironmentPolicyConformance(
  factory: ConformanceFactory<ShellEnvironmentPolicy>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.ShellEnvironmentPolicy);
  expect.hasMethod(impl as object, 'get');
  expect.hasMethod(impl as object, 'set');
  })();
}
