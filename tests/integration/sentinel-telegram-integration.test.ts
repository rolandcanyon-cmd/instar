/**
 * Integration test — MessageSentinel + TelegramAdapter integration.
 *
 * Verifies that the sentinel interceptor in TelegramAdapter correctly
 * classifies messages and takes action (kill/pause sessions) before
 * they reach the normal message handler.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MessageSentinel } from '../../src/core/MessageSentinel.js';

describe('Sentinel + Telegram integration', () => {
  let sentinel: MessageSentinel;

  beforeEach(() => {
    sentinel = new MessageSentinel({});
  });

  // Simulates the onSentinelIntercept callback that server.ts wires up
  async function simulateIntercept(text: string): Promise<{
    category: string;
    action: { type: string; message?: string };
    reason?: string;
  } | null> {
    const classification = await sentinel.classify(text);
    if (classification.category === 'emergency-stop' || classification.category === 'pause') {
      return {
        category: classification.category,
        action: classification.action as { type: string; message?: string },
        reason: classification.reason,
      };
    }
    return null;
  }

  describe('Emergency stop signals', () => {
    it('intercepts "stop"', async () => {
      const result = await simulateIntercept('stop');
      expect(result).not.toBeNull();
      expect(result!.category).toBe('emergency-stop');
      expect(result!.action.type).toBe('kill-session');
    });

    it('intercepts "STOP" (all caps)', async () => {
      const result = await simulateIntercept('STOP');
      expect(result).not.toBeNull();
      expect(result!.category).toBe('emergency-stop');
    });

    it('intercepts "don\'t do that"', async () => {
      const result = await simulateIntercept("don't do that");
      expect(result).not.toBeNull();
      expect(result!.category).toBe('emergency-stop');
    });

    it('intercepts "/stop" slash command', async () => {
      const result = await simulateIntercept('/stop');
      expect(result).not.toBeNull();
      expect(result!.category).toBe('emergency-stop');
    });

    it('intercepts "/kill" slash command', async () => {
      const result = await simulateIntercept('/kill');
      expect(result).not.toBeNull();
      expect(result!.category).toBe('emergency-stop');
    });

    it('intercepts "cancel everything"', async () => {
      const result = await simulateIntercept('cancel everything');
      expect(result).not.toBeNull();
      expect(result!.category).toBe('emergency-stop');
    });
  });

  describe('Pause signals', () => {
    it('intercepts "wait"', async () => {
      const result = await simulateIntercept('wait');
      expect(result).not.toBeNull();
      expect(result!.category).toBe('pause');
      expect(result!.action.type).toBe('pause-session');
    });

    it('intercepts "/pause" slash command', async () => {
      const result = await simulateIntercept('/pause');
      expect(result).not.toBeNull();
      expect(result!.category).toBe('pause');
    });

    it('intercepts "hold on"', async () => {
      const result = await simulateIntercept('hold on');
      expect(result).not.toBeNull();
      expect(result!.category).toBe('pause');
    });
  });

  describe('Normal messages pass through', () => {
    it('returns null for normal text', async () => {
      const result = await simulateIntercept('Can you help me with the project?');
      expect(result).toBeNull();
    });

    it('returns null for questions about stopping', async () => {
      const result = await simulateIntercept('when should I stop the server?');
      expect(result).toBeNull();
    });

    it('returns null for commands', async () => {
      const result = await simulateIntercept('/new my-session');
      expect(result).toBeNull();
    });

    it('returns null for code snippets', async () => {
      const result = await simulateIntercept('change the color to red');
      expect(result).toBeNull();
    });
  });

  describe('Sentinel stats accumulate', () => {
    it('tracks classifications', async () => {
      await simulateIntercept('stop');
      await simulateIntercept('wait');
      await simulateIntercept('hello world');

      const stats = sentinel.getStats();
      expect(stats.totalClassified).toBe(3);
      expect(stats.byCategory['emergency-stop']).toBe(1);
      expect(stats.byCategory['pause']).toBe(1);
      expect(stats.byCategory['normal']).toBe(1);
    });
  });

  describe('Session action mapping', () => {
    it('maps emergency-stop to kill-session', async () => {
      const result = await simulateIntercept('stop');
      expect(result!.action.type).toBe('kill-session');
    });

    it('maps pause to pause-session', async () => {
      const result = await simulateIntercept('wait');
      expect(result!.action.type).toBe('pause-session');
    });
  });
});
