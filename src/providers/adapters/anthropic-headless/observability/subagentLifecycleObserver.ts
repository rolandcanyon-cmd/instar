/**
 * SubagentLifecycleObserver: filter the hook event stream for subagent
 * lifecycle kinds and map to SubagentLifecycleEvents.
 */

import type {
  SubagentLifecycleObserver,
  SubagentObserverOptions,
  ActiveSubagent,
} from '../../../primitives/observability/subagentLifecycleObserver.js';
import type { SubagentLifecycleEvent } from '../../../events.js';
import type { SessionHandle } from '../../../types.js';
import { sessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { ANTHROPIC_HEADLESS_ID } from '../errors.js';
import { createHookEventReceiver } from './hookEventReceiver.js';

const activeSubagents = new Map<SessionHandle, { parent: SessionHandle; startedAt: string; purpose?: string }>();

class AnthropicHeadlessSubagentLifecycleObserver implements SubagentLifecycleObserver {
  readonly capability = CapabilityFlag.SubagentLifecycleObserver;

  isNative(): boolean {
    return true; // Anthropic emits SubagentStart/SubagentStop hook events
  }

  subscribe(options?: SubagentObserverOptions): AsyncIterable<SubagentLifecycleEvent> {
    const receiver = createHookEventReceiver();
    const signal = options?.signal;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const hook of receiver.subscribe({
          kinds: ['subagent-start', 'subagent-stop'],
          signal,
        })) {
          const payload = hook.payload as { parent_session_id?: string; child_session_id?: string; purpose?: string };
          const child = sessionHandle(payload.child_session_id ?? '');
          const parent = sessionHandle(payload.parent_session_id ?? '');
          if (options?.parent && parent !== options.parent) continue;
          const lifecycleKind =
            hook.kind === 'subagent-start' ? 'started' : 'completed';
          if (options?.kinds && !options.kinds.includes(lifecycleKind)) continue;
          const event: SubagentLifecycleEvent = {
            type: 'subagent-lifecycle',
            timestamp: hook.timestamp,
            providerId: ANTHROPIC_HEADLESS_ID,
            lifecycleKind,
            parentSession: parent,
            childSession: child,
            purpose: payload.purpose,
          };
          if (lifecycleKind === 'started') {
            activeSubagents.set(child, {
              parent,
              startedAt: hook.timestamp,
              purpose: payload.purpose,
            });
          } else {
            activeSubagents.delete(child);
          }
          yield event;
        }
      },
    };
  }

  async active(parent: SessionHandle): Promise<ReadonlyArray<ActiveSubagent>> {
    const result: ActiveSubagent[] = [];
    for (const [child, info] of activeSubagents.entries()) {
      if (info.parent === parent) {
        result.push({
          child,
          parent: info.parent,
          startedAt: info.startedAt,
          purpose: info.purpose,
        });
      }
    }
    return result;
  }
}

export function createSubagentLifecycleObserver(): SubagentLifecycleObserver {
  return new AnthropicHeadlessSubagentLifecycleObserver();
}
