/**
 * ConversationLogTailer: polling tail of Claude's JSONL session log.
 */

import { promises as fs } from 'node:fs';
import type {
  ConversationLogTailer,
  ConversationLogTailOptions,
} from '../../../primitives/observability/conversationLogTailer.js';
import type { CanonicalEvent } from '../../../events.js';
import type { SessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import type { AnthropicHeadlessConfig } from '../config.js';
import { ANTHROPIC_HEADLESS_ID } from '../errors.js';
import { createSessionId } from './sessionId.js';
import { findJsonlForHandle } from './conversationLogReader.js';

async function* parseJsonlFromOffset(
  filePath: string,
  startOffset: number,
): AsyncIterable<{ event: CanonicalEvent; newOffset: number }> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return;
  }
  if (content.length <= startOffset) return;
  const newContent = content.slice(startOffset);
  const lines = newContent.split('\n').filter(Boolean);
  let bytesProcessed = startOffset;
  for (const line of lines) {
    bytesProcessed += line.length + 1; // +1 for the newline
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = String(entry['timestamp'] ?? new Date().toISOString());
    const type = String(entry['type'] ?? '');
    if (type === 'assistant' || type === 'user') {
      const message = entry['message'] as { content?: unknown[] } | undefined;
      const blocks = message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          const b = block as { type?: string; text?: string; name?: string; input?: unknown; id?: string };
          if (b.type === 'text' && b.text) {
            yield {
              newOffset: bytesProcessed,
              event: {
                type: 'message-delta',
                timestamp,
                providerId: ANTHROPIC_HEADLESS_ID,
                delta: b.text,
              },
            };
          } else if (b.type === 'tool_use') {
            yield {
              newOffset: bytesProcessed,
              event: {
                type: 'tool-call',
                timestamp,
                providerId: ANTHROPIC_HEADLESS_ID,
                toolCallId: String(b.id ?? ''),
                toolName: String(b.name ?? ''),
                arguments: b.input ?? {},
              },
            };
          }
        }
      }
    }
  }
}

class AnthropicHeadlessConversationLogTailer implements ConversationLogTailer {
  readonly capability = CapabilityFlag.ConversationLogTailer;

  constructor(private readonly config: AnthropicHeadlessConfig) {}

  tail(
    session: SessionHandle,
    options?: ConversationLogTailOptions,
  ): AsyncIterable<CanonicalEvent> {
    const cfg = this.config;
    const sessionIdImpl = createSessionId();
    const pollMs = options?.pollIntervalMs ?? 1000;
    const signal = options?.signal;
    return {
      async *[Symbol.asyncIterator]() {
        const claudeUuid = await sessionIdImpl.providerIdFor(session);
        const filePath = await findJsonlForHandle(session, cfg, claudeUuid ?? undefined);
        if (!filePath) return;
        let offset = 0;
        if (options?.fromTimestamp === undefined) {
          // Start from current end of file
          try {
            const stat = await fs.stat(filePath);
            offset = stat.size;
          } catch {
            offset = 0;
          }
        }
        while (!signal?.aborted) {
          for await (const { event, newOffset } of parseJsonlFromOffset(filePath, offset)) {
            if (options?.types && !options.types.includes(event.type)) continue;
            yield event;
            offset = newOffset;
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      },
    };
  }
}

export function createConversationLogTailer(
  config: AnthropicHeadlessConfig,
): ConversationLogTailer {
  return new AnthropicHeadlessConversationLogTailer(config);
}
