/**
 * ConversationLogProvider: compose reader + tailer for seamless read-and-tail.
 */

import type {
  ConversationLogProvider,
  ConversationLogProviderOptions,
} from '../../../primitives/integration/conversationLogProvider.js';
import type { CanonicalEvent } from '../../../events.js';
import type { SessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import type { AnthropicHeadlessConfig } from '../config.js';
import { createConversationLogReader } from '../observability/conversationLogReader.js';
import { createConversationLogTailer } from '../observability/conversationLogTailer.js';

class AnthropicHeadlessConversationLogProvider implements ConversationLogProvider {
  readonly capability = CapabilityFlag.ConversationLogProvider;
  private readonly reader: ReturnType<typeof createConversationLogReader>;
  private readonly tailer: ReturnType<typeof createConversationLogTailer>;

  constructor(config: AnthropicHeadlessConfig) {
    this.reader = createConversationLogReader(config);
    this.tailer = createConversationLogTailer(config);
  }

  readAndTail(
    session: SessionHandle,
    options?: ConversationLogProviderOptions,
  ): AsyncIterable<CanonicalEvent> {
    const reader = this.reader;
    const tailer = this.tailer;
    return {
      async *[Symbol.asyncIterator]() {
        let lastTimestamp: string | undefined = options?.since;
        for await (const ev of reader.readStream(session, { types: options?.types, since: options?.since, signal: options?.signal })) {
          yield ev;
          lastTimestamp = ev.timestamp;
        }
        for await (const ev of tailer.tail(session, {
          types: options?.types,
          fromTimestamp: lastTimestamp,
          signal: options?.signal,
        })) {
          yield ev;
        }
      },
    };
  }
}

export function createConversationLogProviderImpl(
  config: AnthropicHeadlessConfig,
): ConversationLogProvider {
  return new AnthropicHeadlessConversationLogProvider(config);
}
