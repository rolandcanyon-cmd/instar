/**
 * SessionId: bridge between SessionHandle and the underlying Claude session
 * UUID (the value that appears in hook events and conversation log filenames).
 *
 * Phase 3a: handles created by AgenticSessionHeadless embed the tmux name.
 * Claude session UUIDs are bound to handles via `bind(handle, uuid)` —
 * typically called by the HookEventReceiver when the first hook event
 * arrives for a session. Forward lookups then return that UUID.
 */

import type { SessionId } from '../../../primitives/observability/sessionId.js';
import type { SessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';

const handleToUuid = new Map<SessionHandle, string>();
const uuidToHandle = new Map<string, SessionHandle>();

/** Called by hook receiver when a hook event reveals the Claude session UUID. */
export function bindClaudeSessionId(handle: SessionHandle, claudeSessionId: string): void {
  handleToUuid.set(handle, claudeSessionId);
  uuidToHandle.set(claudeSessionId, handle);
}

class AnthropicHeadlessSessionId implements SessionId {
  readonly capability = CapabilityFlag.SessionId;

  async providerIdFor(session: SessionHandle): Promise<string | null> {
    return handleToUuid.get(session) ?? null;
  }

  async handleFor(providerSessionId: string): Promise<SessionHandle | null> {
    return uuidToHandle.get(providerSessionId) ?? null;
  }
}

export function createSessionId(): SessionId {
  return new AnthropicHeadlessSessionId();
}
