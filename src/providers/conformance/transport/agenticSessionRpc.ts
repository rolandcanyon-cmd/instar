/**
 * Conformance suite for AgenticSessionRpc primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { AgenticSessionRpc } from '../../primitives/transport/agenticSessionRpc.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runAgenticSessionRpcConformance(
  factory: ConformanceFactory<AgenticSessionRpc>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.AgenticSessionRpc);
  expect.hasMethod(impl as object, 'start');
  expect.hasMethod(impl as object, 'startTurn');
  expect.hasMethod(impl as object, 'steerTurn');
  expect.hasMethod(impl as object, 'interruptTurn');
  expect.hasMethod(impl as object, 'close');
  })();
}
