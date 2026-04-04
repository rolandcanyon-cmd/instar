import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MoltBridgeClient, CAPABILITY_VOCABULARY, type MoltBridgeConfig } from '../../../src/moltbridge/MoltBridgeClient.js';

const testConfig: MoltBridgeConfig = {
  enabled: true,
  apiUrl: 'https://api.moltbridge.test',
  autoRegister: false,
  enrichmentMode: 'manual',
};

describe('MoltBridgeClient', () => {
  let client: MoltBridgeClient;

  beforeEach(() => {
    client = new MoltBridgeClient(testConfig);
    vi.restoreAllMocks();
  });

  describe('configuration', () => {
    it('reports enabled status', () => {
      expect(client.enabled).toBe(true);
      const disabled = new MoltBridgeClient({ ...testConfig, enabled: false });
      expect(disabled.enabled).toBe(false);
    });

    it('reports enrichment mode', () => {
      expect(client.enrichmentMode).toBe('manual');
    });
  });

  describe('capability vocabulary', () => {
    it('contains expected categories', () => {
      expect(CAPABILITY_VOCABULARY.has('code-generation')).toBe(true);
      expect(CAPABILITY_VOCABULARY.has('web-research')).toBe(true);
      expect(CAPABILITY_VOCABULARY.has('coordination')).toBe(true);
    });

    it('rejects unknown capabilities', () => {
      expect(CAPABILITY_VOCABULARY.has('quantum-teleportation')).toBe(false);
    });
  });

  describe('attestation validation', () => {
    it('rejects invalid capability tag', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      await expect(client.submitAttestation({
        attestor: 'abc',
        subject: 'def',
        capability: 'invalid-tag',
        outcome: 'success',
        confidence: 0.9,
        context: 'direct-interaction',
      })).rejects.toThrow('Invalid capability tag');

      // Should not have called fetch
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects confidence out of range', async () => {
      await expect(client.submitAttestation({
        attestor: 'abc',
        subject: 'def',
        capability: 'code-review',
        outcome: 'success',
        confidence: 1.5,
        context: 'direct-interaction',
      })).rejects.toThrow('Confidence must be between');
    });
  });

  describe('circuit breaker', () => {
    it('starts closed', () => {
      expect(client.isCircuitBreakerOpen).toBe(false);
    });

    it('opens after 3 failures', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('network error'));
      vi.stubGlobal('fetch', mockFetch);

      // Trigger 3 failures
      for (let i = 0; i < 3; i++) {
        try { await client.discover('test'); } catch { /* expected */ }
      }

      expect(client.isCircuitBreakerOpen).toBe(true);

      // Next call should fail immediately without calling fetch
      mockFetch.mockClear();
      await expect(client.discover('test')).rejects.toThrow('circuit breaker');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('IQS caching', () => {
    it('caches IQS results', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ iqsBand: 'high' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ iqsBand: 'low' }),
        });
      vi.stubGlobal('fetch', mockFetch);

      const first = await client.getIQSBand('agent-1');
      const second = await client.getIQSBand('agent-1');

      expect(first).toBe('high');
      expect(second).toBe('high'); // cached, not 'low'
      expect(mockFetch).toHaveBeenCalledTimes(1); // only one API call
    });
  });

  describe('discovery', () => {
    it('calls the discovery endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          agents: [{ agentId: 'a1', capabilities: ['code-review'], iqsBand: 'high' }],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await client.discover('code-review');
      expect(result.agents).toHaveLength(1);
      expect(result.source).toBe('moltbridge');
      expect(result.queryTimeMs).toBeGreaterThanOrEqual(0);
    });
  });
});
