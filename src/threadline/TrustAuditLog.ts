/**
 * TrustAuditLog — Append-only hash-chain log for trust/authorization changes.
 *
 * Spec Section 6 (Phase 6 hardening):
 * - Every trust change and authorization grant/revoke is logged
 * - Hash chain ensures tamper detection
 * - 90-day retention, trust decisions only (no message content)
 * - Each entry references the hash of the previous entry
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────────

export type AuditAction =
  | 'trust-upgrade' | 'trust-downgrade' | 'trust-decay'
  | 'grant-create' | 'grant-revoke' | 'grant-expire'
  | 'invitation-create' | 'invitation-redeem' | 'invitation-revoke'
  | 'rotation-start' | 'rotation-complete'
  | 'revocation-initiate' | 'revocation-cancel' | 'revocation-activate'
  | 'injection-detected';

export interface AuditEntry {
  timestamp: string;          // ISO-8601
  action: AuditAction;
  subject: string;            // fingerprint or canonical ID affected
  actor: string;              // who performed the action (fingerprint, 'user', 'system')
  details: Record<string, unknown>;
  previousHash: string;       // hash of previous entry (empty string for first)
  hash: string;               // SHA-256 of this entry
}

// ── Logger ───────────────────────────────────────────────────────────

export class TrustAuditLog {
  private readonly logFile: string;
  private lastHash = '';
  private entryCount = 0;

  constructor(stateDir: string) {
    this.logFile = path.join(stateDir, 'threadline', 'trust-audit-chain.jsonl');
    this.loadLastHash();
  }

  /**
   * Append an entry to the audit log.
   */
  append(
    action: AuditAction,
    subject: string,
    actor: string,
    details: Record<string, unknown> = {},
  ): AuditEntry {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      action,
      subject,
      actor,
      details,
      previousHash: this.lastHash,
      hash: '', // computed below
    };

    entry.hash = this.computeHash(entry);
    this.lastHash = entry.hash;
    this.entryCount++;

    // Append to log file
    const dir = path.dirname(this.logFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n');

    return entry;
  }

  /**
   * Verify the integrity of the entire audit log.
   *
   * Reads every entry and checks that each entry's previousHash
   * matches the hash of the preceding entry.
   *
   * @returns true if chain is intact, false if tampered
   */
  verifyIntegrity(): { valid: boolean; entries: number; error?: string } {
    if (!fs.existsSync(this.logFile)) {
      return { valid: true, entries: 0 };
    }

    const lines = fs.readFileSync(this.logFile, 'utf-8').trim().split('\n').filter(l => l.length > 0);
    let previousHash = '';

    for (let i = 0; i < lines.length; i++) {
      let entry: AuditEntry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        return { valid: false, entries: i, error: `Entry ${i}: invalid JSON` };
      }

      // Check previousHash chain
      if (entry.previousHash !== previousHash) {
        return {
          valid: false, entries: i,
          error: `Entry ${i}: previousHash mismatch (expected ${previousHash.slice(0, 16)}..., got ${entry.previousHash.slice(0, 16)}...)`,
        };
      }

      // Verify entry hash
      const expectedHash = this.computeHash(entry);
      if (entry.hash !== expectedHash) {
        return {
          valid: false, entries: i,
          error: `Entry ${i}: hash mismatch (content tampered)`,
        };
      }

      previousHash = entry.hash;
    }

    return { valid: true, entries: lines.length };
  }

  /**
   * Get entry count (approximate, from load).
   */
  get size(): number {
    return this.entryCount;
  }

  // ── Private ─────────────────────────────────────────────────────

  private computeHash(entry: AuditEntry): string {
    const payload = `${entry.timestamp}|${entry.action}|${entry.subject}|${entry.actor}|${JSON.stringify(entry.details)}|${entry.previousHash}`;
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  private loadLastHash(): void {
    try {
      if (!fs.existsSync(this.logFile)) return;
      const content = fs.readFileSync(this.logFile, 'utf-8').trim();
      const lines = content.split('\n').filter(l => l.length > 0);
      this.entryCount = lines.length;
      if (lines.length > 0) {
        const lastEntry = JSON.parse(lines[lines.length - 1]) as AuditEntry;
        this.lastHash = lastEntry.hash;
      }
    } catch { /* start fresh */ }
  }
}
