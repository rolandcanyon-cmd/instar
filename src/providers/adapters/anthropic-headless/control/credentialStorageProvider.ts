/**
 * CredentialStorageProvider: macOS Keychain + ~/.claude config fallback.
 *
 * Phase 3a: file-backed only (defers Keychain wrapper to future work).
 * The file is JSON at ~/.instar/anthropic-credentials.json with one entry
 * per account label, 0600 permissions.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  CredentialStorageProvider,
  CredentialBackend,
} from '../../../primitives/control/credentialStorageProvider.js';
import type { ProviderCredential } from '../../../primitives/control/authCredentialInjection.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { UnsupportedCapabilityError } from '../../../errors.js';
import { ANTHROPIC_HEADLESS_ID } from '../errors.js';

interface CredentialFile {
  active: string | null;
  accounts: Record<string, ProviderCredential>;
}

const FILE_PATH = path.join(homedir(), '.instar', 'anthropic-credentials.json');

async function readFile(): Promise<CredentialFile> {
  try {
    const raw = await fs.readFile(FILE_PATH, 'utf-8');
    return JSON.parse(raw) as CredentialFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { active: null, accounts: {} };
    }
    throw err;
  }
}

async function writeFile(file: CredentialFile): Promise<void> {
  await fs.mkdir(path.dirname(FILE_PATH), { recursive: true });
  await fs.writeFile(FILE_PATH, JSON.stringify(file, null, 2), { mode: 0o600 });
}

class AnthropicHeadlessCredentialStorage implements CredentialStorageProvider {
  readonly capability = CapabilityFlag.CredentialStorageProvider;

  getBackend(): CredentialBackend {
    return 'file';
  }

  async setBackend(backend: CredentialBackend): Promise<void> {
    if (backend !== 'file') {
      throw new UnsupportedCapabilityError(
        `anthropic-headless adapter currently supports only 'file' backend (got '${backend}')`,
        ANTHROPIC_HEADLESS_ID,
      );
    }
  }

  async listAccounts(): Promise<ReadonlyArray<string>> {
    const file = await readFile();
    return Object.keys(file.accounts);
  }

  async get(accountLabel: string): Promise<ProviderCredential | null> {
    const file = await readFile();
    return file.accounts[accountLabel] ?? null;
  }

  async set(accountLabel: string, credential: ProviderCredential): Promise<void> {
    const file = await readFile();
    file.accounts[accountLabel] = credential;
    if (!file.active) file.active = accountLabel;
    await writeFile(file);
  }

  async remove(accountLabel: string): Promise<void> {
    const file = await readFile();
    delete file.accounts[accountLabel];
    if (file.active === accountLabel) {
      const remaining = Object.keys(file.accounts);
      file.active = remaining[0] ?? null;
    }
    await writeFile(file);
  }

  async getActiveAccount(): Promise<string | null> {
    const file = await readFile();
    return file.active;
  }

  async setActiveAccount(accountLabel: string): Promise<void> {
    const file = await readFile();
    if (!(accountLabel in file.accounts)) {
      throw new Error(`Unknown account: ${accountLabel}`);
    }
    file.active = accountLabel;
    await writeFile(file);
  }
}

export function createCredentialStorageProvider(): CredentialStorageProvider {
  return new AnthropicHeadlessCredentialStorage();
}
