import { describe, it, expect } from 'vitest';
import {
  MessageEncryptor,
  computeFingerprint,
  edPrivateToX25519,
  deriveX25519PublicKey,
} from '../../../../src/threadline/client/MessageEncryptor.js';
import { generateIdentityKeyPair } from '../../../../src/threadline/ThreadlineCrypto.js';

describe('MessageEncryptor', () => {
  describe('computeFingerprint', () => {
    it('produces a 32-char hex string from a 32-byte public key', () => {
      const keypair = generateIdentityKeyPair();
      const fp = computeFingerprint(keypair.publicKey);
      expect(fp).toHaveLength(32);
      expect(/^[0-9a-f]{32}$/.test(fp)).toBe(true);
    });

    it('same key always produces same fingerprint', () => {
      const keypair = generateIdentityKeyPair();
      const fp1 = computeFingerprint(keypair.publicKey);
      const fp2 = computeFingerprint(keypair.publicKey);
      expect(fp1).toBe(fp2);
    });

    it('different keys produce different fingerprints', () => {
      const kp1 = generateIdentityKeyPair();
      const kp2 = generateIdentityKeyPair();
      expect(computeFingerprint(kp1.publicKey)).not.toBe(computeFingerprint(kp2.publicKey));
    });
  });

  describe('edPrivateToX25519', () => {
    it('produces a 32-byte key', () => {
      const keypair = generateIdentityKeyPair();
      const x25519Priv = edPrivateToX25519(keypair.privateKey);
      expect(x25519Priv).toHaveLength(32);
    });

    it('produces clamped key (RFC 7748)', () => {
      const keypair = generateIdentityKeyPair();
      const x25519Priv = edPrivateToX25519(keypair.privateKey);
      expect(x25519Priv[0] & 7).toBe(0);
      expect(x25519Priv[31] & 128).toBe(0);
      expect(x25519Priv[31] & 64).toBe(64);
    });

    it('is deterministic', () => {
      const keypair = generateIdentityKeyPair();
      const k1 = edPrivateToX25519(keypair.privateKey);
      const k2 = edPrivateToX25519(keypair.privateKey);
      expect(k1.equals(k2)).toBe(true);
    });
  });

  describe('deriveX25519PublicKey', () => {
    it('produces a 32-byte key', () => {
      const keypair = generateIdentityKeyPair();
      const x25519Pub = deriveX25519PublicKey(keypair.privateKey);
      expect(x25519Pub).toHaveLength(32);
    });

    it('is deterministic', () => {
      const keypair = generateIdentityKeyPair();
      const k1 = deriveX25519PublicKey(keypair.privateKey);
      const k2 = deriveX25519PublicKey(keypair.privateKey);
      expect(k1.equals(k2)).toBe(true);
    });
  });

  describe('encrypt / decrypt roundtrip', () => {
    it('encrypts and decrypts a simple message', () => {
      const alice = generateIdentityKeyPair();
      const bob = generateIdentityKeyPair();

      const aliceEncryptor = new MessageEncryptor(alice.privateKey, alice.publicKey);
      const bobEncryptor = new MessageEncryptor(bob.privateKey, bob.publicKey);

      const message = { content: 'Hello Bob!', type: 'text' };
      const envelope = aliceEncryptor.encrypt(
        bob.publicKey, bobEncryptor.x25519Public,
        'thread-1', message,
      );

      // Verify envelope structure
      expect(envelope.from).toBe(aliceEncryptor.fingerprint);
      expect(envelope.to).toBe(bobEncryptor.fingerprint);
      expect(envelope.threadId).toBe('thread-1');
      expect(envelope.messageId).toBeTruthy();
      expect(envelope.timestamp).toBeTruthy();
      expect(envelope.nonce).toBeTruthy();
      expect(envelope.ephemeralPubKey).toBeTruthy();
      expect(envelope.salt).toBeTruthy();
      expect(envelope.payload).toBeTruthy();
      expect(envelope.signature).toBeTruthy();

      // Bob decrypts
      const decrypted = bobEncryptor.decrypt(envelope, alice.publicKey, aliceEncryptor.x25519Public);
      expect(decrypted.content).toBe('Hello Bob!');
      expect(decrypted.type).toBe('text');
    });

    it('handles JSON metadata in messages', () => {
      const alice = generateIdentityKeyPair();
      const bob = generateIdentityKeyPair();

      const aliceEnc = new MessageEncryptor(alice.privateKey, alice.publicKey);
      const bobEnc = new MessageEncryptor(bob.privateKey, bob.publicKey);

      const message = {
        content: 'Check this out',
        type: 'code-review',
        metadata: { repo: 'my-project', pr: 42 },
      };

      const envelope = aliceEnc.encrypt(bob.publicKey, bobEnc.x25519Public, 'thread-2', message);
      const decrypted = bobEnc.decrypt(envelope, alice.publicKey, aliceEnc.x25519Public);

      expect(decrypted.content).toBe('Check this out');
      expect(decrypted.metadata).toEqual({ repo: 'my-project', pr: 42 });
    });

    it('handles unicode content', () => {
      const alice = generateIdentityKeyPair();
      const bob = generateIdentityKeyPair();

      const aliceEnc = new MessageEncryptor(alice.privateKey, alice.publicKey);
      const bobEnc = new MessageEncryptor(bob.privateKey, bob.publicKey);

      const message = { content: '你好世界 🌍 مرحبا' };
      const envelope = aliceEnc.encrypt(bob.publicKey, bobEnc.x25519Public, 'thread-3', message);
      const decrypted = bobEnc.decrypt(envelope, alice.publicKey, aliceEnc.x25519Public);
      expect(decrypted.content).toBe('你好世界 🌍 مرحبا');
    });

    it('handles empty content', () => {
      const alice = generateIdentityKeyPair();
      const bob = generateIdentityKeyPair();

      const aliceEnc = new MessageEncryptor(alice.privateKey, alice.publicKey);
      const bobEnc = new MessageEncryptor(bob.privateKey, bob.publicKey);

      const envelope = aliceEnc.encrypt(bob.publicKey, bobEnc.x25519Public, 'thread-4', { content: '' });
      const decrypted = bobEnc.decrypt(envelope, alice.publicKey, aliceEnc.x25519Public);
      expect(decrypted.content).toBe('');
    });

    it('handles large messages', () => {
      const alice = generateIdentityKeyPair();
      const bob = generateIdentityKeyPair();

      const aliceEnc = new MessageEncryptor(alice.privateKey, alice.publicKey);
      const bobEnc = new MessageEncryptor(bob.privateKey, bob.publicKey);

      const bigContent = 'x'.repeat(100_000);
      const envelope = aliceEnc.encrypt(bob.publicKey, bobEnc.x25519Public, 'thread-5', { content: bigContent });
      const decrypted = bobEnc.decrypt(envelope, alice.publicKey, aliceEnc.x25519Public);
      expect(decrypted.content).toBe(bigContent);
    });

    it('bidirectional: Bob can encrypt back to Alice', () => {
      const alice = generateIdentityKeyPair();
      const bob = generateIdentityKeyPair();

      const aliceEnc = new MessageEncryptor(alice.privateKey, alice.publicKey);
      const bobEnc = new MessageEncryptor(bob.privateKey, bob.publicKey);

      // Alice → Bob
      const env1 = aliceEnc.encrypt(bob.publicKey, bobEnc.x25519Public, 't', { content: 'Hi Bob' });
      expect(bobEnc.decrypt(env1, alice.publicKey, aliceEnc.x25519Public).content).toBe('Hi Bob');

      // Bob → Alice
      const env2 = bobEnc.encrypt(alice.publicKey, aliceEnc.x25519Public, 't', { content: 'Hi Alice' });
      expect(aliceEnc.decrypt(env2, bob.publicKey, bobEnc.x25519Public).content).toBe('Hi Alice');
    });
  });

  describe('security properties', () => {
    it('each message has unique nonce', () => {
      const alice = generateIdentityKeyPair();
      const bob = generateIdentityKeyPair();
      const enc = new MessageEncryptor(alice.privateKey, alice.publicKey);
      const bobEnc = new MessageEncryptor(bob.privateKey, bob.publicKey);

      const e1 = enc.encrypt(bob.publicKey, bobEnc.x25519Public, 't1', { content: 'msg1' });
      const e2 = enc.encrypt(bob.publicKey, bobEnc.x25519Public, 't1', { content: 'msg1' });

      expect(e1.nonce).not.toBe(e2.nonce);
      expect(e1.messageId).not.toBe(e2.messageId);
    });

    it('each message has unique ephemeral key', () => {
      const alice = generateIdentityKeyPair();
      const bob = generateIdentityKeyPair();
      const enc = new MessageEncryptor(alice.privateKey, alice.publicKey);
      const bobEnc = new MessageEncryptor(bob.privateKey, bob.publicKey);

      const e1 = enc.encrypt(bob.publicKey, bobEnc.x25519Public, 't1', { content: 'msg1' });
      const e2 = enc.encrypt(bob.publicKey, bobEnc.x25519Public, 't1', { content: 'msg1' });

      expect(e1.ephemeralPubKey).not.toBe(e2.ephemeralPubKey);
    });

    it('each message has unique salt', () => {
      const alice = generateIdentityKeyPair();
      const bob = generateIdentityKeyPair();
      const enc = new MessageEncryptor(alice.privateKey, alice.publicKey);
      const bobEnc = new MessageEncryptor(bob.privateKey, bob.publicKey);

      const e1 = enc.encrypt(bob.publicKey, bobEnc.x25519Public, 't1', { content: 'msg1' });
      const e2 = enc.encrypt(bob.publicKey, bobEnc.x25519Public, 't1', { content: 'msg1' });

      expect(e1.salt).not.toBe(e2.salt);
    });

    it('rejects tampered signature', () => {
      const alice = generateIdentityKeyPair();
      const bob = generateIdentityKeyPair();

      const aliceEnc = new MessageEncryptor(alice.privateKey, alice.publicKey);
      const bobEnc = new MessageEncryptor(bob.privateKey, bob.publicKey);

      const envelope = aliceEnc.encrypt(bob.publicKey, bobEnc.x25519Public, 't1', { content: 'secure' });

      const tampered = { ...envelope, signature: Buffer.alloc(64).toString('base64') };
      expect(() => bobEnc.decrypt(tampered, alice.publicKey, aliceEnc.x25519Public)).toThrow(/signature/i);
    });

    it('rejects wrong sender public key', () => {
      const alice = generateIdentityKeyPair();
      const bob = generateIdentityKeyPair();
      const mallory = generateIdentityKeyPair();

      const aliceEnc = new MessageEncryptor(alice.privateKey, alice.publicKey);
      const bobEnc = new MessageEncryptor(bob.privateKey, bob.publicKey);

      const envelope = aliceEnc.encrypt(bob.publicKey, bobEnc.x25519Public, 't1', { content: 'secure' });

      const malloryEnc = new MessageEncryptor(mallory.privateKey, mallory.publicKey);
      expect(() => bobEnc.decrypt(envelope, mallory.publicKey, malloryEnc.x25519Public)).toThrow(/signature/i);
    });

    it('payload is not readable without decryption', () => {
      const alice = generateIdentityKeyPair();
      const bob = generateIdentityKeyPair();
      const enc = new MessageEncryptor(alice.privateKey, alice.publicKey);
      const bobEnc = new MessageEncryptor(bob.privateKey, bob.publicKey);

      const envelope = enc.encrypt(bob.publicKey, bobEnc.x25519Public, 't1', { content: 'secret message' });

      const payloadBytes = Buffer.from(envelope.payload, 'base64');
      const payloadText = payloadBytes.toString('utf-8');
      expect(payloadText).not.toContain('secret message');
    });

    it('third party cannot decrypt even with relay access', () => {
      const alice = generateIdentityKeyPair();
      const bob = generateIdentityKeyPair();
      const eve = generateIdentityKeyPair();

      const aliceEnc = new MessageEncryptor(alice.privateKey, alice.publicKey);
      const bobEnc = new MessageEncryptor(bob.privateKey, bob.publicKey);
      const eveEnc = new MessageEncryptor(eve.privateKey, eve.publicKey);

      const envelope = aliceEnc.encrypt(bob.publicKey, bobEnc.x25519Public, 't1', { content: 'private' });

      // Eve tries to decrypt with her own keys — signature fails
      expect(() => eveEnc.decrypt(envelope, alice.publicKey, aliceEnc.x25519Public)).toThrow();
    });
  });

  describe('fingerprint consistency', () => {
    it('encryptor fingerprint matches computed fingerprint', () => {
      const keypair = generateIdentityKeyPair();
      const enc = new MessageEncryptor(keypair.privateKey, keypair.publicKey);
      expect(enc.fingerprint).toBe(computeFingerprint(keypair.publicKey));
    });

    it('x25519Public is exposed for key sharing', () => {
      const keypair = generateIdentityKeyPair();
      const enc = new MessageEncryptor(keypair.privateKey, keypair.publicKey);
      expect(enc.x25519Public).toHaveLength(32);
      expect(enc.x25519Public).toBeInstanceOf(Buffer);
    });
  });
});
