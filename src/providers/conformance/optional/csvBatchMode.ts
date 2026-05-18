/**
 * Conformance suite for CsvBatchMode primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { CsvBatchMode } from '../../primitives/optional/csvBatchMode.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runCsvBatchModeConformance(
  factory: ConformanceFactory<CsvBatchMode>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.CsvBatchMode);
  expect.hasMethod(impl as object, 'run');
  })();
}
