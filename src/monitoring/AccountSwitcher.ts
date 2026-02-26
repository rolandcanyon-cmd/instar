/**
 * Account Switcher — swap active Claude Code account via Keychain manipulation.
 *
 * Reads/writes the macOS Keychain entry used by Claude Code for OAuth credentials.
 * Supports fuzzy matching of account names (e.g., "dawn" matches "dawn@sagemindai.io").
 *
 * Ported from Dawn's dawn-server equivalent for general Instar use.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

interface AccountEntry {
  email: string;
  name: string | null;
  rateLimitTier: string | null;
  cachedOAuth: {
    accessToken: string;
    expiresAt: number;
  } | null;
  tokenCachedAt: string | null;
  staleSince: string | null;
  lastQuotaSnapshot: {
    collectedAt: string;
    weeklyUtilization: number;
    fiveHourUtilization: number;
    weeklyResetsAt: string | null;
    fiveHourResetsAt: string | null;
    sonnetUtilization: number;
    percentUsed: number;
    canRunPriority: string;
  } | null;
}

interface AccountRegistry {
  schemaVersion: number;
  accounts: Record<string, AccountEntry>;
  activeAccountEmail: string | null;
  lastUpdated: string;
}

export interface SwitchResult {
  success: boolean;
  message: string;
  previousAccount: string | null;
  newAccount: string | null;
}

export class AccountSwitcher {
  private registryPath: string;
  private keychainAccount: string;

  constructor(registryPath?: string) {
    this.registryPath = registryPath || path.join(
      process.env.HOME || '',
      '.dawn-server/account-registry.json'
    );
    // Get the macOS username for Keychain access
    this.keychainAccount = os.userInfo().username;
  }

  /**
   * Switch to a target account. Supports fuzzy matching:
   * - "dawn" matches "dawn@sagemindai.io"
   * - Full email also works
   */
  async switchAccount(target: string): Promise<SwitchResult> {
    const registry = this.loadRegistry();
    if (!registry) {
      return { success: false, message: 'Account registry not found', previousAccount: null, newAccount: null };
    }

    const resolvedEmail = this.resolveAccount(target, registry);
    if (!resolvedEmail) {
      const available = Object.keys(registry.accounts)
        .map(e => {
          const a = registry.accounts[e];
          return `${a.name || 'unknown'} (${e})`;
        })
        .join(', ');
      return {
        success: false,
        message: `Unknown account "${target}". Available: ${available}`,
        previousAccount: registry.activeAccountEmail,
        newAccount: null,
      };
    }

    const account = registry.accounts[resolvedEmail];
    if (!account) {
      return {
        success: false,
        message: `Account ${resolvedEmail} not in registry`,
        previousAccount: registry.activeAccountEmail,
        newAccount: null,
      };
    }

    if (!account.cachedOAuth?.accessToken) {
      return {
        success: false,
        message: `No cached token for ${resolvedEmail}. Use /login to authenticate.`,
        previousAccount: registry.activeAccountEmail,
        newAccount: null,
      };
    }

    if (account.cachedOAuth.expiresAt && account.cachedOAuth.expiresAt < Date.now()) {
      return {
        success: false,
        message: `Token for ${resolvedEmail} expired. Use /login to re-authenticate.`,
        previousAccount: registry.activeAccountEmail,
        newAccount: null,
      };
    }

    if (registry.activeAccountEmail === resolvedEmail) {
      return {
        success: true,
        message: `${resolvedEmail} is already the active account.`,
        previousAccount: resolvedEmail,
        newAccount: resolvedEmail,
      };
    }

    const previousAccount = registry.activeAccountEmail;

    try {
      const currentKeychainData = this.readFromKeychain();
      const newKeychainData = {
        ...currentKeychainData,
        claudeAiOauth: {
          ...currentKeychainData.claudeAiOauth,
          accessToken: account.cachedOAuth.accessToken,
        },
      };
      this.writeToKeychain(newKeychainData);
    } catch (err) {
      return {
        success: false,
        message: `Failed to write Keychain: ${err instanceof Error ? err.message : String(err)}`,
        previousAccount,
        newAccount: null,
      };
    }

    try {
      registry.activeAccountEmail = resolvedEmail;
      registry.lastUpdated = new Date().toISOString();
      this.saveRegistry(registry);
    } catch (err) {
      console.error('[AccountSwitcher] Failed to update registry:', err);
    }

    const name = account.name || resolvedEmail;
    return {
      success: true,
      message: `Switched to ${name} (${resolvedEmail}). New sessions will use this account.`,
      previousAccount,
      newAccount: resolvedEmail,
    };
  }

  /**
   * Get status of all accounts.
   */
  getAccountStatuses(): Array<{
    email: string;
    name: string | null;
    isActive: boolean;
    hasToken: boolean;
    tokenExpired: boolean;
    isStale: boolean;
    weeklyPercent: number;
    fiveHourPercent: number | null;
  }> {
    const registry = this.loadRegistry();
    if (!registry) return [];

    return Object.values(registry.accounts).map(account => {
      const hasToken = !!account.cachedOAuth?.accessToken;
      const tokenExpired = hasToken && account.cachedOAuth!.expiresAt < Date.now();
      return {
        email: account.email,
        name: account.name,
        isActive: account.email === registry.activeAccountEmail,
        hasToken,
        tokenExpired,
        isStale: !!account.staleSince,
        weeklyPercent: account.lastQuotaSnapshot?.percentUsed ?? 0,
        fiveHourPercent: account.lastQuotaSnapshot?.fiveHourUtilization ?? null,
      };
    });
  }

  private resolveAccount(target: string, registry: AccountRegistry): string | null {
    const lower = target.toLowerCase().trim();

    if (registry.accounts[lower]) return lower;

    for (const email of Object.keys(registry.accounts)) {
      if (email.toLowerCase() === lower) return email;
    }

    for (const email of Object.keys(registry.accounts)) {
      const prefix = email.split('@')[0].toLowerCase();
      if (prefix === lower) return email;
    }

    for (const [email, account] of Object.entries(registry.accounts)) {
      if (account.name && account.name.toLowerCase().includes(lower)) {
        return email;
      }
    }

    return null;
  }

  private readFromKeychain(): any {
    const result = execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(result.trim());
  }

  private writeToKeychain(data: any): void {
    const jsonStr = JSON.stringify(data);
    const hexStr = Buffer.from(jsonStr).toString('hex');
    // Use execFileSync with stdin input instead of shell heredoc
    execFileSync('security', ['-i'], {
      input: `add-generic-password -U -a "${this.keychainAccount}" -s "${KEYCHAIN_SERVICE}" -X "${hexStr}"\n`,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  private loadRegistry(): AccountRegistry | null {
    try {
      if (!fs.existsSync(this.registryPath)) return null;
      return JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
    } catch {
      // @silent-fallback-ok — defensive registry loading
      return null;
    }
  }

  private saveRegistry(registry: AccountRegistry): void {
    fs.writeFileSync(this.registryPath, JSON.stringify(registry, null, 2), { mode: 0o600 });
  }
}
