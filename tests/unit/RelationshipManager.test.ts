import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelationshipManager } from '../../src/core/RelationshipManager.js';
import type { RelationshipManagerConfig, UserChannel } from '../../src/core/types.js';

describe('RelationshipManager', () => {
  let tmpDir: string;
  let config: RelationshipManagerConfig;
  let manager: RelationshipManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kit-rel-test-'));
    config = {
      relationshipsDir: path.join(tmpDir, 'relationships'),
      maxRecentInteractions: 20,
    };
    manager = new RelationshipManager(config);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('findOrCreate', () => {
    it('creates a new relationship', () => {
      const channel: UserChannel = { type: 'telegram', identifier: '12345' };
      const record = manager.findOrCreate('Alice', channel);

      expect(record.name).toBe('Alice');
      expect(record.id).toBeTruthy();
      expect(record.channels).toHaveLength(1);
      expect(record.channels[0]).toEqual(channel);
      expect(record.interactionCount).toBe(0);
      expect(record.significance).toBe(1);
    });

    it('returns existing relationship for same channel', () => {
      const channel: UserChannel = { type: 'telegram', identifier: '12345' };
      const first = manager.findOrCreate('Alice', channel);
      const second = manager.findOrCreate('Alice', channel);

      expect(first.id).toBe(second.id);
    });

    it('creates separate relationships for different channels', () => {
      const ch1: UserChannel = { type: 'telegram', identifier: '111' };
      const ch2: UserChannel = { type: 'email', identifier: 'bob@test.com' };

      const r1 = manager.findOrCreate('Alice', ch1);
      const r2 = manager.findOrCreate('Bob', ch2);

      expect(r1.id).not.toBe(r2.id);
    });

    it('persists to disk', () => {
      const channel: UserChannel = { type: 'telegram', identifier: '12345' };
      const record = manager.findOrCreate('Alice', channel);

      const filePath = path.join(config.relationshipsDir, `${record.id}.json`);
      expect(fs.existsSync(filePath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data.name).toBe('Alice');
    });

    it('survives reload from disk', () => {
      const channel: UserChannel = { type: 'telegram', identifier: '12345' };
      const original = manager.findOrCreate('Alice', channel);

      // Create a new manager pointing at the same dir
      const manager2 = new RelationshipManager(config);
      const loaded = manager2.resolveByChannel(channel);

      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(original.id);
      expect(loaded!.name).toBe('Alice');
    });
  });

  describe('resolveByChannel', () => {
    it('returns null for unknown channel', () => {
      const result = manager.resolveByChannel({ type: 'telegram', identifier: '99999' });
      expect(result).toBeNull();
    });

    it('resolves known channel', () => {
      const channel: UserChannel = { type: 'email', identifier: 'test@example.com' };
      const created = manager.findOrCreate('Test User', channel);
      const resolved = manager.resolveByChannel(channel);

      expect(resolved).not.toBeNull();
      expect(resolved!.id).toBe(created.id);
    });
  });

  describe('recordInteraction', () => {
    it('increments interaction count and updates recency', () => {
      const channel: UserChannel = { type: 'telegram', identifier: '12345' };
      const record = manager.findOrCreate('Alice', channel);

      manager.recordInteraction(record.id, {
        timestamp: new Date().toISOString(),
        channel: 'telegram',
        summary: 'Discussed project setup',
        topics: ['onboarding', 'architecture'],
      });

      const updated = manager.get(record.id)!;
      expect(updated.interactionCount).toBe(1);
      expect(updated.recentInteractions).toHaveLength(1);
      expect(updated.themes).toContain('onboarding');
      expect(updated.themes).toContain('architecture');
    });

    it('caps recent interactions at max', () => {
      const channel: UserChannel = { type: 'telegram', identifier: '12345' };
      const record = manager.findOrCreate('Alice', channel);

      // Record more than maxRecentInteractions
      for (let i = 0; i < 25; i++) {
        manager.recordInteraction(record.id, {
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          channel: 'telegram',
          summary: `Interaction ${i}`,
        });
      }

      const updated = manager.get(record.id)!;
      expect(updated.recentInteractions.length).toBeLessThanOrEqual(config.maxRecentInteractions);
      expect(updated.interactionCount).toBe(25);
    });

    it('ignores unknown relationship id', () => {
      // Should not throw
      manager.recordInteraction('nonexistent-id', {
        timestamp: new Date().toISOString(),
        channel: 'telegram',
        summary: 'Should be ignored',
      });
    });

    it('auto-derives significance from interactions', () => {
      const channel: UserChannel = { type: 'telegram', identifier: '12345' };
      const record = manager.findOrCreate('Alice', channel);

      // Record many interactions with varied topics
      for (let i = 0; i < 20; i++) {
        manager.recordInteraction(record.id, {
          timestamp: new Date().toISOString(),
          channel: 'telegram',
          summary: `Discussion ${i}`,
          topics: [`topic-${i}`],
        });
      }

      const updated = manager.get(record.id)!;
      // 20 interactions (3pts) + recent (3pts) + 20 themes (3pts) = 9
      expect(updated.significance).toBeGreaterThanOrEqual(7);
    });
  });

  describe('updateNotes', () => {
    it('updates notes on a relationship', () => {
      const channel: UserChannel = { type: 'telegram', identifier: '12345' };
      const record = manager.findOrCreate('Alice', channel);

      manager.updateNotes(record.id, 'Very thoughtful conversationalist');
      const updated = manager.get(record.id)!;
      expect(updated.notes).toBe('Very thoughtful conversationalist');
    });
  });

  describe('updateArcSummary', () => {
    it('updates arc summary on a relationship', () => {
      const channel: UserChannel = { type: 'telegram', identifier: '12345' };
      const record = manager.findOrCreate('Alice', channel);

      manager.updateArcSummary(record.id, 'Started as curious user, became collaborator');
      const updated = manager.get(record.id)!;
      expect(updated.arcSummary).toBe('Started as curious user, became collaborator');
    });
  });

  describe('linkChannel', () => {
    it('adds a new channel to an existing relationship', () => {
      const ch1: UserChannel = { type: 'telegram', identifier: '12345' };
      const record = manager.findOrCreate('Alice', ch1);

      const ch2: UserChannel = { type: 'email', identifier: 'alice@example.com' };
      manager.linkChannel(record.id, ch2);

      const updated = manager.get(record.id)!;
      expect(updated.channels).toHaveLength(2);

      // Should be resolvable by either channel
      expect(manager.resolveByChannel(ch1)!.id).toBe(record.id);
      expect(manager.resolveByChannel(ch2)!.id).toBe(record.id);
    });

    it('does not duplicate existing channels', () => {
      const channel: UserChannel = { type: 'telegram', identifier: '12345' };
      const record = manager.findOrCreate('Alice', channel);

      manager.linkChannel(record.id, channel);
      const updated = manager.get(record.id)!;
      expect(updated.channels).toHaveLength(1);
    });
  });

  describe('mergeRelationships', () => {
    it('merges two relationship records', () => {
      const ch1: UserChannel = { type: 'telegram', identifier: '111' };
      const ch2: UserChannel = { type: 'email', identifier: 'alice@test.com' };

      const r1 = manager.findOrCreate('Alice (Telegram)', ch1);
      const r2 = manager.findOrCreate('Alice (Email)', ch2);

      // Add interactions to both
      manager.recordInteraction(r1.id, {
        timestamp: new Date(Date.now() - 10000).toISOString(),
        channel: 'telegram',
        summary: 'Chat on Telegram',
        topics: ['ai'],
      });
      manager.recordInteraction(r2.id, {
        timestamp: new Date().toISOString(),
        channel: 'email',
        summary: 'Email exchange',
        topics: ['philosophy'],
      });

      // Merge r2 into r1
      manager.mergeRelationships(r1.id, r2.id);

      const merged = manager.get(r1.id)!;
      expect(merged.channels).toHaveLength(2);
      expect(merged.interactionCount).toBe(2);
      expect(merged.themes).toContain('ai');
      expect(merged.themes).toContain('philosophy');

      // r2 should be gone
      expect(manager.get(r2.id)).toBeNull();

      // Both channels should resolve to r1
      expect(manager.resolveByChannel(ch1)!.id).toBe(r1.id);
      expect(manager.resolveByChannel(ch2)!.id).toBe(r1.id);
    });
  });

  describe('getContextForPerson', () => {
    it('returns null for unknown id', () => {
      expect(manager.getContextForPerson('nonexistent')).toBeNull();
    });

    it('generates XML context block', () => {
      const channel: UserChannel = { type: 'telegram', identifier: '12345' };
      const record = manager.findOrCreate('Alice', channel);
      manager.updateNotes(record.id, 'Test note');

      manager.recordInteraction(record.id, {
        timestamp: new Date().toISOString(),
        channel: 'telegram',
        summary: 'Discussed testing',
        topics: ['testing'],
      });

      const context = manager.getContextForPerson(record.id)!;
      expect(context).toContain('<relationship_context person="Alice">');
      expect(context).toContain('</relationship_context>');
      expect(context).toContain('Name: Alice');
      expect(context).toContain('Key themes: testing');
      expect(context).toContain('Notes: Test note');
      expect(context).toContain('Discussed testing');
    });
  });

  describe('getAll', () => {
    it('returns empty array when no relationships', () => {
      expect(manager.getAll()).toEqual([]);
    });

    it('sorts by significance by default', () => {
      const ch1: UserChannel = { type: 'telegram', identifier: '111' };
      const ch2: UserChannel = { type: 'telegram', identifier: '222' };

      const r1 = manager.findOrCreate('Low', ch1);
      const r2 = manager.findOrCreate('High', ch2);

      // Give r2 more interactions to boost significance
      for (let i = 0; i < 10; i++) {
        manager.recordInteraction(r2.id, {
          timestamp: new Date().toISOString(),
          channel: 'telegram',
          summary: `Discussion ${i}`,
          topics: [`topic-${i}`],
        });
      }

      const all = manager.getAll();
      expect(all[0].id).toBe(r2.id);
    });

    it('sorts by name when requested', () => {
      manager.findOrCreate('Charlie', { type: 'telegram', identifier: '3' });
      manager.findOrCreate('Alice', { type: 'telegram', identifier: '1' });
      manager.findOrCreate('Bob', { type: 'telegram', identifier: '2' });

      const byName = manager.getAll('name');
      expect(byName.map(r => r.name)).toEqual(['Alice', 'Bob', 'Charlie']);
    });
  });

  describe('getStaleRelationships', () => {
    it('finds relationships older than threshold with sufficient significance', () => {
      const channel: UserChannel = { type: 'telegram', identifier: '12345' };
      const record = manager.findOrCreate('Alice', channel);

      // Manually boost significance and set old last interaction
      for (let i = 0; i < 6; i++) {
        manager.recordInteraction(record.id, {
          timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
          channel: 'telegram',
          summary: `Old discussion ${i}`,
          topics: [`topic-${i}`],
        });
      }

      const stale = manager.getStaleRelationships(14);
      expect(stale.length).toBeGreaterThanOrEqual(1);
      expect(stale[0].id).toBe(record.id);
    });

    it('excludes low-significance relationships', () => {
      const channel: UserChannel = { type: 'telegram', identifier: '12345' };
      manager.findOrCreate('Stranger', channel);
      // No interactions → significance stays at 1

      const stale = manager.getStaleRelationships(0); // Any age
      // Significance < 3 should be excluded
      expect(stale).toHaveLength(0);
    });
  });
});
