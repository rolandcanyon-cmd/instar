/**
 * Threadline hub commands — deterministic "open this" / "tie this to <topic>"
 * (CMT-529). Both the `POST /threadline/hub/bind` route AND the structural
 * intercept in `telegram.onTopicMessage` use `bindHubConversation`, so the
 * behavior is identical regardless of how the message arrived. `parseHubCommand`
 * is a pure, tightly-anchored matcher so ordinary hub chat falls through to the
 * agent.
 */

import type { CollaborationSurfacer } from './CollaborationSurfacer.js';
import type { ConversationStore } from './ConversationStore.js';
import type { CommitmentTracker } from '../monitoring/CommitmentTracker.js';

export type HubCommand =
  | { action: 'open' }
  | { action: 'tie'; targetTopicId?: number; targetTopicName?: string };

/**
 * Deterministically classify a hub-topic message. Returns null for anything
 * that isn't *only* a hub command, so "can you open this and explain it?" is
 * left to the conversational agent.
 */
export function parseHubCommand(text: string): HubCommand | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  // "open this" / "open" / "Open This." — the message must be only the command.
  if (/^open(?:\s+this)?\s*[.!]?$/i.test(t)) return { action: 'open' };
  // "tie this to <topic>" / "bind this to <topic>"
  const tie = t.match(/^(?:tie|bind)\s+this\s+to\s+(.+?)\s*[.!]?$/i);
  if (tie) {
    const target = tie[1].trim();
    // "#1234" or a bare number → topic id; else a topic name (verbatim).
    const idMatch = target.match(/^#?(\d{1,15})$/);
    if (idMatch) return { action: 'tie', targetTopicId: Number(idMatch[1]) };
    return { action: 'tie', targetTopicName: target };
  }
  return null;
}

export interface HubBindDeps {
  collaborationSurfacer: CollaborationSurfacer;
  conversationStore: ConversationStore;
  commitmentTracker: CommitmentTracker | null;
  telegram: {
    findOrCreateForumTopic(name: string, iconColor?: number): Promise<{ topicId: number; name: string; reused: boolean }>;
    sendToTopic(topicId: number, text: string, options?: { silent?: boolean }): Promise<unknown>;
  };
}

export interface HubBindArgs {
  action: 'open' | 'tie';
  threadId?: string;
  targetTopicId?: number;
  targetTopicName?: string;
  /** When true (the human "open this" intercept), resolve the ambiguous case to
   * the most-recent unbound instead of returning a 409. The API path leaves this
   * false so a scripted caller gets the explicit "specify threadId" error. */
  autoPick?: boolean;
}

export type HubBindResult =
  | { ok: true; action: 'open' | 'tie'; threadId: string; topicId: number; topicName: string }
  | { ok: false; status: number; error: string };

const NAME_MAX = 40; // hard cap (Telegram allows 128; keep it short + low-exposure)
const CREDENTIAL_RE = /(sk-|xox[bap]-|ghp_|AKIA|-----BEGIN|password|secret|token|api[_-]?key)/i;

/**
 * Build a readable, scrubbed topic name from the conversation. Falls back to
 * `<peer> · <threadId8>` when there's no usable gist or it looks credential-like
 * (a cold first message could contain a secret — never splash that into a
 * chat-list-visible topic title).
 */
function topicNameFor(conv: { subject?: string; lastInboundHash?: string; participants?: { peers?: string[] } } | null, threadId: string): string {
  const peerRaw = conv?.participants?.peers?.[0] ?? 'agent';
  const peer = peerRaw.replace(/[^\w-]/g, '').slice(0, 24) || 'agent';
  const fallback = `${peer} · ${threadId.slice(0, 8)}`;

  const gistSource = (conv?.subject && conv.subject !== 'Relay message' ? conv.subject : conv?.lastInboundHash) ?? '';
  if (!gistSource || CREDENTIAL_RE.test(gistSource)) return fallback;
  const slug = gistSource
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 6)
    .join(' ')
    .slice(0, NAME_MAX)
    .trim();
  if (!slug || slug.length < 4) return fallback;
  return slug;
}

/**
 * Authoritatively bind a surfaced hub conversation to a topic. Returns a
 * discriminated result — NEVER touches an HTTP response; each caller owns its
 * own response + any extra messaging.
 */
export async function bindHubConversation(deps: HubBindDeps, args: HubBindArgs): Promise<HubBindResult> {
  const { collaborationSurfacer, conversationStore, commitmentTracker, telegram } = deps;
  if (args.action !== 'open' && args.action !== 'tie') {
    return { ok: false, status: 400, error: '"action" must be "open" or "tie"' };
  }

  // Resolve the conversation.
  let threadId = args.threadId;
  if (!threadId) {
    const mru = collaborationSurfacer.mostRecentUnbound();
    if (!mru.record) return { ok: false, status: 404, error: 'No unbound Threadline conversation in the hub to open' };
    if (mru.ambiguous && !args.autoPick) {
      return { ok: false, status: 409, error: 'More than one unbound conversation in the hub — specify which threadId to open' };
    }
    threadId = mru.record.threadId; // autoPick (or single) → most-recent
  }

  try {
    let topicId: number;
    let topicName: string;
    if (args.action === 'tie') {
      if (typeof args.targetTopicId === 'number') {
        topicId = args.targetTopicId;
        topicName = typeof args.targetTopicName === 'string' ? args.targetTopicName : `topic ${topicId}`;
      } else if (typeof args.targetTopicName === 'string' && args.targetTopicName) {
        const t = await telegram.findOrCreateForumTopic(args.targetTopicName);
        topicId = t.topicId; topicName = t.name;
      } else {
        return { ok: false, status: 400, error: 'tie requires targetTopicId or targetTopicName' };
      }
    } else {
      const existing = conversationStore.get(threadId);
      const name = topicNameFor(existing ?? null, threadId);
      const t = await telegram.findOrCreateForumTopic(name);
      topicId = t.topicId; topicName = t.name;
    }

    // Authoritative bind: conversation + commitment.
    await conversationStore.mutate(threadId, (c) => { c.boundTopicId = topicId; return c; });
    const commitment = commitmentTracker?.findByThreadId(threadId);
    if (commitment && commitmentTracker) {
      try { await commitmentTracker.mutate(commitment.id, (c) => { c.topicId = topicId; return c; }); }
      catch (e) { console.warn(`[hub/bind] commitment topicId update failed: ${e instanceof Error ? e.message : e}`); }
    }
    collaborationSurfacer.markBound(threadId);
    await telegram.sendToTopic(topicId, `🧵 This Threadline conversation is now tied to this topic — updates will land here.`).catch(() => { });
    await collaborationSurfacer.noteInHub(`Opened "${topicName}" (conversation ${threadId.slice(0, 8)}).`);
    return { ok: true, action: args.action, threadId, topicId, topicName };
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : String(err) };
  }
}
