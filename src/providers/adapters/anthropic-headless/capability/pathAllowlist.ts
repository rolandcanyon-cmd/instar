/**
 * PathAllowlist: Claude has --add-dir (additive allow) but no native deny.
 */

import type {
  PathAllowlist,
  PathAllowlistRules,
  PathAllowlistSpec,
} from '../../../primitives/capability/pathAllowlist.js';
import { CapabilityFlag } from '../../../capabilities.js';

class AnthropicHeadlessPathAllowlist implements PathAllowlist {
  readonly capability = CapabilityFlag.PathAllowlist;
  buildSpec(rules: PathAllowlistRules): PathAllowlistSpec {
    return { __brand: 'PathAllowlistSpec', rules } as PathAllowlistSpec;
  }
  supportsDenyRules(): boolean {
    return false;
  }
}

export function createPathAllowlist(): PathAllowlist {
  return new AnthropicHeadlessPathAllowlist();
}
