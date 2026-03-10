/**
 * IdentityManager — Manages Ed25519 identity keys for relay agents.
 *
 * Generates, stores, and loads identity keypairs from disk.
 * Part of Threadline Relay Phase 1.
 */

import fs from 'node:fs';
import path from 'node:path';
import { generateIdentityKeyPair, type KeyPair } from '../ThreadlineCrypto.js';
import { computeFingerprint, deriveX25519PublicKey } from './MessageEncryptor.js';
import type { AgentFingerprint } from '../relay/types.js';

export interface IdentityInfo {
  fingerprint: AgentFingerprint;
  publicKey: Buffer;      // Ed25519 public key
  privateKey: Buffer;     // Ed25519 private key
  x25519PublicKey: Buffer; // X25519 public key (derived from Ed25519)
  createdAt: string;
}

export class IdentityManager {
  private readonly stateDir: string;
  private readonly keyFile: string;
  private identity: IdentityInfo | null = null;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.keyFile = path.join(stateDir, 'threadline', 'identity.json');
  }

  /**
   * Get or create the agent's identity.
   * Generates a new keypair on first use, loads from disk on subsequent uses.
   */
  getOrCreate(): IdentityInfo {
    if (this.identity) return this.identity;

    // Try loading from disk
    const loaded = this.loadFromDisk();
    if (loaded) {
      this.identity = loaded;
      return loaded;
    }

    // Generate new identity
    const keypair = generateIdentityKeyPair();
    const identity: IdentityInfo = {
      fingerprint: computeFingerprint(keypair.publicKey),
      publicKey: keypair.publicKey,
      privateKey: keypair.privateKey,
      x25519PublicKey: deriveX25519PublicKey(keypair.privateKey),
      createdAt: new Date().toISOString(),
    };

    this.saveToDisk(identity);
    this.identity = identity;
    return identity;
  }

  /**
   * Get the current identity without creating a new one.
   */
  get(): IdentityInfo | null {
    if (this.identity) return this.identity;
    const loaded = this.loadFromDisk();
    if (loaded) {
      this.identity = loaded;
    }
    return this.identity;
  }

  /**
   * Check if an identity exists.
   */
  exists(): boolean {
    return this.identity !== null || fs.existsSync(this.keyFile);
  }

  /**
   * Get the directory where keys are stored.
   */
  get keyDir(): string {
    return path.dirname(this.keyFile);
  }

  // ── Private ─────────────────────────────────────────────────────

  private loadFromDisk(): IdentityInfo | null {
    try {
      if (!fs.existsSync(this.keyFile)) return null;
      const raw = JSON.parse(fs.readFileSync(this.keyFile, 'utf-8'));
      const privateKey = Buffer.from(raw.privateKey, 'base64');
      return {
        fingerprint: raw.fingerprint,
        publicKey: Buffer.from(raw.publicKey, 'base64'),
        privateKey,
        x25519PublicKey: raw.x25519PublicKey
          ? Buffer.from(raw.x25519PublicKey, 'base64')
          : deriveX25519PublicKey(privateKey),
        createdAt: raw.createdAt,
      };
    } catch {
      return null;
    }
  }

  private saveToDisk(identity: IdentityInfo): void {
    const dir = path.dirname(this.keyFile);
    fs.mkdirSync(dir, { recursive: true });

    const data = JSON.stringify({
      fingerprint: identity.fingerprint,
      publicKey: identity.publicKey.toString('base64'),
      privateKey: identity.privateKey.toString('base64'),
      x25519PublicKey: identity.x25519PublicKey.toString('base64'),
      createdAt: identity.createdAt,
    }, null, 2);

    // Atomic write
    const tmpPath = `${this.keyFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, data, { mode: 0o600 });
    fs.renameSync(tmpPath, this.keyFile);
  }
}
