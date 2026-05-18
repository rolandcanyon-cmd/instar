/**
 * BashExecution implementation for openai-codex.
 *
 * Codex supports two execution tiers: sandboxed via `command/exec` (the
 * default) and unsandboxed via `process/spawn` (experimental). The
 * provider distinguishes both — supportsSandboxModes returns true.
 */

import type {
  BashExecution,
  BashExecutionRules,
  BashExecutionSpec,
} from '../../../primitives/capability/bashExecution.js';
import { CapabilityFlag } from '../../../capabilities.js';

class OpenAiCodexBashExecution implements BashExecution {
  readonly capability = CapabilityFlag.BashExecution;
  buildSpec(rules: BashExecutionRules): BashExecutionSpec {
    return Object.freeze({ __brand: 'BashExecutionSpec', rules }) as BashExecutionSpec;
  }
  supportsSandboxModes(): boolean { return true; }
}

export function createBashExecution(): BashExecution { return new OpenAiCodexBashExecution(); }
