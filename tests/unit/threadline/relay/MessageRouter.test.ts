import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageRouter } from '../../../../src/threadline/relay/MessageRouter.js';
import { PresenceRegistry } from '../../../../src/threadline/relay/PresenceRegistry.js';
import { RelayRateLimiter } from '../../../../src/threadline/relay/RelayRateLimiter.js';
import type { MessageEnvelope } from '../../../../src/threadline/relay/types.js';

describe('MessageRouter', () => {
  let router: MessageRouter;
  let presence: PresenceRegistry;
  let rateLimiter: RelayRateLimiter;
  let sockets: Map<string, { send: ReturnType<typeof vi.fn>; readyState: number }>;

  beforeEach(() => {
    presence = new PresenceRegistry();
    rateLimiter = new RelayRateLimiter({
      perAgentPerMinute: 100,
      perAgentPerHour: 1000,
      perIPPerMinute: 200,
      globalPerMinute: 5000,
      discoveryPerMinute: 10,
      authAttemptsPerMinute: 5,
    });
    sockets = new Map();

    router = new MessageRouter({
      presence,
      rateLimiter,
      getSocket: (id) => sockets.get(id) as any,
      getIP: () => '1.2.3.4',
      maxEnvelopeSize: 256 * 1024,
    });

    // Register agents
    presence.register('sender-abc123', 'pub1', { name: 'Sender' }, 'public', 's1');
    presence.register('recip-def456', 'pub2', { name: 'Recipient' }, 'public', 's2');

    // Set up sockets
    sockets.set('sender-abc123', { send: vi.fn(), readyState: 1 });
    sockets.set('recip-def456', { send: vi.fn(), readyState: 1 });
  });

  const makeEnvelope = (overrides?: Partial<MessageEnvelope>): MessageEnvelope => ({
    from: 'sender-abc123',
    to: 'recip-def456',
    threadId: 'thread-1',
    messageId: `msg-${Date.now()}-${Math.random()}`,
    timestamp: new Date().toISOString(),
    nonce: Buffer.from('test-nonce').toString('base64'),
    ephemeralPubKey: Buffer.alloc(32).toString('base64'),
    salt: Buffer.alloc(32).toString('base64'),
    payload: Buffer.from('encrypted-content').toString('base64'),
    signature: Buffer.from('test-sig').toString('base64'),
    ...overrides,
  });

  describe('successful routing', () => {
    it('routes message to recipient', () => {
      const envelope = makeEnvelope();
      const result = router.route(envelope, 'sender-abc123');
      expect(result.delivered).toBe(true);
      expect(result.status).toBe('delivered');

      const recipSocket = sockets.get('recip-def456')!;
      expect(recipSocket.send).toHaveBeenCalledOnce();
      const sentData = JSON.parse(recipSocket.send.mock.calls[0][0]);
      expect(sentData.type).toBe('message');
      expect(sentData.envelope.messageId).toBe(envelope.messageId);
    });
  });

  describe('sender validation', () => {
    it('rejects mismatched sender fingerprint', () => {
      const envelope = makeEnvelope({ from: 'wrong-sender' });
      const result = router.route(envelope, 'sender-abc123');
      expect(result.delivered).toBe(false);
      expect(result.errorCode).toBe('invalid_signature');
    });
  });

  describe('envelope size', () => {
    it('rejects oversized envelopes', () => {
      const bigPayload = Buffer.alloc(300 * 1024).toString('base64');
      const envelope = makeEnvelope({ payload: bigPayload });
      const result = router.route(envelope, 'sender-abc123');
      expect(result.delivered).toBe(false);
      expect(result.errorCode).toBe('envelope_too_large');
    });
  });

  describe('replay detection', () => {
    it('rejects duplicate message IDs', () => {
      const envelope = makeEnvelope({ messageId: 'msg-unique-1' });
      router.route(envelope, 'sender-abc123');

      const duplicate = makeEnvelope({ messageId: 'msg-unique-1' });
      const result = router.route(duplicate, 'sender-abc123');
      expect(result.delivered).toBe(false);
      expect(result.errorCode).toBe('replay_detected');
    });

    it('allows different message IDs', () => {
      router.route(makeEnvelope({ messageId: 'msg-1' }), 'sender-abc123');
      const result = router.route(makeEnvelope({ messageId: 'msg-2' }), 'sender-abc123');
      expect(result.delivered).toBe(true);
    });
  });

  describe('rate limiting', () => {
    it('rejects when rate limited', () => {
      const strictLimiter = new RelayRateLimiter(
        { perAgentPerMinute: 2, perAgentPerHour: 100, perIPPerMinute: 100, globalPerMinute: 100, discoveryPerMinute: 10, authAttemptsPerMinute: 5 },
      );
      const strictRouter = new MessageRouter({
        presence,
        rateLimiter: strictLimiter,
        getSocket: (id) => sockets.get(id) as any,
        getIP: () => '1.2.3.4',
        maxEnvelopeSize: 256 * 1024,
      });

      // Use up the limit
      strictLimiter.recordMessage('sender-abc123', '1.2.3.4');
      strictLimiter.recordMessage('sender-abc123', '1.2.3.4');

      const result = strictRouter.route(makeEnvelope(), 'sender-abc123');
      expect(result.delivered).toBe(false);
      expect(result.errorCode).toBe('rate_limited');
    });
  });

  describe('recipient availability', () => {
    it('rejects when recipient is offline', () => {
      presence.unregister('recip-def456');
      const result = router.route(makeEnvelope(), 'sender-abc123');
      expect(result.delivered).toBe(false);
      expect(result.errorCode).toBe('recipient_offline');
    });

    it('rejects when recipient socket is closed', () => {
      sockets.set('recip-def456', { send: vi.fn(), readyState: 3 /* CLOSED */ });
      const result = router.route(makeEnvelope(), 'sender-abc123');
      expect(result.delivered).toBe(false);
      expect(result.errorCode).toBe('recipient_offline');
    });
  });

  describe('cleanup', () => {
    it('destroy clears state', () => {
      router.route(makeEnvelope(), 'sender-abc123');
      expect(router.replayCacheSize).toBe(1);
      router.destroy();
      expect(router.replayCacheSize).toBe(0);
    });
  });
});
