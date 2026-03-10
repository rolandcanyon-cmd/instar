import { describe, it, expect, beforeEach } from 'vitest';
import { PresenceRegistry } from '../../../../src/threadline/relay/PresenceRegistry.js';

describe('PresenceRegistry', () => {
  let registry: PresenceRegistry;

  beforeEach(() => {
    registry = new PresenceRegistry({ maxAgents: 100 });
  });

  const makeMetadata = (name: string) => ({
    name,
    framework: 'instar',
    capabilities: ['conversation'],
    version: '1.0.0',
  });

  describe('register', () => {
    it('registers a new agent', () => {
      const result = registry.register('agent-1', 'pubkey1', makeMetadata('Agent 1'), 'public', 'session-1');
      expect(result).toBeNull(); // no previous entry
      expect(registry.size).toBe(1);
    });

    it('returns previous entry on re-registration (displacement)', () => {
      registry.register('agent-1', 'pubkey1', makeMetadata('Agent 1'), 'public', 'session-1');
      const prev = registry.register('agent-1', 'pubkey1', makeMetadata('Agent 1 v2'), 'public', 'session-2');
      expect(prev).not.toBeNull();
      expect(prev!.metadata.name).toBe('Agent 1');
      expect(registry.size).toBe(1);
    });

    it('throws when at capacity', () => {
      const reg = new PresenceRegistry({ maxAgents: 2 });
      reg.register('a1', 'k1', makeMetadata('A1'), 'public', 's1');
      reg.register('a2', 'k2', makeMetadata('A2'), 'public', 's2');
      expect(() => reg.register('a3', 'k3', makeMetadata('A3'), 'public', 's3'))
        .toThrow(/capacity/i);
    });

    it('does not throw when re-registering at capacity', () => {
      const reg = new PresenceRegistry({ maxAgents: 2 });
      reg.register('a1', 'k1', makeMetadata('A1'), 'public', 's1');
      reg.register('a2', 'k2', makeMetadata('A2'), 'public', 's2');
      expect(() => reg.register('a1', 'k1', makeMetadata('A1 v2'), 'public', 's3'))
        .not.toThrow();
    });
  });

  describe('unregister', () => {
    it('removes an agent', () => {
      registry.register('agent-1', 'pubkey1', makeMetadata('Agent 1'), 'public', 'session-1');
      const removed = registry.unregister('agent-1');
      expect(removed).not.toBeNull();
      expect(removed!.agentId).toBe('agent-1');
      expect(registry.size).toBe(0);
    });

    it('returns null for unknown agent', () => {
      expect(registry.unregister('nonexistent')).toBeNull();
    });

    it('cleans up subscriptions on unregister', () => {
      registry.register('a1', 'k1', makeMetadata('A1'), 'public', 's1');
      registry.register('a2', 'k2', makeMetadata('A2'), 'public', 's2');
      registry.subscribe('a2', ['a1']);
      registry.unregister('a2');
      const subs = registry.getSubscribers('a1');
      expect(subs).not.toContain('a2');
    });
  });

  describe('get and isOnline', () => {
    it('returns entry for registered agent', () => {
      registry.register('agent-1', 'pubkey1', makeMetadata('Agent 1'), 'public', 'session-1');
      const entry = registry.get('agent-1');
      expect(entry).not.toBeNull();
      expect(entry!.metadata.name).toBe('Agent 1');
      expect(entry!.status).toBe('online');
    });

    it('returns null for unregistered agent', () => {
      expect(registry.get('nonexistent')).toBeNull();
    });

    it('isOnline returns correct state', () => {
      registry.register('agent-1', 'pubkey1', makeMetadata('Agent 1'), 'public', 'session-1');
      expect(registry.isOnline('agent-1')).toBe(true);
      expect(registry.isOnline('nonexistent')).toBe(false);
    });
  });

  describe('touch', () => {
    it('updates lastSeen', async () => {
      registry.register('agent-1', 'pubkey1', makeMetadata('Agent 1'), 'public', 'session-1');
      const before = registry.get('agent-1')!.lastSeen;

      // Wait a bit to ensure different millisecond
      await new Promise(r => setTimeout(r, 10));
      registry.touch('agent-1');

      const after = registry.get('agent-1')!.lastSeen;
      expect(after).not.toBe(before);
    });
  });

  describe('discover', () => {
    beforeEach(() => {
      registry.register('a1', 'k1', {
        name: 'Dawn',
        framework: 'instar',
        capabilities: ['conversation', 'code-review'],
        version: '1.0.0',
      }, 'public', 's1');

      registry.register('a2', 'k2', {
        name: 'Helper',
        framework: 'openclaw',
        capabilities: ['conversation'],
        version: '2.0.0',
      }, 'public', 's2');

      registry.register('a3', 'k3', {
        name: 'Secret',
        framework: 'instar',
        capabilities: ['conversation'],
        version: '1.0.0',
      }, 'unlisted', 's3');

      registry.register('a4', 'k4', {
        name: 'Private',
        framework: 'instar',
        capabilities: ['conversation'],
        version: '1.0.0',
      }, 'private', 's4');
    });

    it('returns only public agents with no filter', () => {
      const results = registry.discover();
      expect(results).toHaveLength(2);
      expect(results.map(r => r.metadata.name).sort()).toEqual(['Dawn', 'Helper']);
    });

    it('filters by name', () => {
      const results = registry.discover({ name: 'Dawn' });
      expect(results).toHaveLength(1);
      expect(results[0].metadata.name).toBe('Dawn');
    });

    it('filters by framework', () => {
      const results = registry.discover({ framework: 'openclaw' });
      expect(results).toHaveLength(1);
      expect(results[0].metadata.name).toBe('Helper');
    });

    it('filters by capability', () => {
      const results = registry.discover({ capability: 'code-review' });
      expect(results).toHaveLength(1);
      expect(results[0].metadata.name).toBe('Dawn');
    });

    it('never returns unlisted agents', () => {
      const results = registry.discover({ name: 'Secret' });
      expect(results).toHaveLength(0);
    });

    it('never returns private agents', () => {
      const results = registry.discover({ name: 'Private' });
      expect(results).toHaveLength(0);
    });

    it('combined filters narrow results', () => {
      const results = registry.discover({ framework: 'instar', capability: 'code-review' });
      expect(results).toHaveLength(1);
      expect(results[0].metadata.name).toBe('Dawn');
    });

    it('returns empty for non-matching filter', () => {
      const results = registry.discover({ framework: 'nonexistent' });
      expect(results).toHaveLength(0);
    });
  });

  describe('subscriptions', () => {
    beforeEach(() => {
      registry.register('a1', 'k1', makeMetadata('A1'), 'public', 's1');
      registry.register('a2', 'k2', makeMetadata('A2'), 'public', 's2');
      registry.register('a3', 'k3', makeMetadata('A3'), 'public', 's3');
    });

    it('specific subscription notifies on target changes', () => {
      registry.subscribe('a2', ['a1']);
      const subs = registry.getSubscribers('a1');
      expect(subs).toContain('a2');
      expect(subs).not.toContain('a3');
    });

    it('wildcard subscription notifies on any change', () => {
      registry.subscribe('a3');
      const subsA1 = registry.getSubscribers('a1');
      const subsA2 = registry.getSubscribers('a2');
      expect(subsA1).toContain('a3');
      expect(subsA2).toContain('a3');
    });

    it('does not notify agent about its own changes', () => {
      registry.subscribe('a1', ['a1']);
      const subs = registry.getSubscribers('a1');
      expect(subs).not.toContain('a1');
    });

    it('handles multiple subscribers', () => {
      registry.subscribe('a2', ['a1']);
      registry.subscribe('a3', ['a1']);
      const subs = registry.getSubscribers('a1');
      expect(subs).toContain('a2');
      expect(subs).toContain('a3');
    });
  });

  describe('getAll', () => {
    it('returns all agents', () => {
      registry.register('a1', 'k1', makeMetadata('A1'), 'public', 's1');
      registry.register('a2', 'k2', makeMetadata('A2'), 'unlisted', 's2');
      const all = registry.getAll();
      expect(all).toHaveLength(2);
    });
  });
});
