/**
 * StopGateInterceptor: in-memory handler registry. The hookEventReceiver
 * actually dispatches Stop events; this primitive registers handlers for
 * them. Phase 3a wiring keeps the two coordinated through a module-level
 * registry that the hook receiver consults.
 */

import type {
  StopGateInterceptor,
  StopGateHandler,
} from '../../../primitives/control/stopGateInterceptor.js';
import type { SessionHandle, CancellationOptions } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';

const handlers = new Map<SessionHandle, StopGateHandler>();

export function getStopGateHandler(session: SessionHandle): StopGateHandler | undefined {
  return handlers.get(session);
}

class AnthropicHeadlessStopGateInterceptor implements StopGateInterceptor {
  readonly capability = CapabilityFlag.StopGateInterceptor;

  async register(
    session: SessionHandle,
    handler: StopGateHandler,
    _options?: CancellationOptions,
  ): Promise<() => Promise<void>> {
    handlers.set(session, handler);
    return async () => {
      handlers.delete(session);
    };
  }
}

export function createStopGateInterceptor(): StopGateInterceptor {
  return new AnthropicHeadlessStopGateInterceptor();
}
