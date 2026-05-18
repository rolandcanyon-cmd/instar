/**
 * SessionId implementation for openai-codex.
 *
 * Codex assigns a UUIDv7 to each thread. The adapter's SessionHandle is
 * `openai-codex/<tmuxName>` while the codex-side thread ID is a UUIDv7
 * captured at thread.started time. This primitive provides the binding.
 */

import type { CancellationOptions, SessionHandle } from '../../../types.js';
import { sessionHandle } from '../../../types.js';
import type { SessionId } from '../../../primitives/observability/sessionId.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { OPENAI_CODEX_ID } from '../errors.js';

const handleToThread = new Map<SessionHandle, string>();
const threadToHandle = new Map<string, SessionHandle>();

class OpenAiCodexSessionId implements SessionId {
  readonly capability = CapabilityFlag.SessionId;

  async providerIdFor(session: SessionHandle, _options?: CancellationOptions): Promise<string | null> {
    return handleToThread.get(session) ?? null;
  }

  async handleFor(providerSessionId: string, _options?: CancellationOptions): Promise<SessionHandle | null> {
    return threadToHandle.get(providerSessionId) ?? null;
  }
}

/**
 * Bind a Codex thread UUID to a SessionHandle. Called by the
 * AgenticSessionHeadless primitive when it observes the first
 * `thread.started` event in the JSONL stream.
 */
export function bindCodexThreadId(handle: SessionHandle, threadId: string): void {
  handleToThread.set(handle, threadId);
  threadToHandle.set(threadId, handle);
}

/** Looks up the SessionHandle for a Codex thread, even from a string. */
export function handleForThreadId(threadId: string): SessionHandle | null {
  return threadToHandle.get(threadId) ?? null;
}

/** Construct a session handle for a known thread without an active tmux session. */
export function syntheticHandleForThread(threadId: string): SessionHandle {
  return sessionHandle(`${OPENAI_CODEX_ID}/thread-${threadId}`);
}

export function createSessionId(): SessionId {
  return new OpenAiCodexSessionId();
}
