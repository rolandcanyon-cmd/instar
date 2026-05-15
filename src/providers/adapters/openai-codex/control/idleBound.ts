/**
 * IdleBound implementation for openai-codex.
 *
 * Codex has no native idle-timeout config; the primitive records the
 * policy and external watchdogs are expected to enforce. NativeIdleBound
 * capability flag is FALSE for this adapter.
 */

import type { CancellationOptions, SessionHandle } from '../../../types.js';
import type { IdleBound, IdlePolicy } from '../../../primitives/control/idleBound.js';
import { CapabilityFlag } from '../../../capabilities.js';

class OpenAiCodexIdleBound implements IdleBound {
  readonly capability = CapabilityFlag.IdleBound;
  private readonly policies = new Map<SessionHandle, IdlePolicy>();

  async setIdlePolicy(session: SessionHandle, policy: IdlePolicy, _options?: CancellationOptions): Promise<void> {
    this.policies.set(session, policy);
  }

  async getIdlePolicy(session: SessionHandle, _options?: CancellationOptions): Promise<IdlePolicy | null> {
    return this.policies.get(session) ?? null;
  }

  async clearIdlePolicy(session: SessionHandle, _options?: CancellationOptions): Promise<void> {
    this.policies.delete(session);
  }
}

export function createIdleBound(): IdleBound {
  return new OpenAiCodexIdleBound();
}
