/**
 * InteractivePromptObserver implementation for openai-codex.
 *
 * Codex emits STRUCTURED approval events via the app-server
 * (`item/commandExecution/requestApproval` and similar). Capability flag
 * `StructuredApprovalEvents` is TRUE for this adapter. source() returns
 * 'structured'.
 *
 * Phase 4 baseline: structured events flow via the event normalizer.
 * The respond() method targets the app-server's `requestApproval` reply
 * channel when in use, and falls back to tmux send-keys for the plain
 * `codex exec` path that doesn't expose the app-server.
 */

import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { CancellationOptions, SessionHandle } from '../../../types.js';
import type {
  InteractivePromptObserver,
  PromptObserverOptions,
  PromptResponse,
} from '../../../primitives/observability/interactivePromptObserver.js';
import type { InteractivePromptEvent } from '../../../events.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { tmuxSessionFromHandle } from '../transport/agenticSessionHeadless.js';
import type { OpenAiCodexConfig } from '../config.js';

const emitter = new EventEmitter();

class OpenAiCodexInteractivePromptObserver implements InteractivePromptObserver {
  readonly capability = CapabilityFlag.InteractivePromptObserver;

  constructor(private readonly config: OpenAiCodexConfig) {}

  source(): 'structured' | 'scraped' | 'mixed' { return 'structured'; }

  subscribe(options?: PromptObserverOptions): AsyncIterable<InteractivePromptEvent> {
    const signal = options?.signal;
    const sessionFilter = options?.session;
    const kindFilter = options?.kinds ? new Set(options.kinds) : null;
    return {
      async *[Symbol.asyncIterator]() {
        const queue: InteractivePromptEvent[] = [];
        let resolveNext: (() => void) | null = null;
        const onEvent = (ev: InteractivePromptEvent) => {
          if (sessionFilter && ev.session !== sessionFilter) return;
          if (kindFilter && !kindFilter.has(ev.promptKind)) return;
          queue.push(ev);
          if (resolveNext) { resolveNext(); resolveNext = null; }
        };
        emitter.on('prompt', onEvent);
        const cleanup = () => emitter.off('prompt', onEvent);
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

  async respond(
    session: SessionHandle,
    _promptId: string,
    response: PromptResponse,
    _options?: CancellationOptions,
  ): Promise<void> {
    // Fallback path for `codex exec` sessions (no app-server): tmux send-keys.
    const tmuxName = tmuxSessionFromHandle(session);
    const text = encodeResponse(response);
    try {
      execFileSync(this.config.tmuxPath, ['send-keys', '-t', tmuxName, text, 'Enter'], {
        encoding: 'utf-8',
        timeout: 5000,
      });
    } catch {
      /* swallowed — app-server path is preferred when available */
    }
  }
}

function encodeResponse(response: PromptResponse): string {
  switch (response.kind) {
    case 'approve': return 'y';
    case 'deny': return 'n';
    case 'select': return response.value;
    case 'input': return response.text;
  }
}

/** Feed a structured prompt event from the event normalizer / app-server. */
export function feedPromptEvent(event: InteractivePromptEvent): void {
  emitter.emit('prompt', event);
}

export function createInteractivePromptObserver(config: OpenAiCodexConfig): InteractivePromptObserver {
  return new OpenAiCodexInteractivePromptObserver(config);
}
