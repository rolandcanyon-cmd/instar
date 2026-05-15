/**
 * HookEventReceiver: subscribe to Claude Code hook events.
 *
 * Phase 3a: provides the interface contract with an event-bus-backed
 * implementation that other modules can dispatch into. The actual HTTP
 * receiver (which Claude Code's hook scripts POST to) is owned by the
 * existing monitoring/HookEventReceiver in instar source. Phase 3 wiring
 * connects the two.
 *
 * The pattern: this primitive exposes `dispatch(event)` for the HTTP
 * receiver to call, and `subscribe()` for consumers. Replies go back
 * through `reply(eventId, decision)` which the HTTP receiver consults
 * before responding to the hook script.
 */

import { EventEmitter } from 'node:events';
import type {
  HookEventReceiver,
  HookEvent,
  HookEventKind,
  HookDecision,
  HookSubscribeOptions,
} from '../../../primitives/observability/hookEventReceiver.js';
import { CapabilityFlag } from '../../../capabilities.js';

const ALL_CLAUDE_EVENTS: HookEventKind[] = [
  'session-start',
  'session-end',
  'pre-tool-use',
  'post-tool-use',
  'user-prompt-submit',
  'stop',
  'subagent-start',
  'subagent-stop',
  'worktree-create',
  'worktree-remove',
  'task-completed',
  'pre-compact',
  'instructions-loaded',
];

class AnthropicHeadlessHookEventReceiver implements HookEventReceiver {
  readonly capability = CapabilityFlag.HookEventReceiver;
  private readonly emitter = new EventEmitter();
  private readonly pendingReplies = new Map<string, (d: HookDecision) => void>();

  /** Called by the HTTP receiver when a hook event arrives. */
  dispatch(event: HookEvent): Promise<HookDecision | null> {
    return new Promise((resolve) => {
      this.pendingReplies.set(event.id, (decision) => {
        this.pendingReplies.delete(event.id);
        resolve(decision);
      });
      this.emitter.emit('hook', event);
      // If no consumer replies in 30s, default to allow
      setTimeout(() => {
        if (this.pendingReplies.has(event.id)) {
          this.pendingReplies.delete(event.id);
          resolve(null);
        }
      }, 30_000).unref();
    });
  }

  supportedEventKinds(): ReadonlySet<HookEventKind> {
    return new Set(ALL_CLAUDE_EVENTS);
  }

  subscribe(options?: HookSubscribeOptions): AsyncIterable<HookEvent> {
    const emitter = this.emitter;
    const signal = options?.signal;
    const allowedKinds = options?.kinds ? new Set(options.kinds) : null;
    const sessionFilter = options?.session;
    return {
      async *[Symbol.asyncIterator]() {
        const queue: HookEvent[] = [];
        let resolveNext: (() => void) | null = null;
        const onHook = (ev: HookEvent) => {
          if (allowedKinds && !allowedKinds.has(ev.kind)) return;
          if (sessionFilter && ev.session !== sessionFilter) return;
          queue.push(ev);
          if (resolveNext) {
            resolveNext();
            resolveNext = null;
          }
        };
        emitter.on('hook', onHook);
        const cleanup = () => emitter.off('hook', onHook);
        signal?.addEventListener('abort', cleanup, { once: true });
        try {
          while (!signal?.aborted) {
            while (queue.length > 0) {
              yield queue.shift()!;
            }
            await new Promise<void>((resolve) => {
              resolveNext = resolve;
              // also unblock on abort
              if (signal) {
                const onAbort = () => {
                  resolveNext = null;
                  resolve();
                };
                signal.addEventListener('abort', onAbort, { once: true });
              }
            });
          }
        } finally {
          cleanup();
        }
      },
    };
  }

  async reply(eventId: string, decision: HookDecision): Promise<void> {
    const resolver = this.pendingReplies.get(eventId);
    if (resolver) {
      resolver(decision);
    }
  }
}

// Module-level singleton so the HTTP receiver (in monitoring/) and this
// primitive talk to the same instance.
const singleton = new AnthropicHeadlessHookEventReceiver();

export function createHookEventReceiver(): HookEventReceiver {
  return singleton;
}

export function dispatchHookEvent(event: HookEvent): Promise<HookDecision | null> {
  return singleton.dispatch(event);
}
