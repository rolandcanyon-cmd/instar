/**
 * Conformance suite for FilesystemRpc primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { FilesystemRpc } from '../../primitives/optional/filesystemRpc.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runFilesystemRpcConformance(
  factory: ConformanceFactory<FilesystemRpc>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.FilesystemRpc);
  expect.hasMethod(impl as object, 'readFile');
  expect.hasMethod(impl as object, 'writeFile');
  expect.hasMethod(impl as object, 'copy');
  expect.hasMethod(impl as object, 'watch');
  })();
}
