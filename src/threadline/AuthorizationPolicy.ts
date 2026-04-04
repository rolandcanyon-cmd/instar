/**
 * AuthorizationPolicy — Scoped, time-bounded authorization grants.
 *
 * Spec Section 3.6: Separates trust state from delegation policy.
 * effective_permissions = trust_baseline ∩ granted_scope ∩ delegation_policy ∩ runtime_safety
 *
 * Evaluation is DETERMINISTIC (deny-overrides-allow, default-deny).
 * LLMs are NEVER used for policy enforcement.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_GRANT_TTL_MS } from '../identity/types.js';

// ── Types ────────────────────────────────────────────────────────────

export const POLICY_SCHEMA_VERSION = 1;

export type ResourceType = 'conversation' | 'tool' | 'file' | 'job' | 'session' | 'message';
export type ActionType = 'message' | 'request_task' | 'delegate' | 'read' | 'write' | 'execute' | 'probe';
export type PolicyEffect = 'allow' | 'deny';
export type DelegationMode = 'manual' | 'approval-required' | 'autonomous-within-scope';

export interface PolicyConstraints {
  ttl?: string;               // e.g. "4h", "15m", "24h"
  approvalRequired?: boolean;
  sandboxProfile?: string;
  rateLimit?: string;         // e.g. "100/h"
  maxSubAgents?: number;
  maxDelegationDepth?: number;
  filePaths?: string[];       // glob patterns
}

export interface AuthorizationGrant {
  id: string;                 // unique grant ID
  schemaVersion: number;
  subject: string;            // fingerprint or canonical ID
  resource: ResourceType;
  resourceId?: string;        // specific resource (e.g. tool name, file path). "*" = any
  action: ActionType;
  effect: PolicyEffect;
  constraints: PolicyConstraints;
  delegationMode: DelegationMode;
  currentDepth: number;       // issuer-signed, not self-reported
  issuedAt: string;           // ISO-8601
  expiresAt: string;          // ISO-8601
  issuer: string;             // fingerprint of the granting agent/user
}

export interface PolicyEvaluation {
  allowed: boolean;
  reason: string;
  matchedGrants: string[];    // grant IDs that were evaluated
  delegationMode?: DelegationMode;
}

// ── Manager ──────────────────────────────────────────────────────────

export class AuthorizationPolicyManager {
  private grants: Map<string, AuthorizationGrant> = new Map();
  private readonly stateFile: string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(stateDir: string) {
    this.stateFile = path.join(stateDir, 'threadline', 'authorization-grants.json');
    this.loadFromDisk();
  }

  /**
   * Create a new authorization grant.
   */
  createGrant(params: {
    subject: string;
    resource: ResourceType;
    resourceId?: string;
    action: ActionType;
    effect: PolicyEffect;
    constraints?: Partial<PolicyConstraints>;
    delegationMode?: DelegationMode;
    currentDepth?: number;
    issuer: string;
    ttlMs?: number;
  }): AuthorizationGrant {
    const now = new Date();
    const ttlMs = params.ttlMs ?? DEFAULT_GRANT_TTL_MS;

    const grant: AuthorizationGrant = {
      id: crypto.randomBytes(16).toString('hex'),
      schemaVersion: POLICY_SCHEMA_VERSION,
      subject: params.subject,
      resource: params.resource,
      resourceId: params.resourceId ?? '*',
      action: params.action,
      effect: params.effect,
      constraints: {
        maxDelegationDepth: 1,
        ...params.constraints,
      },
      delegationMode: params.delegationMode ?? 'approval-required',
      currentDepth: params.currentDepth ?? 0,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      issuer: params.issuer,
    };

    this.grants.set(grant.id, grant);
    this.scheduleSave();
    return grant;
  }

  /**
   * Evaluate whether an action is authorized.
   *
   * Algorithm (deterministic, deny-overrides-allow):
   * 1. Collect all matching policies (subject, resource, action)
   * 2. Prune expired grants
   * 3. If ANY matching policy has effect: "deny" → DENY
   * 4. If at least one "allow" with satisfied constraints → ALLOW
   * 5. No matching policies → DENY (default-deny)
   */
  evaluate(
    subject: string,
    resource: ResourceType,
    resourceId: string | undefined,
    action: ActionType,
  ): PolicyEvaluation {
    const now = new Date();
    const matching = this.findMatchingGrants(subject, resource, resourceId, action, now);

    if (matching.length === 0) {
      return {
        allowed: false,
        reason: 'No matching authorization grants (default-deny)',
        matchedGrants: [],
      };
    }

    // Deny overrides allow
    const denyGrants = matching.filter(g => g.effect === 'deny');
    if (denyGrants.length > 0) {
      return {
        allowed: false,
        reason: `Denied by explicit deny grant: ${denyGrants[0].id}`,
        matchedGrants: denyGrants.map(g => g.id),
      };
    }

    const allowGrants = matching.filter(g => g.effect === 'allow');
    if (allowGrants.length > 0) {
      // Use the most specific grant (specific resourceId > wildcard)
      const specific = allowGrants.find(g => g.resourceId !== '*' && g.resourceId === resourceId);
      const best = specific ?? allowGrants[0];

      return {
        allowed: true,
        reason: `Allowed by grant: ${best.id}`,
        matchedGrants: allowGrants.map(g => g.id),
        delegationMode: best.delegationMode,
      };
    }

    return {
      allowed: false,
      reason: 'No allow grants found (default-deny)',
      matchedGrants: matching.map(g => g.id),
    };
  }

  /**
   * Check if re-delegation is allowed for a grant.
   */
  canRedelegate(grantId: string): boolean {
    const grant = this.grants.get(grantId);
    if (!grant) return false;
    const maxDepth = grant.constraints.maxDelegationDepth ?? 1;
    return grant.currentDepth < maxDepth;
  }

  /**
   * Revoke a specific grant.
   */
  revokeGrant(grantId: string): boolean {
    const deleted = this.grants.delete(grantId);
    if (deleted) this.scheduleSave();
    return deleted;
  }

  /**
   * Revoke all grants for a subject.
   */
  revokeAllForSubject(subject: string): number {
    let count = 0;
    for (const [id, grant] of this.grants) {
      if (grant.subject === subject) {
        this.grants.delete(id);
        count++;
      }
    }
    if (count > 0) this.scheduleSave();
    return count;
  }

  /**
   * Get all active grants for a subject.
   */
  getGrantsForSubject(subject: string): AuthorizationGrant[] {
    const now = new Date();
    return [...this.grants.values()].filter(
      g => g.subject === subject && new Date(g.expiresAt) > now,
    );
  }

  /**
   * Prune expired grants.
   */
  pruneExpired(): number {
    const now = new Date();
    let pruned = 0;
    for (const [id, grant] of this.grants) {
      if (new Date(grant.expiresAt) <= now) {
        this.grants.delete(id);
        pruned++;
      }
    }
    if (pruned > 0) this.scheduleSave();
    return pruned;
  }

  /**
   * Get total active grant count.
   */
  get size(): number {
    return this.grants.size;
  }

  /**
   * Force save to disk (for shutdown).
   */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      this.saveToDisk();
    }
  }

  // ── Private ─────────────────────────────────────────────────────

  private findMatchingGrants(
    subject: string,
    resource: ResourceType,
    resourceId: string | undefined,
    action: ActionType,
    now: Date,
  ): AuthorizationGrant[] {
    return [...this.grants.values()].filter(g => {
      if (g.subject !== subject) return false;
      if (g.resource !== resource) return false;
      if (g.action !== action) return false;
      if (new Date(g.expiresAt) <= now) return false;
      // Wildcard matches any, specific matches exact
      if (g.resourceId !== '*' && resourceId && g.resourceId !== resourceId) return false;
      return true;
    });
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.saveToDisk();
      }, 2000);
    }
  }

  private saveToDisk(): void {
    this.dirty = false;
    const dir = path.dirname(this.stateFile);
    fs.mkdirSync(dir, { recursive: true });

    const data = JSON.stringify([...this.grants.values()], null, 2);
    const tmpPath = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, data, { mode: 0o600 });
    fs.renameSync(tmpPath, this.stateFile);
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
      if (Array.isArray(raw)) {
        for (const grant of raw) {
          if (grant.id) this.grants.set(grant.id, grant);
        }
      }
    } catch { /* start empty on corruption */ }
  }
}
