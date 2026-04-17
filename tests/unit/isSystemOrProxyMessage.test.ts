// Unit tests for the shared classifier used by CompactionSentinel's
// recoverFn, PresenceProxy's race guard, and checkLogForAgentResponse.
//
// Regression anchor: topic 6795 compaction stall (2026-04-17). The
// compaction-recovery path declined three times in a row because the only
// from-agent message since the user's question was a PresenceProxy standby
// ("🔭 Echo is currently updating the ledger spec…"). Recovery treated the
// standby as "agent answered" and refused to re-inject. These tests pin
// down the classifier + walk-back semantics so that regression cannot
// silently recur.

import { describe, it, expect } from 'vitest';
import {
  isSystemOrProxyMessage,
  findLastRealMessage,
} from '../../src/messaging/shared/isSystemOrProxyMessage.js';

describe('isSystemOrProxyMessage', () => {
  describe('empty / degenerate inputs', () => {
    it('treats null as system', () => {
      expect(isSystemOrProxyMessage(null)).toBe(true);
    });

    it('treats undefined as system', () => {
      expect(isSystemOrProxyMessage(undefined)).toBe(true);
    });

    it('treats empty string as system', () => {
      expect(isSystemOrProxyMessage('')).toBe(true);
    });

    it('treats whitespace-only string as system', () => {
      expect(isSystemOrProxyMessage('   \n\t  ')).toBe(true);
    });
  });

  describe('delivery / lifecycle acks', () => {
    it('classifies exact "✓ Delivered" as system', () => {
      expect(isSystemOrProxyMessage('✓ Delivered')).toBe(true);
    });

    it('classifies "✓ Delivered" with suffix as system', () => {
      expect(isSystemOrProxyMessage('✓ Delivered to 3 topics')).toBe(true);
    });

    it('classifies "🔄 Session restarting" prefix as system', () => {
      expect(isSystemOrProxyMessage('🔄 Session restarting — hold tight')).toBe(true);
    });

    it('classifies "Session respawned." exact match as system', () => {
      expect(isSystemOrProxyMessage('Session respawned.')).toBe(true);
    });

    it('classifies "Session terminated." exact match as system', () => {
      expect(isSystemOrProxyMessage('Session terminated.')).toBe(true);
    });

    it('classifies "Send a new message to start" prefix as system', () => {
      expect(isSystemOrProxyMessage('Send a new message to start a new session.')).toBe(true);
    });
  });

  describe('PresenceProxy standby messages', () => {
    it('classifies any 🔭-prefixed message as proxy — this is the topic-6795 anchor', () => {
      expect(
        isSystemOrProxyMessage('🔭 Echo is currently updating the ledger spec…'),
      ).toBe(true);
    });

    it('classifies minimal 🔭 proxy as proxy', () => {
      expect(isSystemOrProxyMessage('🔭 working')).toBe(true);
    });
  });

  describe('real agent responses', () => {
    it('does NOT classify a substantive agent reply as system', () => {
      expect(
        isSystemOrProxyMessage(
          "Found the root cause — it's a real bug in the compaction-recovery lifecycle.",
        ),
      ).toBe(false);
    });

    it('does NOT classify a short plain-text reply as system', () => {
      expect(isSystemOrProxyMessage('ok')).toBe(false);
    });

    it('does NOT classify a message merely CONTAINING 🔭 later as proxy', () => {
      // Guard against over-block: only leading 🔭 is the proxy marker.
      expect(
        isSystemOrProxyMessage('Here is a telescope emoji 🔭 in my explanation.'),
      ).toBe(false);
    });

    it('does NOT classify a checkmark used in narrative as a delivery ack', () => {
      // Guard against over-block: the delivery ack must start with the
      // exact "✓ Delivered" prefix. An agent using ✓ elsewhere is fine.
      expect(isSystemOrProxyMessage('✓ tests pass, shipping now')).toBe(false);
    });
  });

  describe('trim handling', () => {
    it('trims before matching — leading whitespace + 🔭 still counts', () => {
      expect(isSystemOrProxyMessage('   🔭 standby')).toBe(true);
    });

    it('trims before matching — trailing whitespace around ✓ Delivered', () => {
      expect(isSystemOrProxyMessage('  ✓ Delivered  ')).toBe(true);
    });
  });
});

describe('findLastRealMessage', () => {
  type Msg = { text?: string | null; fromUser?: boolean; tag?: string };

  it('returns null for empty history', () => {
    expect(findLastRealMessage<Msg>([])).toBeNull();
  });

  it('returns null when every entry is system/proxy', () => {
    const history: Msg[] = [
      { text: '✓ Delivered', fromUser: false },
      { text: '🔭 working', fromUser: false },
      { text: 'Session respawned.', fromUser: false },
    ];
    expect(findLastRealMessage(history)).toBeNull();
  });

  it('returns the only real message when it is last', () => {
    const history: Msg[] = [
      { text: '✓ Delivered', fromUser: false, tag: 'sys' },
      { text: 'hello from user', fromUser: true, tag: 'target' },
    ];
    expect(findLastRealMessage(history)?.tag).toBe('target');
  });

  it('walks past trailing proxy messages and returns the earlier user message — topic-6795 repro', () => {
    // This is the EXACT sequence that let recoverCompactedSession decline
    // three times for topic 6795. The user asked a question; then the
    // PresenceProxy sent a standby ("🔭 …updating the ledger spec…");
    // then compaction was detected. Pre-fix code looked at the last
    // message only, saw it was from-agent, and refused to recover.
    const history: Msg[] = [
      { text: 'earlier agent turn', fromUser: false, tag: 'prev-agent' },
      { text: 'Please proceed here', fromUser: true, tag: 'user-question' },
      { text: '🔭 Echo is currently updating the ledger spec…', fromUser: false, tag: 'proxy' },
      { text: '✓ Delivered', fromUser: false, tag: 'ack' },
    ];

    const found = findLastRealMessage(history);
    expect(found?.tag).toBe('user-question');
    expect(found?.fromUser).toBe(true);
  });

  it('returns a real agent response when the agent has actually answered', () => {
    const history: Msg[] = [
      { text: 'user question', fromUser: true, tag: 'user' },
      { text: 'Here is the answer you asked for.', fromUser: false, tag: 'real-reply' },
      { text: '✓ Delivered', fromUser: false, tag: 'ack' },
    ];

    const found = findLastRealMessage(history);
    expect(found?.tag).toBe('real-reply');
    expect(found?.fromUser).toBe(false);
  });

  it('tolerates missing text fields', () => {
    const history: Msg[] = [
      { fromUser: true, tag: 'no-text-user' }, // no text — classified as system (empty)
      { text: 'real one', fromUser: false, tag: 'real' },
    ];
    expect(findLastRealMessage(history)?.tag).toBe('real');
  });

  it('is chronological-order aware — expects oldest-first input', () => {
    // getTopicHistory returns oldest→newest. findLastRealMessage scans from
    // the end (newest) backward. This test pins that contract.
    const history: Msg[] = [
      { text: 'oldest real', fromUser: true, tag: 'oldest' },
      { text: '🔭 proxy', fromUser: false, tag: 'proxy' },
      { text: 'newest real', fromUser: false, tag: 'newest' },
    ];
    expect(findLastRealMessage(history)?.tag).toBe('newest');
  });
});
