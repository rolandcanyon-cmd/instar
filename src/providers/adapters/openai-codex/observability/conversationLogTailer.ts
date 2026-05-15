/**
 * ConversationLogTailer implementation for openai-codex.
 *
 * Polls the rollout JSONL file for appended lines and emits normalized
 * events. Same drift surface as ConversationLogReader; canary coverage is
 * shared.
 */

import { promises as fs } from 'node:fs';
import type {
  ConversationLogTailer,
  ConversationLogTailOptions,
} from '../../../primitives/observability/conversationLogTailer.js';
import type { CanonicalEvent } from '../../../events.js';
import type { SessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import type { OpenAiCodexConfig } from '../config.js';
import { createSessionId } from './sessionId.js';
import { findRolloutFile } from './sessionPaths.js';
import { normalizeCodexJsonlEvent } from './eventNormalizer.js';

class OpenAiCodexConversationLogTailer implements ConversationLogTailer {
  readonly capability = CapabilityFlag.ConversationLogTailer;

  constructor(private readonly config: OpenAiCodexConfig) {}

  tail(session: SessionHandle, options?: ConversationLogTailOptions): AsyncIterable<CanonicalEvent> {
    const cfg = this.config;
    const pollMs = options?.pollIntervalMs ?? 1000;
    return {
      async *[Symbol.asyncIterator]() {
        const threadId = await createSessionId().providerIdFor(session);
        if (!threadId) return;
        let file: string | null = null;
        while (!file) {
          if (options?.signal?.aborted) return;
          file = await findRolloutFile(threadId, cfg.codexHome);
          if (!file) await new Promise((r) => setTimeout(r, pollMs));
        }
        let lastSize = 0;
        let leftover = '';
        while (!options?.signal?.aborted) {
          let stat;
          try {
            stat = await fs.stat(file);
          } catch {
            return;
          }
          if (stat.size > lastSize) {
            const fd = await fs.open(file, 'r');
            try {
              const buf = Buffer.alloc(stat.size - lastSize);
              await fd.read(buf, 0, buf.length, lastSize);
              const chunk = leftover + buf.toString('utf-8');
              const lines = chunk.split('\n');
              leftover = lines.pop() ?? '';
              for (const line of lines) {
                if (!line.trim()) continue;
                const ev = normalizeCodexJsonlEvent(line);
                if (ev) {
                  if (options?.types && !options.types.includes(ev.type)) continue;
                  yield ev;
                }
              }
            } finally {
              await fd.close();
            }
            lastSize = stat.size;
          }
          await new Promise((r) => setTimeout(r, pollMs));
        }
      },
    };
  }
}

export function createConversationLogTailer(config: OpenAiCodexConfig): ConversationLogTailer {
  return new OpenAiCodexConversationLogTailer(config);
}
