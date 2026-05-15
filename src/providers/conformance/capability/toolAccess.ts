/**
 * Conformance suite for ToolAccess primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { ToolAccess } from '../../primitives/capability/toolAccess.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runToolAccessConformance(
  factory: ConformanceFactory<ToolAccess>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.ToolAccess);
  expect.hasMethod(impl as object, 'supportedToolKinds');
  expect.hasMethod(impl as object, 'registeredTools');
  })();
}
