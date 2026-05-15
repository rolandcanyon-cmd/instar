/**
 * Conformance suite for ProcessSpawn primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { ProcessSpawn } from '../../primitives/optional/processSpawn.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runProcessSpawnConformance(
  factory: ConformanceFactory<ProcessSpawn>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.ProcessSpawn);
  expect.hasMethod(impl as object, 'spawn');
  expect.hasMethod(impl as object, 'send');
  expect.hasMethod(impl as object, 'kill');
  })();
}
