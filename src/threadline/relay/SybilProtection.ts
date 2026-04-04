/**
 * SybilProtection — Relay-side protection against identity flooding.
 *
 * Spec Section 3.12:
 * - Proof-of-Work at connection (Hashcash-style, ~1s commodity hardware)
 * - Dynamic difficulty (3x spike → scale up, 10x ceiling)
 * - Fast-solver throttling (<100ms = suspicious)
 * - Identity aging (new identities hidden from directory for 1h)
 * - IP rate limiting (10 new connections/min, 50 total/IP)
 * - Identity-level limits (5 identities per IP per hour)
 */

import crypto from 'node:crypto';

// ── Constants ────────────────────────────────────────────────────────

/** Default PoW difficulty: 20 leading zero bits (~1s on commodity hardware) */
const DEFAULT_DIFFICULTY = 20;

/** Max difficulty ceiling: 10x baseline = ~10s on commodity hardware */
const MAX_DIFFICULTY_BITS = DEFAULT_DIFFICULTY + 4; // ~16x baseline, capped

/** Epoch rotation interval (10 minutes) */
const EPOCH_INTERVAL_MS = 10 * 60 * 1000;

/** Fast-solver threshold: solutions under 100ms are suspicious */
const FAST_SOLVER_THRESHOLD_MS = 100;

/** Identity aging: new identities hidden for 1 hour */
export const IDENTITY_AGING_MS = 60 * 60 * 1000;

/** IP rate limits */
export const IP_LIMITS = {
  newConnectionsPerMinute: 10,
  totalConnectionsPerIP: 50,
  identitiesPerIPPerHour: 5,
} as const;

// ── Types ────────────────────────────────────────────────────────────

export interface PoWChallenge {
  epoch: string;       // hex-encoded epoch identifier
  difficulty: number;  // number of leading zero bits required
  issuedAt: number;    // timestamp for fast-solver detection
}

export interface PoWSolution {
  challenge: PoWChallenge;
  nonce: string;       // hex string
  solveTimeMs: number; // how long it took to solve (self-reported, verified by issuedAt)
}

export interface IPConnectionState {
  recentConnections: number[];  // timestamps of recent connections
  identities: Set<string>;     // fingerprints seen from this IP
  identityTimestamps: number[]; // when identities were first seen
}

// ── PoW Functions ────────────────────────────────────────────────────

/**
 * Generate a PoW challenge for a connecting agent.
 */
export function generateChallenge(
  clientIP: string,
  currentDifficulty?: number,
): PoWChallenge {
  const epoch = getCurrentEpoch();
  return {
    epoch,
    difficulty: currentDifficulty ?? DEFAULT_DIFFICULTY,
    issuedAt: Date.now(),
  };
}

/**
 * Verify a PoW solution.
 *
 * Checks:
 * 1. SHA-256(epoch || clientIP || nonce) has enough leading zero bits
 * 2. Epoch is current (within tolerance)
 * 3. Not solved suspiciously fast
 */
export function verifySolution(
  solution: PoWSolution,
  clientIP: string,
): { valid: boolean; suspicious: boolean; reason?: string } {
  // Check epoch freshness (allow previous + current epoch)
  const currentEpoch = getCurrentEpoch();
  const previousEpoch = getEpoch(Date.now() - EPOCH_INTERVAL_MS);
  if (solution.challenge.epoch !== currentEpoch && solution.challenge.epoch !== previousEpoch) {
    return { valid: false, suspicious: false, reason: 'Stale epoch — challenge expired' };
  }

  // Verify hash
  const hash = computePoWHash(solution.challenge.epoch, clientIP, solution.nonce);
  const leadingZeros = countLeadingZeroBits(hash);
  if (leadingZeros < solution.challenge.difficulty) {
    return { valid: false, suspicious: false, reason: `Insufficient work: ${leadingZeros} < ${solution.challenge.difficulty} bits` };
  }

  // Fast-solver detection
  const elapsedMs = Date.now() - solution.challenge.issuedAt;
  const suspicious = elapsedMs < FAST_SOLVER_THRESHOLD_MS;

  return { valid: true, suspicious };
}

/**
 * Solve a PoW challenge (for client-side use / testing).
 */
export function solveChallenge(challenge: PoWChallenge, clientIP: string): PoWSolution {
  const startTime = Date.now();
  let nonce = 0;

  while (true) {
    const nonceHex = nonce.toString(16).padStart(16, '0');
    const hash = computePoWHash(challenge.epoch, clientIP, nonceHex);
    if (countLeadingZeroBits(hash) >= challenge.difficulty) {
      return {
        challenge,
        nonce: nonceHex,
        solveTimeMs: Date.now() - startTime,
      };
    }
    nonce++;
  }
}

/**
 * Compute dynamic difficulty based on connection rate.
 *
 * Attack condition: >3x rolling 10-minute average = spike.
 * Difficulty scales linearly from 1x to ceiling proportional to spike magnitude.
 */
export function computeDynamicDifficulty(
  recentConnectionRate: number,
  baselineRate: number,
): number {
  if (baselineRate <= 0) return DEFAULT_DIFFICULTY;

  const ratio = recentConnectionRate / baselineRate;
  if (ratio <= 3) return DEFAULT_DIFFICULTY;

  // Linear scale from baseline to 10x ceiling
  const scaleFactor = Math.min((ratio - 3) / 7, 1); // 0 at 3x, 1 at 10x
  const extraBits = Math.floor(scaleFactor * (MAX_DIFFICULTY_BITS - DEFAULT_DIFFICULTY));
  return Math.min(DEFAULT_DIFFICULTY + extraBits, MAX_DIFFICULTY_BITS);
}

// ── IP Rate Limiter ──────────────────────────────────────────────────

export class IPRateLimiter {
  private ipStates: Map<string, IPConnectionState> = new Map();

  /**
   * Check if a new connection from an IP is allowed.
   */
  checkConnection(ip: string, fingerprint: string): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const state = this.getOrCreateState(ip);

    // Prune old entries
    const oneMinuteAgo = now - 60 * 1000;
    const oneHourAgo = now - 60 * 60 * 1000;
    state.recentConnections = state.recentConnections.filter(t => t > oneMinuteAgo);
    state.identityTimestamps = state.identityTimestamps.filter(t => t > oneHourAgo);

    // Check connections per minute
    if (state.recentConnections.length >= IP_LIMITS.newConnectionsPerMinute) {
      return { allowed: false, reason: `IP rate limit: ${IP_LIMITS.newConnectionsPerMinute} connections/min` };
    }

    // Check total connections per IP
    if (state.recentConnections.length >= IP_LIMITS.totalConnectionsPerIP) {
      return { allowed: false, reason: `IP total limit: ${IP_LIMITS.totalConnectionsPerIP} connections` };
    }

    // Check identities per IP per hour
    if (!state.identities.has(fingerprint) &&
        state.identityTimestamps.length >= IP_LIMITS.identitiesPerIPPerHour) {
      return { allowed: false, reason: `IP identity limit: ${IP_LIMITS.identitiesPerIPPerHour} identities/hour` };
    }

    // Record
    state.recentConnections.push(now);
    if (!state.identities.has(fingerprint)) {
      state.identities.add(fingerprint);
      state.identityTimestamps.push(now);
    }

    return { allowed: true };
  }

  /**
   * Check if an identity is old enough to appear in directory.
   */
  isIdentityAged(firstSeenTimestamp: number, now?: number): boolean {
    return ((now ?? Date.now()) - firstSeenTimestamp) >= IDENTITY_AGING_MS;
  }

  private getOrCreateState(ip: string): IPConnectionState {
    let state = this.ipStates.get(ip);
    if (!state) {
      state = { recentConnections: [], identities: new Set(), identityTimestamps: [] };
      this.ipStates.set(ip, state);
    }
    return state;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function getCurrentEpoch(): string {
  return getEpoch(Date.now());
}

function getEpoch(timestamp: number): string {
  const epochNum = Math.floor(timestamp / EPOCH_INTERVAL_MS);
  return epochNum.toString(16);
}

function computePoWHash(epoch: string, clientIP: string, nonce: string): Buffer {
  return crypto.createHash('sha256')
    .update(epoch)
    .update(clientIP)
    .update(nonce)
    .digest();
}

function countLeadingZeroBits(hash: Buffer): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
    } else {
      // Count leading zeros in this byte
      let mask = 0x80;
      while (mask > 0 && (byte & mask) === 0) {
        bits++;
        mask >>= 1;
      }
      break;
    }
  }
  return bits;
}
