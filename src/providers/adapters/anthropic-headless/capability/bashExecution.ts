/**
 * BashExecution: Claude has one mode (the built-in Bash tool with sandbox
 * approval gates). No separate sandboxed/unsandboxed distinction.
 */

import type {
  BashExecution,
  BashExecutionRules,
  BashExecutionSpec,
} from '../../../primitives/capability/bashExecution.js';
import { CapabilityFlag } from '../../../capabilities.js';

class AnthropicHeadlessBashExecution implements BashExecution {
  readonly capability = CapabilityFlag.BashExecution;
  buildSpec(rules: BashExecutionRules): BashExecutionSpec {
    return { __brand: 'BashExecutionSpec', rules } as BashExecutionSpec;
  }
  supportsSandboxModes(): boolean {
    return false;
  }
}

export function createBashExecution(): BashExecution {
  return new AnthropicHeadlessBashExecution();
}
