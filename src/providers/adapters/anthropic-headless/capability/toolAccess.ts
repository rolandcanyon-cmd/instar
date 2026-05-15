/**
 * ToolAccess: Claude's built-in tool inventory.
 */

import type {
  ToolAccess,
  ToolKind,
  RegisteredTool,
} from '../../../primitives/capability/toolAccess.js';
import { CapabilityFlag } from '../../../capabilities.js';

const CLAUDE_TOOLS: RegisteredTool[] = [
  { name: 'Read', kind: 'file-read', enabledByDefault: true, requiresApproval: false },
  { name: 'Write', kind: 'file-write', enabledByDefault: true, requiresApproval: true },
  { name: 'Edit', kind: 'file-edit', enabledByDefault: true, requiresApproval: true },
  { name: 'Bash', kind: 'bash', enabledByDefault: true, requiresApproval: true },
  { name: 'WebFetch', kind: 'web-fetch', enabledByDefault: true, requiresApproval: false },
  { name: 'WebSearch', kind: 'web-search', enabledByDefault: true, requiresApproval: false },
  { name: 'Task', kind: 'subagent-spawn', enabledByDefault: true, requiresApproval: false },
];

const CLAUDE_KINDS: ReadonlySet<ToolKind> = new Set([
  'file-read',
  'file-write',
  'file-edit',
  'bash',
  'web-fetch',
  'web-search',
  'subagent-spawn',
  'mcp',
]);

class AnthropicHeadlessToolAccess implements ToolAccess {
  readonly capability = CapabilityFlag.ToolAccess;

  supportedToolKinds(): ReadonlySet<ToolKind> {
    return CLAUDE_KINDS;
  }

  registeredTools(): ReadonlyArray<RegisteredTool> {
    return CLAUDE_TOOLS;
  }
}

export function createToolAccess(): ToolAccess {
  return new AnthropicHeadlessToolAccess();
}
