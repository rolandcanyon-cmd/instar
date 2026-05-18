/**
 * ToolAllowlist: build portable allowlist specs. Translation to Claude's
 * --allowed-tools flag happens at session-start time.
 */

import type {
  ToolAllowlist,
  ToolAllowlistRules,
  ToolAllowlistSpec,
} from '../../../primitives/capability/toolAllowlist.js';
import { CapabilityFlag } from '../../../capabilities.js';

class AnthropicHeadlessToolAllowlist implements ToolAllowlist {
  readonly capability = CapabilityFlag.ToolAllowlist;
  buildSpec(rules: ToolAllowlistRules): ToolAllowlistSpec {
    return { __brand: 'ToolAllowlistSpec', rules } as ToolAllowlistSpec;
  }
}

export function createToolAllowlist(): ToolAllowlist {
  return new AnthropicHeadlessToolAllowlist();
}
