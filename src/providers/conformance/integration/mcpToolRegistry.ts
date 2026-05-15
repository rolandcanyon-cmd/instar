/**
 * Conformance suite for McpToolRegistry primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { McpToolRegistry } from '../../primitives/integration/mcpToolRegistry.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runMcpToolRegistryConformance(
  factory: ConformanceFactory<McpToolRegistry>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.McpToolRegistry);
  expect.hasMethod(impl as object, 'register');
  expect.hasMethod(impl as object, 'unregister');
  expect.hasMethod(impl as object, 'list');
  expect.hasMethod(impl as object, 'isRegistered');
  })();
}
