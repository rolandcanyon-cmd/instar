/**
 * Conformance suite for ProfileSwitcher primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { ProfileSwitcher } from '../../primitives/optional/profileSwitcher.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runProfileSwitcherConformance(
  factory: ConformanceFactory<ProfileSwitcher>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.ProfileSwitcher);
  expect.hasMethod(impl as object, 'list');
  expect.hasMethod(impl as object, 'current');
  expect.hasMethod(impl as object, 'switch');
  expect.hasMethod(impl as object, 'define');
  expect.hasMethod(impl as object, 'remove');
  })();
}
