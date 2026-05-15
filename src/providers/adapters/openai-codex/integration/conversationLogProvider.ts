/**
 * ConversationLogProvider — composite read-then-tail for openai-codex.
 *
 * Reads the existing rollout and then continues tailing it for new
 * entries. Adapter handles the seamless handoff (no events dropped or
 * duplicated at the boundary).
 */

import type { SessionHandle } from '../../../types.js';
import type {
  ConversationLogProvider,
  ConversationLogProviderOptions,
} from '../../../primitives/integration/conversationLogProvider.js';
import type { CanonicalEvent } from '../../../events.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { createConversationLogReader } from '../observability/conversationLogReader.js';
import { createConversationLogTailer } from '../observability/conversationLogTailer.js';
import type { OpenAiCodexConfig } from '../config.js';

class OpenAiCodexConversationLogProvider implements ConversationLogProvider {
  readonly capability = CapabilityFlag.ConversationLogProvider;

  constructor(private readonly config: OpenAiCodexConfig) {}

  readAndTail(session: SessionHandle, options?: ConversationLogProviderOptions): AsyncIterable<CanonicalEvent> {
    const reader = createConversationLogReader(this.config);
    const tailer = createConversationLogTailer(this.config);
    return {
      async *[Symbol.asyncIterator]() {
        const existing = await reader.read(session, {
          types: options?.types,
          since: options?.since,
          signal: options?.signal,
        });
        let lastTimestamp = options?.since ?? '';
        for (const ev of existing) {
          yield ev;
          if (ev.timestamp > lastTimestamp) lastTimestamp = ev.timestamp;
        }
        for await (const ev of tailer.tail(session, {
          types: options?.types,
          signal: options?.signal,
        })) {
          if (ev.timestamp <= lastTimestamp) continue;
          yield ev;
        }
      },
    };
  }
}

export function createConversationLogProviderImpl(config: OpenAiCodexConfig): ConversationLogProvider {
  return new OpenAiCodexConversationLogProvider(config);
}
