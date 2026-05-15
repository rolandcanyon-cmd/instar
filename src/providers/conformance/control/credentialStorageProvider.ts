/**
 * Conformance suite for CredentialStorageProvider primitive.
 *
 * Phase 2: contract-shape only — verifies the implementation declares the
 * right capability flag and exposes the expected methods. Phase 3+ adapters
 * extend this with behavior tests against real provider APIs.
 */
import type { CredentialStorageProvider } from '../../primitives/control/credentialStorageProvider.js';
import type { ConformanceFactory, ConformanceContext } from '../runner.js';
import { CapabilityFlag } from '../../capabilities.js';
import { getAssertions } from '../runner.js';

export function runCredentialStorageProviderConformance(
  factory: ConformanceFactory<CredentialStorageProvider>,
  _ctx: ConformanceContext,
): void {
  const expect = getAssertions();
  void (async () => {
    const impl = await factory();
    expect.hasCapability(impl as { capability: string }, CapabilityFlag.CredentialStorageProvider);
  expect.hasMethod(impl as object, 'getBackend');
  expect.hasMethod(impl as object, 'setBackend');
  expect.hasMethod(impl as object, 'listAccounts');
  expect.hasMethod(impl as object, 'get');
  expect.hasMethod(impl as object, 'set');
  expect.hasMethod(impl as object, 'remove');
  expect.hasMethod(impl as object, 'getActiveAccount');
  expect.hasMethod(impl as object, 'setActiveAccount');
  })();
}
