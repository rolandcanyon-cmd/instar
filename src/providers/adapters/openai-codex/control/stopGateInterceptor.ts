/**
 * StopGateInterceptor implementation for openai-codex.
 *
 * Codex's Stop hook contract is intentionally Claude-compatible (per the
 * deep-dive §B): same JSON shape, same `{"decision":"block","reason":"..."}`
 * semantics. This primitive registers a handler against the HookEventReceiver
 * for `stop` events and translates the handler's decision back into the
 * hook reply.
 */

import type { CancellationOptions, SessionHandle } from '../../../types.js';
import type {
  StopGateInterceptor,
  StopGateHandler,
  StopGateContext,
} from '../../../primitives/control/stopGateInterceptor.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { createHookEventReceiver } from '../observability/hookEventReceiver.js';

class OpenAiCodexStopGateInterceptor implements StopGateInterceptor {
  readonly capability = CapabilityFlag.StopGateInterceptor;
  private readonly handlers = new Map<SessionHandle, StopGateHandler>();

  async register(
    session: SessionHandle,
    handler: StopGateHandler,
    options?: CancellationOptions,
  ): Promise<() => Promise<void>> {
    this.handlers.set(session, handler);

    const receiver = createHookEventReceiver();
    const sub = (async () => {
      for await (const event of receiver.subscribe({ kinds: ['stop'], session, signal: options?.signal })) {
        const h = this.handlers.get(session);
        if (!h) continue;
        const ctx: StopGateContext = {
          session,
          recentOutput: typeof event.payload === 'object' && event.payload && 'recentOutput' in event.payload
            ? String((event.payload as { recentOutput?: unknown }).recentOutput ?? '')
            : '',
          rawPayload: (event.payload ?? {}) as Readonly<Record<string, unknown>>,
          timestamp: event.timestamp,
        };
        const decision = await h(ctx);
        if (decision.kind === 'continue') {
          await receiver.reply(event.id, { decision: 'block', reason: decision.reason, stopReason: decision.reason });
        } else {
          await receiver.reply(event.id, { decision: 'approve' });
        }
      }
    })();
    void sub;

    return async () => {
      this.handlers.delete(session);
    };
  }
}

export function createStopGateInterceptor(): StopGateInterceptor {
  return new OpenAiCodexStopGateInterceptor();
}
