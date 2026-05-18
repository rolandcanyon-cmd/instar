/**
 * Conformance suite for SessionResumeIndex primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { SessionResumeIndex } from '../../primitives/integration/sessionResumeIndex.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runSessionResumeIndexConformance(
  factory: ConformanceFactory<SessionResumeIndex>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.SessionResumeIndex);
  expect.hasMethod(impl as object, 'findById');
  expect.hasMethod(impl as object, 'findRecent');
  expect.hasMethod(impl as object, 'listByProject');
  expect.hasMethod(impl as object, 'resume');
  })();
}
