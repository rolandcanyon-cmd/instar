/**
 * PathAllowlist implementation for openai-codex.
 *
 * Codex's `permissions.<name>.filesystem` named profiles are richer than
 * Claude's `--add-dir`. Codex supports explicit deny rules natively.
 */

import type {
  PathAllowlist,
  PathAllowlistRules,
  PathAllowlistSpec,
} from '../../../primitives/capability/pathAllowlist.js';
import { CapabilityFlag } from '../../../capabilities.js';

class OpenAiCodexPathAllowlist implements PathAllowlist {
  readonly capability = CapabilityFlag.PathAllowlist;
  buildSpec(rules: PathAllowlistRules): PathAllowlistSpec {
    return Object.freeze({ __brand: 'PathAllowlistSpec', rules }) as PathAllowlistSpec;
  }
  supportsDenyRules(): boolean { return true; }
}

export function createPathAllowlist(): PathAllowlist { return new OpenAiCodexPathAllowlist(); }
