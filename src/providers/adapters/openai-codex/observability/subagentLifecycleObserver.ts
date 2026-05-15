/**
 * SubagentLifecycleObserver implementation for openai-codex.
 *
 * Codex has no native SubagentStart / SubagentStop hook events (per the
 * deep-dive §B). Adapter synthesizes events from app-server
 * `thread/started` / `thread/closed` notifications. Capability flag
 * `SubagentLifecycleHooks` is FALSE for this adapter; isNative() returns
 * false; emitted events are tagged `synthesized: true` in providerSpecific.
 *
 * Phase 4 baseline: the synthesis stream is provided via an internal
 * EventEmitter that the agentic-session primitive feeds when it observes
 * app-server-side thread notifications. When the app-server is not in
 * use, subagent observation degrades to "no events emitted" — explicit
 * declaration that subagents are not observable through this path.
 */

import { EventEmitter } from 'node:events';
import type { CancellationOptions, SessionHandle } from '../../../types.js';
import type {
  SubagentLifecycleObserver,
  SubagentObserverOptions,
  ActiveSubagent,
} from '../../../primitives/observability/subagentLifecycleObserver.js';
import type { SubagentLifecycleEvent } from '../../../events.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { OPENAI_CODEX_ID } from '../errors.js';

const emitter = new EventEmitter();
const active = new Map<string, ActiveSubagent>();

class OpenAiCodexSubagentLifecycleObserver implements SubagentLifecycleObserver {
  readonly capability = CapabilityFlag.SubagentLifecycleObserver;

  isNative(): boolean { return false; }

  subscribe(options?: SubagentObserverOptions): AsyncIterable<SubagentLifecycleEvent> {
    const signal = options?.signal;
    const parentFilter = options?.parent;
    const kindFilter = options?.kinds ? new Set(options.kinds) : null;
    return {
      async *[Symbol.asyncIterator]() {
        const queue: SubagentLifecycleEvent[] = [];
        let resolveNext: (() => void) | null = null;
        const onEvent = (ev: SubagentLifecycleEvent) => {
          if (parentFilter && ev.parentSession !== parentFilter) return;
          if (kindFilter && !kindFilter.has(ev.lifecycleKind)) return;
          queue.push(ev);
          if (resolveNext) { resolveNext(); resolveNext = null; }
        };
        emitter.on('subagent', onEvent);
        const cleanup = () => emitter.off('subagent', onEvent);
        signal?.addEventListener('abort', cleanup, { once: true });
        try {
          while (!signal?.aborted) {
            while (queue.length > 0) yield queue.shift()!;
            await new Promise<void>((resolve) => {
              resolveNext = resolve;
              if (signal) signal.addEventListener('abort', () => { resolveNext = null; resolve(); }, { once: true });
            });
          }
        } finally { cleanup(); }
      },
    };
  }

  async active(parent: SessionHandle, _options?: CancellationOptions): Promise<ReadonlyArray<ActiveSubagent>> {
    return [...active.values()].filter((a) => a.parent === parent);
  }
}

/** Feed a synthesized subagent event from app-server notifications. */
export function feedSubagentEvent(event: SubagentLifecycleEvent): void {
  const stamped = { ...event, providerSpecific: { [OPENAI_CODEX_ID]: { synthesized: true } } };
  if (event.lifecycleKind === 'started') {
    active.set(event.childSession, {
      child: event.childSession,
      parent: event.parentSession,
      startedAt: event.timestamp,
      purpose: event.purpose,
    });
  } else if (event.lifecycleKind === 'completed' || event.lifecycleKind === 'failed') {
    active.delete(event.childSession);
  }
  emitter.emit('subagent', stamped);
}

export function createSubagentLifecycleObserver(): SubagentLifecycleObserver {
  return new OpenAiCodexSubagentLifecycleObserver();
}
