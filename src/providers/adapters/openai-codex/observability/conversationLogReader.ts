/**
 * ConversationLogReader implementation for openai-codex.
 *
 * Reads Codex's per-session rollout JSONL at $CODEX_HOME/sessions/YYYY/MM/
 * DD/rollout-<ts>-<uuid>.jsonl and normalizes its events to CanonicalEvent
 * via the same eventNormalizer the live agentic session uses.
 *
 * RULE 3.1 RATIONALE
 *   Criticality: high (degraded triage / resume)
 *   Frequency:   per-session-end / per-replay
 *   Stability:   semi-stable (Codex changes rollout schema occasionally)
 *   Fallback:    skip unparseable lines, emit ProviderRaw for unknown event types
 *   Verdict:     deterministic JSON parse via shared normalizer + canary
 */

import { promises as fs } from 'node:fs';
import type {
  ConversationLogReader,
  ConversationLogReadOptions,
} from '../../../primitives/observability/conversationLogReader.js';
import type { CanonicalEvent } from '../../../events.js';
import type { SessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import type { OpenAiCodexConfig } from '../config.js';
import { createSessionId } from './sessionId.js';
import { findRolloutFile } from './sessionPaths.js';
import { normalizeCodexJsonlEvent } from './eventNormalizer.js';

async function* parseRollout(filePath: string): AsyncIterable<CanonicalEvent> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const ev = normalizeCodexJsonlEvent(line);
    if (ev) yield ev;
  }
}

class OpenAiCodexConversationLogReader implements ConversationLogReader {
  readonly capability = CapabilityFlag.ConversationLogReader;

  constructor(private readonly config: OpenAiCodexConfig) {}

  async read(
    session: SessionHandle,
    options?: ConversationLogReadOptions,
  ): Promise<ReadonlyArray<CanonicalEvent>> {
    const threadId = await createSessionId().providerIdFor(session);
    if (!threadId) return [];
    const file = await findRolloutFile(threadId, this.config.codexHome);
    if (!file) return [];
    const out: CanonicalEvent[] = [];
    for await (const ev of parseRollout(file)) {
      if (options?.types && !options.types.includes(ev.type)) continue;
      if (options?.since && ev.timestamp < options.since) continue;
      if (options?.until && ev.timestamp > options.until) continue;
      out.push(ev);
      if (options?.limit && out.length >= options.limit) break;
    }
    return out;
  }

  readStream(
    session: SessionHandle,
    options?: ConversationLogReadOptions,
  ): AsyncIterable<CanonicalEvent> {
    const cfg = this.config;
    return {
      async *[Symbol.asyncIterator]() {
        const threadId = await createSessionId().providerIdFor(session);
        if (!threadId) return;
        const file = await findRolloutFile(threadId, cfg.codexHome);
        if (!file) return;
        let count = 0;
        for await (const ev of parseRollout(file)) {
          if (options?.types && !options.types.includes(ev.type)) continue;
          if (options?.since && ev.timestamp < options.since) continue;
          if (options?.until && ev.timestamp > options.until) continue;
          yield ev;
          count++;
          if (options?.limit && count >= options.limit) return;
        }
      },
    };
  }
}

export function createConversationLogReader(config: OpenAiCodexConfig): ConversationLogReader {
  return new OpenAiCodexConversationLogReader(config);
}
