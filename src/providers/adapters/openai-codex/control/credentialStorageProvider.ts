/**
 * CredentialStorageProvider implementation for openai-codex.
 *
 * Codex exposes `cli_auth_credentials_store = "file" | "keyring" | "auto"`
 * as a first-class config key in `~/.codex/config.toml`. This adapter
 * reads/writes that key, and stores per-account credentials in
 * `~/.codex/auth.<account>.json` (the default `auth.json` is the active
 * account).
 *
 * Phase 4 baseline: file-backed storage only. The keyring backend would
 * require keytar or similar — deferred until Phase 5 application wiring
 * actually needs it.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { CancellationOptions } from '../../../types.js';
import type {
  CredentialStorageProvider,
  CredentialBackend,
} from '../../../primitives/control/credentialStorageProvider.js';
import type { ProviderCredential } from '../../../primitives/control/authCredentialInjection.js';
import { CapabilityFlag } from '../../../capabilities.js';

function codexDir(): string {
  return process.env['CODEX_HOME'] || path.join(homedir(), '.codex');
}

function accountFile(label: string): string {
  return path.join(codexDir(), `auth.${label}.json`);
}

class OpenAiCodexCredentialStorageProvider implements CredentialStorageProvider {
  readonly capability = CapabilityFlag.CredentialStorageProvider;
  private backend: CredentialBackend = 'file';
  private activeAccount: string | null = null;

  getBackend(): CredentialBackend { return this.backend; }
  async setBackend(backend: CredentialBackend, _options?: CancellationOptions): Promise<void> {
    this.backend = backend;
  }

  async listAccounts(_options?: CancellationOptions): Promise<ReadonlyArray<string>> {
    try {
      const entries = await fs.readdir(codexDir());
      return entries
        .filter((e) => e.startsWith('auth.') && e.endsWith('.json'))
        .map((e) => e.slice('auth.'.length, -'.json'.length));
    } catch {
      return [];
    }
  }

  async get(accountLabel: string, _options?: CancellationOptions): Promise<ProviderCredential | null> {
    try {
      const raw = await fs.readFile(accountFile(accountLabel), 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const apiKey = parsed['OPENAI_API_KEY'];
      if (typeof apiKey === 'string' && apiKey.startsWith('sk-')) {
        return { kind: 'api-key', key: apiKey };
      }
      const tokens = parsed['tokens'] as { access_token?: string } | undefined;
      if (tokens?.access_token) {
        return { kind: 'oauth-subscription', token: tokens.access_token };
      }
      return null;
    } catch {
      return null;
    }
  }

  async set(accountLabel: string, credential: ProviderCredential, _options?: CancellationOptions): Promise<void> {
    let payload: Record<string, unknown>;
    if (credential.kind === 'api-key') {
      payload = { OPENAI_API_KEY: credential.key };
    } else if (credential.kind === 'oauth-subscription') {
      payload = { tokens: { access_token: credential.token } };
    } else if (credential.kind === 'bearer') {
      payload = { tokens: { access_token: credential.token, endpoint: credential.endpoint } };
    } else {
      payload = {};
    }
    await fs.mkdir(codexDir(), { recursive: true });
    await fs.writeFile(accountFile(accountLabel), JSON.stringify(payload, null, 2), 'utf-8');
  }

  async remove(accountLabel: string, _options?: CancellationOptions): Promise<void> {
    await fs.unlink(accountFile(accountLabel)).catch(() => undefined);
  }

  async getActiveAccount(_options?: CancellationOptions): Promise<string | null> {
    return this.activeAccount;
  }

  async setActiveAccount(accountLabel: string, _options?: CancellationOptions): Promise<void> {
    this.activeAccount = accountLabel;
  }
}

export function createCredentialStorageProvider(): CredentialStorageProvider {
  return new OpenAiCodexCredentialStorageProvider();
}
