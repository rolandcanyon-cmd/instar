/**
 * FileSystemAccess implementation for openai-codex.
 *
 * Codex supports all three sandbox tiers natively: `read-only`,
 * `workspace-write`, `danger-full-access` (via `--sandbox <mode>` flag or
 * `sandbox_mode` in config.toml). This is the cleanest of all providers.
 */

import type {
  FileSystemAccess,
  FileSystemAccessSpec,
  FilesystemAccessOptions,
  SandboxMode,
} from '../../../primitives/capability/fileSystemAccess.js';
import { CapabilityFlag } from '../../../capabilities.js';

const SUPPORTED: ReadonlySet<SandboxMode> = new Set<SandboxMode>([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);

class OpenAiCodexFileSystemAccess implements FileSystemAccess {
  readonly capability = CapabilityFlag.FileSystemAccess;
  buildSpec(mode: SandboxMode, options?: FilesystemAccessOptions): FileSystemAccessSpec {
    return Object.freeze({ __brand: 'FileSystemAccessSpec', mode, options }) as FileSystemAccessSpec;
  }
  supportedModes(): ReadonlySet<SandboxMode> { return SUPPORTED; }
}

export function createFileSystemAccess(): FileSystemAccess { return new OpenAiCodexFileSystemAccess(); }
