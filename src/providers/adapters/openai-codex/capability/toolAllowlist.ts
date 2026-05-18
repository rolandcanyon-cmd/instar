/**
 * ToolAllowlist implementation for openai-codex.
 *
 * Codex enforces MCP server allowlists via `mcp_servers.<id>` config tables
 * with identity match (command path or URL), which is more strict than
 * Claude's name-only match. The buildSpec only constructs the portable
 * shape; the actual codex-side config-write happens in the session-start
 * primitives when they consume this spec.
 */

import type {
  ToolAllowlist,
  ToolAllowlistRules,
  ToolAllowlistSpec,
} from '../../../primitives/capability/toolAllowlist.js';
import { CapabilityFlag } from '../../../capabilities.js';

class OpenAiCodexToolAllowlist implements ToolAllowlist {
  readonly capability = CapabilityFlag.ToolAllowlist;
  buildSpec(rules: ToolAllowlistRules): ToolAllowlistSpec {
    return Object.freeze({ __brand: 'ToolAllowlistSpec', rules }) as ToolAllowlistSpec;
  }
}

export function createToolAllowlist(): ToolAllowlist { return new OpenAiCodexToolAllowlist(); }
