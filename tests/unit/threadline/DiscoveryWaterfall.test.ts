import { describe, it, expect, vi } from 'vitest';
import {
  DiscoveryWaterfall,
  type DiscoveryAdapter,
  type DiscoveredAgent,
} from '../../../src/threadline/DiscoveryWaterfall.js';

function makeAdapter(
  source: 'local' | 'relay' | 'moltbridge',
  agents: DiscoveredAgent[],
  available = true,
  delayMs = 0,
): DiscoveryAdapter {
  return {
    source,
    isAvailable: () => available,
    search: async () => {
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      return agents;
    },
  };
}

function makeAgent(fingerprint: string, source: 'local' | 'relay' | 'moltbridge'): DiscoveredAgent {
  return {
    fingerprint, capabilities: ['testing'], source, sourcePrecedence: 0,
  };
}

describe('DiscoveryWaterfall', () => {
  describe('basic waterfall', () => {
    it('returns agents from all stages', async () => {
      const waterfall = new DiscoveryWaterfall();
      waterfall.registerAdapter(makeAdapter('local', [makeAgent('aaa', 'local')]));
      waterfall.registerAdapter(makeAdapter('relay', [makeAgent('bbb', 'relay')]));

      const result = await waterfall.discover({ query: 'test' });
      expect(result.agents).toHaveLength(2);
      expect(result.stages.filter(s => s.status === 'success')).toHaveLength(2);
    });

    it('runs stages sequentially', async () => {
      const order: string[] = [];
      const waterfall = new DiscoveryWaterfall();

      waterfall.registerAdapter({
        source: 'local',
        isAvailable: () => true,
        search: async () => { order.push('local'); return []; },
      });
      waterfall.registerAdapter({
        source: 'relay',
        isAvailable: () => true,
        search: async () => { order.push('relay'); return []; },
      });

      await waterfall.discover({ query: 'test' });
      expect(order).toEqual(['local', 'relay']);
    });
  });

  describe('deduplication', () => {
    it('deduplicates by fingerprint, keeping highest precedence', async () => {
      const waterfall = new DiscoveryWaterfall();
      waterfall.registerAdapter(makeAdapter('local', [
        { fingerprint: 'aaa', capabilities: ['local-cap'], source: 'local', sourcePrecedence: 3 },
      ]));
      waterfall.registerAdapter(makeAdapter('relay', [
        { fingerprint: 'aaa', capabilities: ['relay-cap'], source: 'relay', sourcePrecedence: 2 },
      ]));

      const result = await waterfall.discover({ query: 'test' });
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].source).toBe('local'); // higher precedence
    });
  });

  describe('stage skipping', () => {
    it('skips specified stages', async () => {
      const waterfall = new DiscoveryWaterfall();
      waterfall.registerAdapter(makeAdapter('local', [makeAgent('a', 'local')]));
      waterfall.registerAdapter(makeAdapter('relay', [makeAgent('b', 'relay')]));

      const result = await waterfall.discover({ query: 'test', skipStages: ['relay'] });
      expect(result.agents).toHaveLength(1);
      expect(result.stages.find(s => s.source === 'relay')!.status).toBe('skipped');
    });

    it('reports no-preconditions when adapter unavailable', async () => {
      const waterfall = new DiscoveryWaterfall();
      waterfall.registerAdapter(makeAdapter('moltbridge', [], false));

      const result = await waterfall.discover({ query: 'test' });
      expect(result.stages.find(s => s.source === 'moltbridge')!.status).toBe('no-preconditions');
    });
  });

  describe('timeout handling', () => {
    it('times out slow stages', async () => {
      const waterfall = new DiscoveryWaterfall();
      waterfall.registerAdapter(makeAdapter('local', [makeAgent('a', 'local')], true, 5000));

      const result = await waterfall.discover({
        query: 'test',
        timeouts: { local: 50 }, // 50ms timeout
      });
      expect(result.stages[0].status).toBe('timeout');
      expect(result.agents).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('handles adapter errors gracefully', async () => {
      const waterfall = new DiscoveryWaterfall();
      waterfall.registerAdapter({
        source: 'relay',
        isAvailable: () => true,
        search: async () => { throw new Error('Connection refused'); },
      });

      const result = await waterfall.discover({ query: 'test' });
      expect(result.stages.find(s => s.source === 'relay')!.status).toBe('error');
      expect(result.agents).toHaveLength(0);
    });

    it('continues to next stage after error', async () => {
      const waterfall = new DiscoveryWaterfall();
      waterfall.registerAdapter({
        source: 'local',
        isAvailable: () => true,
        search: async () => { throw new Error('fail'); },
      });
      waterfall.registerAdapter(makeAdapter('relay', [makeAgent('b', 'relay')]));

      const result = await waterfall.discover({ query: 'test' });
      expect(result.agents).toHaveLength(1);
      expect(result.stages[0].status).toBe('error');
      expect(result.stages[1].status).toBe('success');
    });
  });

  describe('result metadata', () => {
    it('tracks total duration', async () => {
      const waterfall = new DiscoveryWaterfall();
      waterfall.registerAdapter(makeAdapter('local', []));

      const result = await waterfall.discover({ query: 'test' });
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('respects limit', async () => {
      const waterfall = new DiscoveryWaterfall();
      const agents = Array.from({ length: 20 }, (_, i) => makeAgent(`agent-${i}`, 'local'));
      waterfall.registerAdapter(makeAdapter('local', agents));

      const result = await waterfall.discover({ query: 'test', limit: 5 });
      expect(result.agents).toHaveLength(5);
    });
  });
});
