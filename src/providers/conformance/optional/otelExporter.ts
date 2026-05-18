/**
 * Conformance suite for OtelExporter primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { OtelExporter } from '../../primitives/optional/otelExporter.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runOtelExporterConformance(
  factory: ConformanceFactory<OtelExporter>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.OtelExporter);
  expect.hasMethod(impl as object, 'get');
  expect.hasMethod(impl as object, 'set');
  })();
}
