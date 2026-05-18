/**
 * Conformance suite for SessionId primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { SessionId } from '../../primitives/observability/sessionId.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runSessionIdConformance(
  factory: ConformanceFactory<SessionId>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.SessionId);
  expect.hasMethod(impl as object, 'providerIdFor');
  expect.hasMethod(impl as object, 'handleFor');
  })();
}
