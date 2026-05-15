/**
 * Conformance suite for NotificationOptOut primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { NotificationOptOut } from '../../primitives/optional/notificationOptOut.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runNotificationOptOutConformance(
  factory: ConformanceFactory<NotificationOptOut>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.NotificationOptOut);
  expect.hasMethod(impl as object, 'optOut');
  expect.hasMethod(impl as object, 'current');
  })();
}
