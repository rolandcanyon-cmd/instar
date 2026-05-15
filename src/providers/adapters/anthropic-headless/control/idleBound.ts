/**
 * IdleBound: external watchdog enforces idle-prompt-kill policy.
 *
 * Same pattern as TimeoutBound — in-memory policy storage with the actual
 * detection driven by a watchdog process. Phase 3a provides the contract.
 */

import type { IdleBound, IdlePolicy } from '../../../primitives/control/idleBound.js';
import type { SessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';

class AnthropicHeadlessIdleBound implements IdleBound {
  readonly capability = CapabilityFlag.IdleBound;
  private readonly policies = new Map<SessionHandle, IdlePolicy>();

  async setIdlePolicy(session: SessionHandle, policy: IdlePolicy): Promise<void> {
    this.policies.set(session, policy);
  }

  async getIdlePolicy(session: SessionHandle): Promise<IdlePolicy | null> {
    return this.policies.get(session) ?? null;
  }

  async clearIdlePolicy(session: SessionHandle): Promise<void> {
    this.policies.delete(session);
  }
}

export function createIdleBound(): IdleBound {
  return new AnthropicHeadlessIdleBound();
}
