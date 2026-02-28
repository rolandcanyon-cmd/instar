/**
 * LedgerAuth — Ed25519 authentication for work ledger entries.
 *
 * Provides signing and verification for multi-machine/multi-user
 * work coordination. Each machine signs entries with its Ed25519
 * private key; any machine can verify using the signer's public key.
 *
 * Scenario A (same user): Signing optional, verification failures logged.
 * Scenario B (multi-user): Signing mandatory, unsigned entries rejected.
 *
 * From INTELLIGENT_SYNC_SPEC Section 5.4 (Ledger Entry Authentication).
 */

import { sign, verify } from './MachineIdentity.js';
import type { LedgerEntry } from './WorkLedger.js';

// ── Types ────────────────────────────────────────────────────────────

export type AuthScenario = 'same-user' | 'multi-user';

export type VerificationStatus = 'valid' | 'invalid' | 'unsigned' | 'key-not-found' | 'key-revoked';

export interface SigningResult {
  /** Whether signing succeeded. */
  success: boolean;
  /** The signature string (ed25519:base64...). */
  signature?: string;
  /** The fields that were signed. */
  signedFields?: string[];
  /** Error if signing failed. */
  error?: string;
}

export interface VerificationResult {
  /** Verification status. */
  status: VerificationStatus;
  /** Whether the entry should be trusted. */
  trusted: boolean;
  /** The machine ID from the entry. */
  machineId: string;
  /** Human-readable message. */
  message: string;
}

export interface KeyInfo {
  /** The machine's public key (PEM format). */
  publicKey: string;
  /** Whether this key has been revoked. */
  revoked: boolean;
  /** Machine ID this key belongs to. */
  machineId: string;
}

export interface LedgerAuthConfig {
  /** Operating scenario. */
  scenario: AuthScenario;
  /** This machine's Ed25519 private key (PEM). */
  privateKey?: string;
  /** This machine's ID. */
  machineId: string;
  /** Key resolver: given a machineId, returns its public key info. */
  keyResolver: (machineId: string) => KeyInfo | null;
}

// ── Constants ────────────────────────────────────────────────────────

const SIGNATURE_PREFIX = 'ed25519:';

/**
 * Default fields to include in signatures.
 * Covers identity + intent + timing — enough to prevent spoofing
 * without being fragile to cosmetic changes.
 */
const DEFAULT_SIGNED_FIELDS: Array<keyof LedgerEntry> = [
  'machineId',
  'userId',
  'sessionId',
  'task',
  'status',
  'updatedAt',
];

// ── LedgerAuth ───────────────────────────────────────────────────────

export class LedgerAuth {
  private scenario: AuthScenario;
  private privateKey?: string;
  private machineId: string;
  private keyResolver: (machineId: string) => KeyInfo | null;

  constructor(config: LedgerAuthConfig) {
    this.scenario = config.scenario;
    this.privateKey = config.privateKey;
    this.machineId = config.machineId;
    this.keyResolver = config.keyResolver;
  }

  // ── Signing ───────────────────────────────────────────────────────

  /**
   * Sign a ledger entry with this machine's private key.
   * Returns the signature and signed fields list.
   */
  signEntry(entry: LedgerEntry, fields?: Array<keyof LedgerEntry>): SigningResult {
    if (!this.privateKey) {
      if (this.scenario === 'multi-user') {
        return { success: false, error: 'Private key required for multi-user scenario' };
      }
      // Same-user: signing is optional
      return { success: false, error: 'No private key configured (optional in same-user mode)' };
    }

    const signedFields = fields ?? DEFAULT_SIGNED_FIELDS;
    const canonical = this.canonicalize(entry, signedFields);

    try {
      const sig = sign(canonical, this.privateKey);
      return {
        success: true,
        signature: `${SIGNATURE_PREFIX}${sig}`,
        signedFields: signedFields as string[],
      };
    } catch (err) {
      // @silent-fallback-ok — signing failure returns structured error to caller; not a silent degradation
      return {
        success: false,
        error: `Signing failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Sign a ledger entry in-place (mutates the entry).
   * Convenience method that sets signature + signedFields on the entry.
   */
  signEntryInPlace(entry: LedgerEntry, fields?: Array<keyof LedgerEntry>): boolean {
    const result = this.signEntry(entry, fields);
    if (result.success && result.signature && result.signedFields) {
      entry.signature = result.signature;
      entry.signedFields = result.signedFields;
      return true;
    }
    return false;
  }

  // ── Verification ──────────────────────────────────────────────────

  /**
   * Verify a ledger entry's signature.
   */
  verifyEntry(entry: LedgerEntry): VerificationResult {
    // Check if entry is signed
    if (!entry.signature || !entry.signedFields) {
      if (this.scenario === 'multi-user') {
        return {
          status: 'unsigned',
          trusted: false,
          machineId: entry.machineId,
          message: `Unsigned entry from machine "${entry.machineId}" — rejected in multi-user mode`,
        };
      }
      // Same-user: unsigned entries are acceptable
      return {
        status: 'unsigned',
        trusted: true,
        machineId: entry.machineId,
        message: `Unsigned entry from machine "${entry.machineId}" — accepted in same-user mode`,
      };
    }

    // Resolve the signing machine's public key
    const keyInfo = this.keyResolver(entry.machineId);
    if (!keyInfo) {
      return {
        status: 'key-not-found',
        trusted: false,
        machineId: entry.machineId,
        message: `Public key not found for machine "${entry.machineId}"`,
      };
    }

    // Check for revoked key
    if (keyInfo.revoked) {
      return {
        status: 'key-revoked',
        trusted: false,
        machineId: entry.machineId,
        message: `Key for machine "${entry.machineId}" has been revoked`,
      };
    }

    // Verify the signature
    const canonical = this.canonicalize(entry, entry.signedFields as Array<keyof LedgerEntry>);
    const sigBase64 = entry.signature.startsWith(SIGNATURE_PREFIX)
      ? entry.signature.slice(SIGNATURE_PREFIX.length)
      : entry.signature;

    try {
      const valid = verify(canonical, sigBase64, keyInfo.publicKey);
      if (valid) {
        return {
          status: 'valid',
          trusted: true,
          machineId: entry.machineId,
          message: `Valid signature from machine "${entry.machineId}"`,
        };
      } else {
        return {
          status: 'invalid',
          trusted: false,
          machineId: entry.machineId,
          message: `Invalid signature from machine "${entry.machineId}" — possible tampering`,
        };
      }
    } catch (err) {
      return {
        status: 'invalid',
        trusted: false,
        machineId: entry.machineId,
        message: `Signature verification error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Verify all entries in a set.
   * Returns entries grouped by verification status.
   */
  verifyEntries(entries: LedgerEntry[]): {
    trusted: LedgerEntry[];
    untrusted: LedgerEntry[];
    results: VerificationResult[];
  } {
    const trusted: LedgerEntry[] = [];
    const untrusted: LedgerEntry[] = [];
    const results: VerificationResult[] = [];

    for (const entry of entries) {
      const result = this.verifyEntry(entry);
      results.push(result);
      if (result.trusted) {
        trusted.push(entry);
      } else {
        untrusted.push(entry);
      }
    }

    return { trusted, untrusted, results };
  }

  // ── Configuration ─────────────────────────────────────────────────

  /**
   * Check if signing is required in the current scenario.
   */
  isSigningRequired(): boolean {
    return this.scenario === 'multi-user';
  }

  /**
   * Get the current scenario.
   */
  getScenario(): AuthScenario {
    return this.scenario;
  }

  // ── Private: Canonicalization ──────────────────────────────────────

  /**
   * Canonicalize an entry for signing/verification.
   *
   * Sort fields alphabetically, concatenate as "key=value\n".
   * Undefined/null values are represented as empty strings.
   */
  private canonicalize(entry: LedgerEntry, fields: Array<keyof LedgerEntry>): string {
    const sorted = [...fields].sort();
    const lines: string[] = [];

    for (const field of sorted) {
      const value = entry[field];
      const strValue = value === undefined || value === null
        ? ''
        : Array.isArray(value)
          ? value.join(',')
          : String(value);
      lines.push(`${field}=${strValue}`);
    }

    return lines.join('\n');
  }
}
