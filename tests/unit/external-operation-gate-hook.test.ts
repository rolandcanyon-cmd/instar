/**
 * Unit test — External Operation Gate PreToolUse hook logic.
 *
 * Tests the classification logic that the hook applies to MCP tool names
 * to determine mutability, reversibility, and item count.
 *
 * The hook itself is a shell script read from stdin, so we test the
 * classification logic directly rather than the hook execution.
 */

import { describe, it, expect } from 'vitest';

// Classification logic extracted from the hook (mirrors what the hook does)
function classifyMcpTool(toolName: string, toolInput: Record<string, unknown> = {}): {
  service: string;
  action: string;
  mutability: string;
  reversibility: string;
  itemCount: number;
  description: string;
} | null {
  if (!toolName.startsWith('mcp__')) return null;

  const parts = toolName.split('__');
  if (parts.length < 3) return null;

  const service = parts[1];
  const action = parts.slice(2).join('_');

  // Classify mutability from action name
  let mutability = 'read';
  if (/^(delete|remove|trash|purge|destroy|drop|clear)/.test(action)) {
    mutability = 'delete';
  } else if (/^(send|create|post|write|add|insert|new|compose|publish)/.test(action)) {
    mutability = 'write';
  } else if (/^(update|modify|edit|patch|rename|move|change|set|toggle|enable|disable)/.test(action)) {
    mutability = 'modify';
  }

  // Classify reversibility
  let reversibility = 'reversible';
  if (/^(send|publish|post|destroy|purge|drop)/.test(action)) {
    reversibility = 'irreversible';
  } else if (/^(delete|remove|trash)/.test(action)) {
    reversibility = 'partially-reversible';
  }

  // Estimate item count
  let itemCount = 1;
  for (const key of Object.keys(toolInput)) {
    const val = toolInput[key];
    if (Array.isArray(val)) {
      itemCount = Math.max(itemCount, val.length);
    }
  }

  const description = action.replace(/_/g, ' ') + ' on ' + service;

  return { service, action, mutability, reversibility, itemCount, description };
}

describe('MCP tool classification for gate hook', () => {
  describe('Tool name parsing', () => {
    it('parses standard MCP tool names', () => {
      const result = classifyMcpTool('mcp__gmail__send_email');
      expect(result).not.toBeNull();
      expect(result!.service).toBe('gmail');
      expect(result!.action).toBe('send_email');
    });

    it('returns null for non-MCP tools', () => {
      expect(classifyMcpTool('Bash')).toBeNull();
      expect(classifyMcpTool('Edit')).toBeNull();
      expect(classifyMcpTool('Read')).toBeNull();
    });

    it('returns null for malformed MCP tool names', () => {
      expect(classifyMcpTool('mcp__gmail')).toBeNull(); // Missing action
    });

    it('handles nested action names', () => {
      const result = classifyMcpTool('mcp__calendar__create_recurring_event');
      expect(result!.action).toBe('create_recurring_event');
    });
  });

  describe('Mutability classification', () => {
    it('classifies read operations', () => {
      expect(classifyMcpTool('mcp__gmail__get_email')!.mutability).toBe('read');
      expect(classifyMcpTool('mcp__gmail__list_emails')!.mutability).toBe('read');
      expect(classifyMcpTool('mcp__gmail__search_inbox')!.mutability).toBe('read');
      expect(classifyMcpTool('mcp__gmail__fetch_threads')!.mutability).toBe('read');
      expect(classifyMcpTool('mcp__calendar__check_availability')!.mutability).toBe('read');
    });

    it('classifies write operations', () => {
      expect(classifyMcpTool('mcp__gmail__send_email')!.mutability).toBe('write');
      expect(classifyMcpTool('mcp__gmail__create_draft')!.mutability).toBe('write');
      expect(classifyMcpTool('mcp__calendar__create_event')!.mutability).toBe('write');
      expect(classifyMcpTool('mcp__slack__post_message')!.mutability).toBe('write');
      expect(classifyMcpTool('mcp__drive__add_file')!.mutability).toBe('write');
      expect(classifyMcpTool('mcp__twitter__compose_tweet')!.mutability).toBe('write');
      expect(classifyMcpTool('mcp__blog__publish_post')!.mutability).toBe('write');
    });

    it('classifies modify operations', () => {
      expect(classifyMcpTool('mcp__gmail__update_label')!.mutability).toBe('modify');
      expect(classifyMcpTool('mcp__gmail__modify_thread')!.mutability).toBe('modify');
      expect(classifyMcpTool('mcp__calendar__edit_event')!.mutability).toBe('modify');
      expect(classifyMcpTool('mcp__drive__rename_file')!.mutability).toBe('modify');
      expect(classifyMcpTool('mcp__settings__toggle_feature')!.mutability).toBe('modify');
    });

    it('classifies delete operations', () => {
      expect(classifyMcpTool('mcp__gmail__delete_email')!.mutability).toBe('delete');
      expect(classifyMcpTool('mcp__gmail__remove_label')!.mutability).toBe('delete');
      expect(classifyMcpTool('mcp__gmail__trash_thread')!.mutability).toBe('delete');
      expect(classifyMcpTool('mcp__drive__purge_files')!.mutability).toBe('delete');
      expect(classifyMcpTool('mcp__db__drop_table')!.mutability).toBe('delete');
      expect(classifyMcpTool('mcp__cache__clear_all')!.mutability).toBe('delete');
    });
  });

  describe('Reversibility classification', () => {
    it('marks send/publish as irreversible', () => {
      expect(classifyMcpTool('mcp__gmail__send_email')!.reversibility).toBe('irreversible');
      expect(classifyMcpTool('mcp__blog__publish_post')!.reversibility).toBe('irreversible');
      expect(classifyMcpTool('mcp__slack__post_message')!.reversibility).toBe('irreversible');
      expect(classifyMcpTool('mcp__drive__destroy_permanently')!.reversibility).toBe('irreversible');
    });

    it('marks delete/remove/trash as partially-reversible', () => {
      expect(classifyMcpTool('mcp__gmail__delete_email')!.reversibility).toBe('partially-reversible');
      expect(classifyMcpTool('mcp__gmail__remove_label')!.reversibility).toBe('partially-reversible');
      expect(classifyMcpTool('mcp__gmail__trash_thread')!.reversibility).toBe('partially-reversible');
    });

    it('marks other operations as reversible', () => {
      expect(classifyMcpTool('mcp__gmail__get_email')!.reversibility).toBe('reversible');
      expect(classifyMcpTool('mcp__gmail__create_draft')!.reversibility).toBe('reversible');
      expect(classifyMcpTool('mcp__calendar__update_event')!.reversibility).toBe('reversible');
    });
  });

  describe('Item count estimation', () => {
    it('defaults to 1 for non-array inputs', () => {
      const result = classifyMcpTool('mcp__gmail__send_email', {
        to: 'user@example.com',
        subject: 'Hello',
      });
      expect(result!.itemCount).toBe(1);
    });

    it('detects batch operations from array inputs', () => {
      const result = classifyMcpTool('mcp__gmail__delete_email', {
        messageIds: ['id1', 'id2', 'id3', 'id4', 'id5'],
      });
      expect(result!.itemCount).toBe(5);
    });

    it('uses max array length for multiple arrays', () => {
      const result = classifyMcpTool('mcp__gmail__modify_thread', {
        threadIds: ['t1', 't2', 't3'],
        labels: ['label1', 'label2'],
      });
      expect(result!.itemCount).toBe(3);
    });
  });

  describe('Description generation', () => {
    it('generates human-readable description', () => {
      const result = classifyMcpTool('mcp__gmail__send_email');
      expect(result!.description).toBe('send email on gmail');
    });

    it('replaces underscores with spaces', () => {
      const result = classifyMcpTool('mcp__calendar__create_recurring_event');
      expect(result!.description).toBe('create recurring event on calendar');
    });
  });
});
