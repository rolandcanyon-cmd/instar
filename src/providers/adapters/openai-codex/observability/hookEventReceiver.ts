/**
 * HookEventReceiver implementation for openai-codex.
 *
 * Codex supports 6 hook events (per developers.openai.com/codex/hooks):
 *   SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
 *   PermissionRequest, Stop. Hooks register in ~/.codex/hooks.json or
 *   config.toml. Hook return contract is intentionally Claude-compatible
 *   (same JSON shape, same exit-code-2 semantics).
 *
 * This primitive mirrors the Anthropic adapter's pattern: an event-bus-
 * backed implementation that other modules dispatch into. Lifecycle
 * events that Codex DOESN'T have natively (subagent start/stop, worktree
 * create/remove, pre-compact, task-completed, session-end,
 * instructions-loaded) are NOT included in `supportedEventKinds()` — the
 * abstraction surfaces only the events Codex actually emits.
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

const CODEX_EVENTS: HookEventKind[] = [
  'session-start',
  'user-prompt-submit',
  'pre-tool-use',
  'post-tool-use',
  'stop',
];

class OpenAiCodexHookEventReceiver implements HookEventReceiver {
  readonly capability = CapabilityFlag.HookEventReceiver;
  private readonly emitter = new EventEmitter();
  private readonly pendingReplies = new Map<string, (d: HookDecision) => void>();

  dispatch(event: HookEvent): Promise<HookDecision | null> {
    return new Promise((resolve) => {
      this.pendingReplies.set(event.id, (decision) => {
        this.pendingReplies.delete(event.id);
        resolve(decision);
      });
      this.emitter.emit('hook', event);
      setTimeout(() => {
        if (this.pendingReplies.has(event.id)) {
          this.pendingReplies.delete(event.id);
          resolve(null);
        }
      }, 30_000).unref();
    });
  }

  supportedEventKinds(): ReadonlySet<HookEventKind> { return new Set(CODEX_EVENTS); }

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
            while (queue.length > 0) yield queue.shift()!;
            await new Promise<void>((resolve) => {
              resolveNext = resolve;
              if (signal) signal.addEventListener('abort', () => { resolveNext = null; resolve(); }, { once: true });
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
    if (resolver) resolver(decision);
  }
}

const singleton = new OpenAiCodexHookEventReceiver();

export function createHookEventReceiver(): HookEventReceiver { return singleton; }

export function dispatchHookEvent(event: HookEvent): Promise<HookDecision | null> {
  return singleton.dispatch(event);
}
