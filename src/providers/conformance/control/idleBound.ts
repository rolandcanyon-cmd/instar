/**
 * Conformance suite for IdleBound primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { IdleBound } from '../../primitives/control/idleBound.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runIdleBoundConformance(
  factory: ConformanceFactory<IdleBound>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.IdleBound);
  expect.hasMethod(impl as object, 'setIdlePolicy');
  expect.hasMethod(impl as object, 'getIdlePolicy');
  expect.hasMethod(impl as object, 'clearIdlePolicy');
  })();
}
