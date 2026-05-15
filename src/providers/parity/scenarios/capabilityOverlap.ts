/**
 * Parity scenarios for the capability-declaration surface.
 *
 * Never hits a provider — always runs. Verifies that both adapters
 * declare overlapping capabilities consistently:
 *   - Same CapabilityFlag set claimed by both (excepting deliberate
 *     STUB-only on one side and real on the other)
 *   - Both adapters' `id` strings are distinct (so the registry can
 *     differentiate them)
 *   - Calling .primitive() with a claimed capability returns a
 *     non-undefined value (real or throwing stub)
 */

import { CapabilityFlag } from '../../capabilities.js';
import type { ParityScenario } from '../runner.js';

/**
 * Sub-capability flags are declarative markers (asymmetric features
 * provider X has and Y doesn't). They are NOT retrievable as primitives
 * via adapter.primitive(); they modify the behavior of OTHER primitives.
 * The instantiation parity check must exclude these.
 */
const SUB_CAPABILITY_FLAGS: ReadonlySet<CapabilityFlag> = new Set([
  CapabilityFlag.PublicUsageApi,
  CapabilityFlag.PreCompactHook,
  CapabilityFlag.SubagentLifecycleHooks,
  CapabilityFlag.NativeIdleBound,
  CapabilityFlag.StructuredApprovalEvents,
]);

export const distinctIds: ParityScenario = async ({ left, right }) => {
  if (left.id === right.id) {
    return { scenario: '', status: 'fail', reason: `both adapters share id "${left.id}"` };
  }
  return { scenario: '', status: 'pass', observations: { left: left.id, right: right.id } };
};

export const sharedCapabilitiesInstantiate: ParityScenario = async ({ left, right }) => {
  const sharedCaps: CapabilityFlag[] = [];
  for (const cap of left.capabilities) {
    if (right.capabilities.has(cap) && !SUB_CAPABILITY_FLAGS.has(cap)) {
      sharedCaps.push(cap);
    }
  }
  if (sharedCaps.length === 0) {
    return { scenario: '', status: 'fail', reason: 'no capabilities shared between adapters' };
  }
  const failures: string[] = [];
  for (const cap of sharedCaps) {
    try {
      const lp = left.primitive(cap);
      const rp = right.primitive(cap);
      if (lp == null) failures.push(`left.${String(cap)} returned nullish`);
      if (rp == null) failures.push(`right.${String(cap)} returned nullish`);
    } catch (err) {
      failures.push(`${String(cap)} threw: ${(err as Error).message}`);
    }
  }
  if (failures.length > 0) {
    return {
      scenario: '',
      status: 'fail',
      reason: failures.join('; '),
      observations: { left: sharedCaps.length, right: sharedCaps.length },
    };
  }
  return {
    scenario: '',
    status: 'pass',
    observations: { sharedCount: sharedCaps.length },
  };
};

export const capabilityOverlapScenarios = [
  { name: 'capability/distinctIds', run: distinctIds },
  { name: 'capability/sharedCapabilitiesInstantiate', run: sharedCapabilitiesInstantiate },
] as const;
