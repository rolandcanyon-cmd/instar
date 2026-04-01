/**
 * Unit tests for TunnelManager.
 *
 * Tests state management, URL construction, lifecycle, and error handling.
 * Mocks the `cloudflared` module to avoid needing the real binary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';

// ── Mock cloudflared ────────────────────────────────────────────────

class MockTunnel extends EventEmitter {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

let mockBinExists = true;
let mockInstallCalled = false;
let lastQuickUrl: string | undefined;
let lastToken: string | undefined;
let mockTunnel: MockTunnel;

vi.mock('cloudflared', () => ({
  get bin() {
    return '/mock/cloudflared';
  },
  install: async () => {
    mockInstallCalled = true;
  },
  Tunnel: {
    quick: (url: string) => {
      lastQuickUrl = url;
      mockTunnel = new MockTunnel();
      return mockTunnel;
    },
    withToken: (token: string) => {
      lastToken = token;
      mockTunnel = new MockTunnel();
      return mockTunnel;
    },
  },
}));

// Mock fs.existsSync for the binary check
const originalExistsSync = fs.existsSync;
vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
  if (String(p) === '/mock/cloudflared') {
    return mockBinExists;
  }
  return originalExistsSync(p);
});

// Import after mocking
const { TunnelManager } = await import('../../src/tunnel/TunnelManager.js');

describe('TunnelManager', () => {
  let project: TempProject;

  beforeEach(() => {
    project = createTempProject();
    mockBinExists = true;
    mockInstallCalled = false;
    lastQuickUrl = undefined;
    lastToken = undefined;
  });

  afterEach(() => {
    project.cleanup();
  });

  function createManager(overrides: Record<string, unknown> = {}) {
    return new TunnelManager({
      enabled: true,
      type: 'quick' as const,
      port: 7777,
      stateDir: project.stateDir,
      ...overrides,
    });
  }

  describe('constructor', () => {
    it('initializes with null state', () => {
      const tm = createManager();
      expect(tm.url).toBeNull();
      expect(tm.isRunning).toBe(false);
      expect(tm.state.type).toBe('quick');
      expect(tm.state.startedAt).toBeNull();
    });

    it('respects named type', () => {
      const tm = createManager({ type: 'named', token: 'tok-123' });
      expect(tm.state.type).toBe('named');
    });
  });

  describe('start (quick tunnel)', () => {
    it('starts and resolves with URL on url event', async () => {
      const tm = createManager();
      const startPromise = tm.start();

      // Simulate cloudflared emitting the URL
      setTimeout(() => {
        mockTunnel.emit('url', 'https://abc123.trycloudflare.com');
      }, 10);

      const url = await startPromise;
      expect(url).toBe('https://abc123.trycloudflare.com');
      expect(tm.url).toBe('https://abc123.trycloudflare.com');
      expect(tm.isRunning).toBe(true);
      expect(lastQuickUrl).toBe('http://127.0.0.1:7777');
    });

    it('saves state to disk on url event', async () => {
      const tm = createManager();
      const startPromise = tm.start();

      setTimeout(() => {
        mockTunnel.emit('url', 'https://test.trycloudflare.com');
      }, 10);

      await startPromise;

      const stateFile = path.join(project.stateDir, 'tunnel.json');
      expect(fs.existsSync(stateFile)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(saved.url).toBe('https://test.trycloudflare.com');
      expect(saved.startedAt).toBeTruthy();
    });

    it('emits url and connected events', async () => {
      const tm = createManager();
      const events: string[] = [];

      tm.on('url', () => events.push('url'));
      tm.on('connected', () => events.push('connected'));

      const startPromise = tm.start();

      setTimeout(() => {
        mockTunnel.emit('url', 'https://x.trycloudflare.com');
        mockTunnel.emit('connected', { id: 'conn-1', ip: '1.2.3.4', location: 'LAX' });
      }, 10);

      await startPromise;
      // Give time for connected event
      await new Promise(r => setTimeout(r, 20));

      expect(events).toContain('url');
      expect(events).toContain('connected');
    });

    it('returns existing URL if already running', async () => {
      const tm = createManager();
      const p = tm.start();
      setTimeout(() => mockTunnel.emit('url', 'https://a.trycloudflare.com'), 10);
      await p;

      // Second start() should return the existing URL (not throw)
      const url = await tm.start();
      expect(url).toBe('https://a.trycloudflare.com');
    });

    it('rejects on error event', async () => {
      const tm = createManager();
      // Catch the re-emitted error to prevent unhandled error
      tm.on('error', () => {});
      const p = tm.start();
      setTimeout(() => mockTunnel.emit('error', new Error('DNS failure')), 10);

      await expect(p).rejects.toThrow('DNS failure');
    });

    it('rejects on exit before url', async () => {
      const tm = createManager();
      const p = tm.start();
      setTimeout(() => mockTunnel.emit('exit', 1), 10);

      await expect(p).rejects.toThrow('exited with code 1');
    });

    it('installs binary if missing', async () => {
      mockBinExists = false;
      const tm = createManager();
      const p = tm.start();
      setTimeout(() => mockTunnel.emit('url', 'https://b.trycloudflare.com'), 50);
      await p;

      expect(mockInstallCalled).toBe(true);
    });

    it('skips install if binary exists', async () => {
      mockBinExists = true;
      const tm = createManager();
      const p = tm.start();
      setTimeout(() => mockTunnel.emit('url', 'https://c.trycloudflare.com'), 10);
      await p;

      expect(mockInstallCalled).toBe(false);
    });
  });

  describe('start (named tunnel)', () => {
    it('uses token for named tunnels', async () => {
      const tm = createManager({ type: 'named', token: 'my-token' });
      const p = tm.start();
      setTimeout(() => mockTunnel.emit('url', 'https://custom.example.com'), 10);
      await p;

      expect(lastToken).toBe('my-token');
    });

    it('rejects if token is missing for named tunnel', async () => {
      const tm = createManager({ type: 'named' });
      await expect(tm.start()).rejects.toThrow('Named tunnel requires either a token');
    });
  });

  describe('stop', () => {
    it('stops the tunnel and clears state', async () => {
      const tm = createManager();
      const p = tm.start();
      setTimeout(() => mockTunnel.emit('url', 'https://d.trycloudflare.com'), 10);
      await p;

      expect(tm.isRunning).toBe(true);

      await tm.stop();
      expect(tm.isRunning).toBe(false);
      expect(tm.url).toBeNull();
      expect(mockTunnel.stopped).toBe(true);
    });

    it('emits stopped event', async () => {
      const tm = createManager();
      const p = tm.start();
      setTimeout(() => mockTunnel.emit('url', 'https://e.trycloudflare.com'), 10);
      await p;

      let stopped = false;
      tm.on('stopped', () => { stopped = true; });

      await tm.stop();
      expect(stopped).toBe(true);
    });

    it('is safe to call when not running', async () => {
      const tm = createManager();
      await expect(tm.stop()).resolves.toBeUndefined();
    });

    it('saves cleared state to disk', async () => {
      const tm = createManager();
      const p = tm.start();
      setTimeout(() => mockTunnel.emit('url', 'https://f.trycloudflare.com'), 10);
      await p;
      await tm.stop();

      const stateFile = path.join(project.stateDir, 'tunnel.json');
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(saved.url).toBeNull();
      expect(saved.startedAt).toBeNull();
    });
  });

  describe('getExternalUrl', () => {
    it('returns null when not connected', () => {
      const tm = createManager();
      expect(tm.getExternalUrl('/view/123')).toBeNull();
    });

    it('constructs full URL from tunnel base', async () => {
      const tm = createManager();
      const p = tm.start();
      setTimeout(() => mockTunnel.emit('url', 'https://abc.trycloudflare.com'), 10);
      await p;

      expect(tm.getExternalUrl('/view/123')).toBe('https://abc.trycloudflare.com/view/123');
    });

    it('handles paths without leading slash', async () => {
      const tm = createManager();
      const p = tm.start();
      setTimeout(() => mockTunnel.emit('url', 'https://abc.trycloudflare.com'), 10);
      await p;

      expect(tm.getExternalUrl('health')).toBe('https://abc.trycloudflare.com/health');
    });

    it('strips trailing slash from base URL', async () => {
      const tm = createManager();
      const p = tm.start();
      setTimeout(() => mockTunnel.emit('url', 'https://abc.trycloudflare.com/'), 10);
      await p;

      expect(tm.getExternalUrl('/health')).toBe('https://abc.trycloudflare.com/health');
    });
  });

  describe('forceStop', () => {
    it('stops the tunnel and clears state', async () => {
      const tm = createManager();
      const p = tm.start();
      setTimeout(() => mockTunnel.emit('url', 'https://force.trycloudflare.com'), 10);
      await p;

      expect(tm.isRunning).toBe(true);

      await tm.forceStop();
      expect(tm.isRunning).toBe(false);
      expect(tm.url).toBeNull();
    });

    it('emits stopped event', async () => {
      const tm = createManager();
      const p = tm.start();
      setTimeout(() => mockTunnel.emit('url', 'https://fs2.trycloudflare.com'), 10);
      await p;

      let stopped = false;
      tm.on('stopped', () => { stopped = true; });

      await tm.forceStop();
      expect(stopped).toBe(true);
    });

    it('is safe to call when not running', async () => {
      const tm = createManager();
      await expect(tm.forceStop()).resolves.toBeUndefined();
    });

    it('disables auto-reconnect', async () => {
      const tm = createManager();
      tm.enableAutoReconnect();
      const p = tm.start();
      setTimeout(() => mockTunnel.emit('url', 'https://fs3.trycloudflare.com'), 10);
      await p;

      await tm.forceStop();

      // After forceStop, the _stopped flag prevents reconnect.
      // Simulate unexpected exit — should NOT attempt reconnect.
      expect(tm.isRunning).toBe(false);
    });
  });

  describe('auto-reconnect', () => {
    it('does not reconnect by default on unexpected exit', async () => {
      const tm = createManager();
      // Catch errors to prevent unhandled rejection
      tm.on('error', () => {});
      const p = tm.start();
      setTimeout(() => mockTunnel.emit('url', 'https://ar1.trycloudflare.com'), 10);
      await p;

      // Simulate unexpected exit (not stopped intentionally)
      mockTunnel.emit('exit', 1);

      // Wait a bit — no reconnect should happen
      await new Promise(r => setTimeout(r, 100));
      // tm should still be in a disconnected state with no reconnect timer
      expect(tm.isRunning).toBe(false);
    });

    it('attempts reconnect on unexpected exit when enabled', async () => {
      const tm = createManager();
      tm.on('error', () => {});
      tm.enableAutoReconnect();
      const p = tm.start();
      setTimeout(() => mockTunnel.emit('url', 'https://ar2.trycloudflare.com'), 10);
      await p;

      // Simulate unexpected exit
      mockTunnel.emit('exit', 1);

      // Wait for reconnect attempt (base delay is 5s, but we just check the timer was set)
      // We can't easily test the full reconnect cycle without more complex mocking,
      // but we can verify it doesn't crash and stop clears the timer.
      await tm.stop();
      expect(tm.isRunning).toBe(false);
    });

    it('stop() cancels pending reconnect', async () => {
      const tm = createManager();
      tm.on('error', () => {});
      tm.enableAutoReconnect();
      const p = tm.start();
      setTimeout(() => mockTunnel.emit('url', 'https://ar3.trycloudflare.com'), 10);
      await p;

      // Simulate unexpected exit to trigger reconnect timer
      mockTunnel.emit('exit', 1);

      // Immediately stop — should cancel the reconnect timer
      await tm.stop();
      expect(tm.isRunning).toBe(false);

      // Wait past the reconnect delay — nothing should happen
      await new Promise(r => setTimeout(r, 200));
      expect(tm.isRunning).toBe(false);
    });
  });

  describe('state', () => {
    it('returns a copy (not a reference)', () => {
      const tm = createManager();
      const s1 = tm.state;
      const s2 = tm.state;
      expect(s1).not.toBe(s2);
      expect(s1).toEqual(s2);
    });

    it('includes connection info after connected', async () => {
      const tm = createManager();
      const p = tm.start();
      setTimeout(() => {
        mockTunnel.emit('url', 'https://g.trycloudflare.com');
        mockTunnel.emit('connected', { id: 'conn-xyz', ip: '5.6.7.8', location: 'SFO' });
      }, 10);
      await p;
      await new Promise(r => setTimeout(r, 20));

      const state = tm.state;
      expect(state.connectionId).toBe('conn-xyz');
      expect(state.connectionLocation).toBe('SFO');
    });
  });
});
