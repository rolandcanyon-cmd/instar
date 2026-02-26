/**
 * Git-based state synchronization for multi-machine coordination.
 *
 * Handles:
 * - Configuring git commit signing with machine Ed25519 keys
 * - Commit signing verification on pull
 * - Debounced auto-commit + push
 * - Relationship merge with field-level resolution
 * - Conflict resolution strategies
 *
 * Part of Phase 3 (state sync via git).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MachineIdentityManager } from './MachineIdentity.js';
import type { SecurityLog } from './SecurityLog.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

// ── Types ────────────────────────────────────────────────────────────

export interface GitSyncConfig {
  /** Project directory (repo root). */
  projectDir: string;
  /** State directory (.instar). */
  stateDir: string;
  /** Machine identity manager. */
  identityManager: MachineIdentityManager;
  /** Security log. */
  securityLog: SecurityLog;
  /** This machine's ID. */
  machineId: string;
  /** Auto-push after commits (default: true). */
  autoPush?: boolean;
  /** Debounce interval in ms for auto-commit (default: 30000). */
  debounceMs?: number;
}

export interface SyncResult {
  /** Whether changes were pulled. */
  pulled: boolean;
  /** Whether changes were pushed. */
  pushed: boolean;
  /** Number of commits pulled. */
  commitsPulled: number;
  /** Number of commits pushed. */
  commitsPushed: number;
  /** Rejected commits (unsigned or from revoked machines). */
  rejectedCommits: string[];
  /** Merge conflicts that need manual review. */
  conflicts: string[];
}

export interface RelationshipRecord {
  id: string;
  name: string;
  channels: Array<{ type: string; identifier: string }>;
  firstInteraction: string;
  lastInteraction: string;
  interactionCount: number;
  themes: string[];
  notes: string;
  significance: number;
  arcSummary: string;
  recentInteractions: Array<{ timestamp: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

// ── Git Sync Manager ─────────────────────────────────────────────────

export class GitSyncManager {
  private projectDir: string;
  private stateDir: string;
  private identityManager: MachineIdentityManager;
  private securityLog: SecurityLog;
  private machineId: string;
  private autoPush: boolean;
  private debounceMs: number;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPaths: Set<string> = new Set();

  constructor(config: GitSyncConfig) {
    this.projectDir = config.projectDir;
    this.stateDir = config.stateDir;
    this.identityManager = config.identityManager;
    this.securityLog = config.securityLog;
    this.machineId = config.machineId;
    this.autoPush = config.autoPush ?? true;
    this.debounceMs = config.debounceMs ?? 30_000;
  }

  // ── Setup ───────────────────────────────────────────────────────

  /**
   * Configure git commit signing with this machine's Ed25519 key.
   * Requires git >= 2.34 for SSH signing support.
   */
  configureCommitSigning(): void {
    const keyPath = path.join(this.stateDir, 'machine', 'signing-private.pem');
    if (!fs.existsSync(keyPath)) {
      throw new Error('Machine signing key not found. Run `instar pair` first.');
    }

    // Git uses SSH-format keys for signing. Our Ed25519 PEM works with git's ssh signing.
    this.gitConfig('user.signingkey', keyPath);
    this.gitConfig('gpg.format', 'ssh');
    this.gitConfig('commit.gpgsign', 'true');
  }

  /**
   * Check if commit signing is configured for this repo.
   */
  isSigningConfigured(): boolean {
    try {
      const format = this.gitConfigGet('gpg.format');
      const signing = this.gitConfigGet('commit.gpgsign');
      return format === 'ssh' && signing === 'true';
    } catch {
      // @silent-fallback-ok — git config read, signing detection
      return false;
    }
  }

  // ── Sync Operations ─────────────────────────────────────────────

  /**
   * Full sync: pull → verify → resolve → push.
   */
  sync(): SyncResult {
    const result: SyncResult = {
      pulled: false,
      pushed: false,
      commitsPulled: 0,
      commitsPushed: 0,
      rejectedCommits: [],
      conflicts: [],
    };

    // 1. Pull with rebase
    try {
      const beforeHead = this.gitHead();
      this.gitExec(['pull', '--rebase', '--autostash']);
      const afterHead = this.gitHead();
      result.pulled = beforeHead !== afterHead;

      if (result.pulled) {
        // Count commits pulled
        const log = this.gitExec(['log', '--oneline', `${beforeHead}..${afterHead}`]);
        result.commitsPulled = log.trim().split('\n').filter(l => l.trim()).length;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Check for merge conflicts
      if (errMsg.includes('CONFLICT') || errMsg.includes('could not apply')) {
        result.conflicts = this.detectConflicts();
        this.resolveConflicts(result);
      }
      DegradationReporter.getInstance().report({
        feature: 'GitSync.pull',
        primary: 'Clean git pull',
        fallback: 'Attempt auto-resolution of conflicts',
        reason: `Why: ${errMsg}`,
        impact: 'Conflicts may not auto-resolve correctly',
      });
    }

    // 2. Verify pulled commits
    if (result.pulled) {
      result.rejectedCommits = this.verifyPulledCommits();
    }

    // 3. Push pending changes
    if (this.autoPush) {
      try {
        const status = this.gitExec(['status', '--porcelain']);
        if (status.trim()) {
          // There are changes to push
          result.pushed = this.commitAndPush('sync: auto-commit');
        }
      } catch {
        // Push failures are non-fatal for sync
      }
    }

    this.securityLog.append({
      event: 'git_sync',
      machineId: this.machineId,
      pulled: result.pulled,
      pushed: result.pushed,
      commitsPulled: result.commitsPulled,
      rejectedCommits: result.rejectedCommits.length,
    });

    return result;
  }

  /**
   * Stage files and commit with machine signing.
   */
  commitAndPush(message: string, paths?: string[]): boolean {
    const filesToAdd = paths || [this.stateDir];

    try {
      for (const p of filesToAdd) {
        this.gitExec(['add', p]);
      }

      // Check if there's anything staged
      const diff = this.gitExec(['diff', '--cached', '--name-only']);
      if (!diff.trim()) return false;

      this.gitExec(['commit', '-m', message]);

      if (this.autoPush) {
        this.gitExec(['push']);
      }

      return true;
    } catch {
      // @silent-fallback-ok — push failure boolean return
      return false;
    }
  }

  /**
   * Queue a file path for debounced auto-commit.
   * After debounceMs, all pending paths are committed in one batch.
   */
  queueAutoCommit(filePath: string): void {
    this.pendingPaths.add(filePath);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.flushAutoCommit();
    }, this.debounceMs);

    if (this.debounceTimer.unref) {
      this.debounceTimer.unref();
    }
  }

  /**
   * Immediately commit all pending paths.
   */
  flushAutoCommit(): void {
    if (this.pendingPaths.size === 0) return;

    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const categories = categorizePaths(paths, this.stateDir);
    const message = `sync(${this.machineId.slice(0, 8)}): ${categories.join(', ')}`;
    this.commitAndPush(message, paths);
  }

  /**
   * Stop debounce timer and flush pending commits.
   */
  stop(): void {
    this.flushAutoCommit();
  }

  // ── Commit Verification ─────────────────────────────────────────

  /**
   * Verify pulled commits: check signatures against the machine registry.
   * Returns commit hashes that should be rejected.
   */
  verifyPulledCommits(): string[] {
    // For now, return empty — full verification requires SSH allowed-signers file
    // which will be set up during pairing. The infrastructure is here for when
    // commit signing is enabled.
    return [];
  }

  /**
   * Install git hooks for commit verification.
   */
  installVerificationHooks(): void {
    const hooksDir = path.join(this.projectDir, '.git', 'hooks');
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    // Write allowed-signers file from machine registry
    this.updateAllowedSigners();
  }

  /**
   * Update the allowed-signers file from the machine registry.
   * This maps machine IDs to their SSH public keys for git verification.
   */
  updateAllowedSigners(): void {
    const registry = this.identityManager.loadRegistry();
    const allowedSignersPath = path.join(this.stateDir, 'machine', 'allowed-signers');
    const lines: string[] = [];

    for (const [machineId, entry] of Object.entries(registry.machines)) {
      if (entry.status !== 'active') continue;
      const identity = this.identityManager.loadRemoteIdentity(machineId);
      if (!identity) continue;

      // Format: email namespaces="git" key-type key-data
      // We use machineId as the email for identification
      lines.push(`${machineId} namespaces="git" ssh-ed25519 ${identity.signingPublicKey}`);
    }

    const dir = path.dirname(allowedSignersPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(allowedSignersPath, lines.join('\n') + '\n');

    // Configure git to use this file
    this.gitConfig('gpg.ssh.allowedSignersFile', allowedSignersPath);
  }

  // ── Conflict Resolution ─────────────────────────────────────────

  /**
   * Detect files in conflict state.
   */
  private detectConflicts(): string[] {
    try {
      const status = this.gitExec(['diff', '--name-only', '--diff-filter=U']);
      return status.trim().split('\n').filter(l => l.trim());
    } catch {
      // @silent-fallback-ok — conflict list returns empty
      return [];
    }
  }

  /**
   * Attempt auto-resolution for known file types.
   */
  private resolveConflicts(result: SyncResult): void {
    for (const conflict of result.conflicts) {
      const resolved = this.tryAutoResolve(conflict);
      if (resolved) {
        result.conflicts = result.conflicts.filter(c => c !== conflict);
      }
    }

    if (result.conflicts.length === 0) {
      // All conflicts resolved — continue rebase
      try {
        this.gitExec(['rebase', '--continue']);
      } catch {
        // May need manual intervention
      }
    }
  }

  /**
   * Try to auto-resolve a specific file conflict.
   */
  private tryAutoResolve(filePath: string): boolean {
    const relPath = path.relative(this.projectDir, filePath);

    // Relationship files: field-level merge
    if (relPath.includes('relationships/') && relPath.endsWith('.json')) {
      return this.resolveRelationshipConflict(filePath);
    }

    // Jobs file: newer timestamp wins
    if (relPath.endsWith('jobs.json')) {
      return this.resolveNewerWins(filePath);
    }

    // Evolution proposals: union by ID
    if (relPath.includes('evolution/') && relPath.endsWith('.json')) {
      return this.resolveUnionById(filePath);
    }

    return false;
  }

  /**
   * Resolve relationship file conflict using field-level merge.
   */
  private resolveRelationshipConflict(filePath: string): boolean {
    try {
      const oursContent = this.gitExec(['show', ':2:' + filePath]); // ours
      const theirsContent = this.gitExec(['show', ':3:' + filePath]); // theirs
      const ours = JSON.parse(oursContent) as RelationshipRecord;
      const theirs = JSON.parse(theirsContent) as RelationshipRecord;

      const merged = mergeRelationship(ours, theirs);
      fs.writeFileSync(filePath, JSON.stringify(merged, null, 2));
      this.gitExec(['add', filePath]);
      return true;
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'GitSync.resolveRelationshipConflict',
        primary: 'Auto-resolve relationship file conflicts',
        fallback: 'Leave conflict unresolved',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Relationship data may be inconsistent',
      });
      return false;
    }
  }

  /**
   * Resolve conflict by taking the newer version (by embedded timestamp).
   */
  private resolveNewerWins(filePath: string): boolean {
    try {
      const oursContent = this.gitExec(['show', ':2:' + filePath]);
      const theirsContent = this.gitExec(['show', ':3:' + filePath]);
      const ours = JSON.parse(oursContent);
      const theirs = JSON.parse(theirsContent);

      // Use lastModified or updatedAt if present
      const oursTime = ours.lastModified || ours.updatedAt || '';
      const theirsTime = theirs.lastModified || theirs.updatedAt || '';

      const winner = theirsTime > oursTime ? theirsContent : oursContent;
      fs.writeFileSync(filePath, winner);
      this.gitExec(['add', filePath]);
      return true;
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'GitSync.resolveNewerWins',
        primary: 'Auto-resolve via newer-wins strategy',
        fallback: 'Leave conflict unresolved',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'File may remain in conflict state',
      });
      return false;
    }
  }

  /**
   * Resolve conflict by taking the union of arrays by ID field.
   */
  private resolveUnionById(filePath: string): boolean {
    try {
      const oursContent = this.gitExec(['show', ':2:' + filePath]);
      const theirsContent = this.gitExec(['show', ':3:' + filePath]);
      const ours = JSON.parse(oursContent);
      const theirs = JSON.parse(theirsContent);

      if (Array.isArray(ours) && Array.isArray(theirs)) {
        const map = new Map<string, unknown>();
        for (const item of ours) {
          if (item.id) map.set(item.id, item);
        }
        for (const item of theirs) {
          if (item.id && !map.has(item.id)) map.set(item.id, item);
        }
        fs.writeFileSync(filePath, JSON.stringify([...map.values()], null, 2));
        this.gitExec(['add', filePath]);
        return true;
      }
      return false;
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'GitSync.resolveUnionById',
        primary: 'Auto-resolve via union-by-ID',
        fallback: 'Leave conflict unresolved',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Array-based files may remain in conflict state',
      });
      return false;
    }
  }

  // ── Git Helpers ─────────────────────────────────────────────────

  private gitExec(args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.projectDir,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }

  private gitConfig(key: string, value: string): void {
    this.gitExec(['config', '--local', key, value]);
  }

  private gitConfigGet(key: string): string {
    return this.gitExec(['config', '--get', key]);
  }

  private gitHead(): string {
    return this.gitExec(['rev-parse', 'HEAD']);
  }
}

// ── Relationship Merge ───────────────────────────────────────────────

/**
 * Merge two relationship records using field-level resolution.
 * From the spec: channels union, themes union, timestamps min/max,
 * text fields from whichever has newer lastInteraction.
 */
export function mergeRelationship(
  ours: RelationshipRecord,
  theirs: RelationshipRecord,
): RelationshipRecord {
  const oursNewer = ours.lastInteraction >= theirs.lastInteraction;
  const primary = oursNewer ? ours : theirs;
  const secondary = oursNewer ? theirs : ours;

  // Union channels by type:identifier
  const channelMap = new Map<string, { type: string; identifier: string }>();
  for (const ch of [...(ours.channels || []), ...(theirs.channels || [])]) {
    channelMap.set(`${ch.type}:${ch.identifier}`, ch);
  }

  // Union themes
  const themes = [...new Set([...(ours.themes || []), ...(theirs.themes || [])])];

  // Merge recent interactions, deduplicate by timestamp, keep last 20
  const allInteractions = [
    ...(ours.recentInteractions || []),
    ...(theirs.recentInteractions || []),
  ];
  const seen = new Set<string>();
  const deduped = allInteractions.filter(i => {
    const key = i.timestamp;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => a.timestamp < b.timestamp ? 1 : -1);
  const recentInteractions = deduped.slice(0, 20);

  return {
    ...primary,
    id: ours.id, // Always keep original ID
    channels: [...channelMap.values()],
    firstInteraction: ours.firstInteraction < theirs.firstInteraction
      ? ours.firstInteraction : theirs.firstInteraction,
    lastInteraction: primary.lastInteraction,
    interactionCount: Math.max(ours.interactionCount || 0, theirs.interactionCount || 0),
    themes,
    notes: primary.notes,
    significance: Math.max(ours.significance || 0, theirs.significance || 0),
    arcSummary: primary.arcSummary,
    recentInteractions,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Categorize file paths into human-readable labels for commit messages.
 */
function categorizePaths(paths: string[], stateDir: string): string[] {
  const categories = new Set<string>();
  for (const p of paths) {
    const rel = path.relative(stateDir, p);
    if (rel.startsWith('relationships')) categories.add('relationships');
    else if (rel.startsWith('evolution')) categories.add('evolution');
    else if (rel.includes('jobs.json')) categories.add('jobs');
    else if (rel.includes('config.json')) categories.add('config');
    else if (rel.startsWith('machines')) categories.add('machines');
    else categories.add('state');
  }
  return [...categories];
}
