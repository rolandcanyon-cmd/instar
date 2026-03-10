import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryOfflineQueue } from '../../../../src/threadline/relay/OfflineQueue.js';
import type { MessageEnvelope } from '../../../../src/threadline/relay/types.js';

const makeEnvelope = (overrides?: Partial<MessageEnvelope>): MessageEnvelope => ({
  from: 'sender1234abcd0000',
  to: 'recipient1234abcd00',
  threadId: 'thread-1',
  messageId: `msg-${Math.random().toString(36).slice(2)}`,
  timestamp: new Date().toISOString(),
  nonce: 'test-nonce',
  ephemeralPubKey: 'test-key',
  salt: 'test-salt',
  payload: Buffer.from('Hello offline agent').toString('base64'),
  signature: 'test-sig',
  ...overrides,
});

describe('InMemoryOfflineQueue', () => {
  let queue: InMemoryOfflineQueue;

  beforeEach(() => {
    queue = new InMemoryOfflineQueue({
      defaultTtlMs: 60_000, // 1 minute for tests
      maxPerSenderPerRecipient: 5,
      maxPerRecipient: 10,
      maxPayloadBytesPerRecipient: 10_000,
    });
  });

  afterEach(() => {
    queue.destroy();
  });

  // ── Basic Enqueue/Drain ─────────────────────────────────────────

  describe('enqueue and drain', () => {
    it('enqueues a message and drains it', () => {
      const envelope = makeEnvelope();
      const result = queue.enqueue(envelope);

      expect(result.queued).toBe(true);
      expect(result.ttlMs).toBe(60_000);

      const drained = queue.drain('recipient1234abcd00');
      expect(drained).toHaveLength(1);
      expect(drained[0].envelope.messageId).toBe(envelope.messageId);
    });

    it('drain returns empty for unknown recipient', () => {
      const drained = queue.drain('unknown0000000000');
      expect(drained).toHaveLength(0);
    });

    it('drain removes messages from queue', () => {
      queue.enqueue(makeEnvelope());
      queue.enqueue(makeEnvelope());

      const first = queue.drain('recipient1234abcd00');
      expect(first).toHaveLength(2);

      const second = queue.drain('recipient1234abcd00');
      expect(second).toHaveLength(0);
    });

    it('drains messages in order (oldest first)', () => {
      const env1 = makeEnvelope({ messageId: 'msg-1' });
      const env2 = makeEnvelope({ messageId: 'msg-2' });
      const env3 = makeEnvelope({ messageId: 'msg-3' });

      queue.enqueue(env1);
      queue.enqueue(env2);
      queue.enqueue(env3);

      const drained = queue.drain('recipient1234abcd00');
      expect(drained.map(m => m.envelope.messageId)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    });

    it('supports custom TTL per message', () => {
      const result = queue.enqueue(makeEnvelope(), 120_000);
      expect(result.ttlMs).toBe(120_000);
    });
  });

  // ── Queue Limits ───────────────────────────────────────────────

  describe('queue limits', () => {
    it('rejects when per-sender-per-recipient limit reached', () => {
      for (let i = 0; i < 5; i++) {
        const r = queue.enqueue(makeEnvelope());
        expect(r.queued).toBe(true);
      }

      const result = queue.enqueue(makeEnvelope());
      expect(result.queued).toBe(false);
      expect(result.reason).toBe('queue_full_sender');
    });

    it('rejects when per-recipient total limit reached', () => {
      // Fill with messages from different senders (5 per sender, 2 senders = 10 = limit)
      for (let i = 0; i < 5; i++) {
        queue.enqueue(makeEnvelope({ from: 'senderaaaa00000000' }));
      }
      for (let i = 0; i < 5; i++) {
        queue.enqueue(makeEnvelope({ from: 'senderbbbb00000000' }));
      }

      // 11th message should be rejected
      const result = queue.enqueue(makeEnvelope({ from: 'sendercccc00000000' }));
      expect(result.queued).toBe(false);
      expect(result.reason).toBe('queue_full_recipient');
    });

    it('rejects when payload byte limit reached', () => {
      const smallQueue = new InMemoryOfflineQueue({
        maxPayloadBytesPerRecipient: 500,
        maxPerSenderPerRecipient: 100,
        maxPerRecipient: 100,
      });

      // First message should fit
      const env1 = makeEnvelope({ payload: 'A'.repeat(100) });
      expect(smallQueue.enqueue(env1).queued).toBe(true);

      // Second message pushes over the limit
      const env2 = makeEnvelope({ payload: 'B'.repeat(400) });
      const result = smallQueue.enqueue(env2);
      expect(result.queued).toBe(false);
      expect(result.reason).toBe('queue_full_bytes');

      smallQueue.destroy();
    });

    it('different recipients have independent limits', () => {
      for (let i = 0; i < 5; i++) {
        queue.enqueue(makeEnvelope({ to: 'recipient1234abcd00' }));
      }

      // Different recipient should still accept
      const result = queue.enqueue(makeEnvelope({ to: 'recipientbbbb000000' }));
      expect(result.queued).toBe(true);
    });
  });

  // ── TTL Expiry ─────────────────────────────────────────────────

  describe('TTL expiry', () => {
    it('expireMessages removes expired messages', () => {
      vi.useFakeTimers();
      try {
        const env = makeEnvelope();
        queue.enqueue(env, 1000); // 1 second TTL

        // Before expiry
        const expired1 = queue.expireMessages();
        expect(expired1).toHaveLength(0);
        expect(queue.getDepth('recipient1234abcd00')).toBe(1);

        // After expiry
        vi.advanceTimersByTime(1500);
        const expired2 = queue.expireMessages();
        expect(expired2).toHaveLength(1);
        expect(expired2[0].messageId).toBe(env.messageId);
        expect(queue.getDepth('recipient1234abcd00')).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('drain filters out expired messages', () => {
      vi.useFakeTimers();
      try {
        queue.enqueue(makeEnvelope({ messageId: 'short-lived' }), 500);
        vi.advanceTimersByTime(100);
        queue.enqueue(makeEnvelope({ messageId: 'long-lived' }), 60_000);

        // Advance past first message's TTL
        vi.advanceTimersByTime(600);

        const drained = queue.drain('recipient1234abcd00');
        expect(drained).toHaveLength(1);
        expect(drained[0].envelope.messageId).toBe('long-lived');
      } finally {
        vi.useRealTimers();
      }
    });

    it('calls expiry callback', () => {
      vi.useFakeTimers();
      try {
        // Create queue AFTER fake timers so setInterval is interceptable
        const timedQueue = new InMemoryOfflineQueue({
          defaultTtlMs: 60_000,
          maxPerSenderPerRecipient: 5,
          maxPerRecipient: 10,
          maxPayloadBytesPerRecipient: 10_000,
        });
        const callback = vi.fn();
        timedQueue.onExpiry(callback);

        timedQueue.enqueue(makeEnvelope(), 500);

        // Trigger the internal 30s expiry check timer (after TTL expired)
        vi.advanceTimersByTime(30_500);

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(expect.arrayContaining([
          expect.objectContaining({ to: 'recipient1234abcd00' }),
        ]));

        timedQueue.destroy();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Stats and Depth ────────────────────────────────────────────

  describe('stats and depth', () => {
    it('getDepth returns correct count', () => {
      expect(queue.getDepth('recipient1234abcd00')).toBe(0);

      queue.enqueue(makeEnvelope());
      expect(queue.getDepth('recipient1234abcd00')).toBe(1);

      queue.enqueue(makeEnvelope());
      expect(queue.getDepth('recipient1234abcd00')).toBe(2);
    });

    it('getStats returns aggregate stats', () => {
      queue.enqueue(makeEnvelope({ to: 'recipientaaaa000000' }));
      queue.enqueue(makeEnvelope({ to: 'recipientaaaa000000' }));
      queue.enqueue(makeEnvelope({ to: 'recipientbbbb000000' }));

      const stats = queue.getStats();
      expect(stats.recipientCount).toBe(2);
      expect(stats.totalMessages).toBe(3);
      expect(stats.totalBytes).toBeGreaterThan(0);
    });
  });

  // ── Clear ──────────────────────────────────────────────────────

  describe('clear', () => {
    it('clears queue for a specific recipient', () => {
      queue.enqueue(makeEnvelope({ to: 'recipientaaaa000000' }));
      queue.enqueue(makeEnvelope({ to: 'recipientbbbb000000' }));

      queue.clear('recipientaaaa000000');

      expect(queue.getDepth('recipientaaaa000000')).toBe(0);
      expect(queue.getDepth('recipientbbbb000000')).toBe(1);
    });
  });

  // ── Destroy ────────────────────────────────────────────────────

  describe('destroy', () => {
    it('clears all state and stops timers', () => {
      queue.enqueue(makeEnvelope());
      queue.destroy();

      expect(queue.getStats().totalMessages).toBe(0);
    });
  });
});
