/**
 * FileSystemAccess: Claude approximates workspace-write by default and
 * danger-full-access via --dangerously-skip-permissions.
 */

import type {
  FileSystemAccess,
  SandboxMode,
  FilesystemAccessOptions,
  FileSystemAccessSpec,
} from '../../../primitives/capability/fileSystemAccess.js';
import { CapabilityFlag } from '../../../capabilities.js';

class AnthropicHeadlessFileSystemAccess implements FileSystemAccess {
  readonly capability = CapabilityFlag.FileSystemAccess;

  buildSpec(mode: SandboxMode, options?: FilesystemAccessOptions): FileSystemAccessSpec {
    return { __brand: 'FileSystemAccessSpec', mode, options } as FileSystemAccessSpec;
  }

  supportedModes(): ReadonlySet<SandboxMode> {
    return new Set<SandboxMode>(['workspace-write', 'danger-full-access']);
  }
}

export function createFileSystemAccess(): FileSystemAccess {
  return new AnthropicHeadlessFileSystemAccess();
}
