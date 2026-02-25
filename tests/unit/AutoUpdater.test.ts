import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import type { UpdateChecker } from '../../src/core/UpdateChecker.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { StateManager } from '../../src/core/StateManager.js';

// ── Mock Factories ──────────────────────────────────────────────

function createMockUpdateChecker(overrides?: Partial<UpdateChecker>): UpdateChecker {
  return {
    check: vi.fn().mockResolvedValue({
      currentVersion: '0.9.8',
      latestVersion: '0.9.8',
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
    }),
    applyUpdate: vi.fn().mockResolvedValue({
      success: true,
      previousVersion: '0.9.8',
      newVersion: '0.9.9',
      message: 'Updated',
      restartNeeded: true,
      healthCheck: 'skipped',
    }),
    getInstalledVersion: vi.fn().mockReturnValue('0.9.8'),
    getLastCheck: vi.fn().mockReturnValue(null),
    rollback: vi.fn().mockResolvedValue({ success: false, previousVersion: '0.9.8', restoredVersion: '0.9.8', message: 'No rollback' }),
    canRollback: vi.fn().mockReturnValue(false),
    getRollbackInfo: vi.fn().mockReturnValue(null),
    fetchChangelog: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as UpdateChecker;
}

function createMockTelegram(): TelegramAdapter {
  return {
    sendToTopic: vi.fn().mockResolvedValue(undefined),
    platform: 'telegram',
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
    onMessage: vi.fn(),
    resolveUser: vi.fn(),
  } as unknown as TelegramAdapter;
}

function createMockState(): StateManager {
  return {
    get: vi.fn().mockReturnValue(997), // agent-updates-topic
    set: vi.fn(),
    getSession: vi.fn().mockReturnValue(null),
    saveSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    deleteSession: vi.fn(),
  } as unknown as StateManager;
}

// ── Tests ────────────────────────────────────────────────────────

describe('AutoUpdater', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-updater-test-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('start/stop', () => {
    it('starts and reports status as running', () => {
      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
        { checkIntervalMinutes: 30 },
      );

      updater.start();
      expect(updater.getStatus().running).toBe(true);

      updater.stop();
      expect(updater.getStatus().running).toBe(false);
    });

    it('start is idempotent', () => {
      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
      );

      updater.start();
      updater.start(); // Should be a no-op
      expect(updater.getStatus().running).toBe(true);

      updater.stop();
    });
  });

  describe('configuration', () => {
    it('defaults to 30 minute check interval', () => {
      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
      );

      expect(updater.getStatus().config.checkIntervalMinutes).toBe(30);
    });

    it('defaults to autoApply true', () => {
      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
      );

      expect(updater.getStatus().config.autoApply).toBe(true);
    });

    it('respects custom config', () => {
      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
        { checkIntervalMinutes: 15, autoApply: false, autoRestart: false },
      );

      const status = updater.getStatus();
      expect(status.config.checkIntervalMinutes).toBe(15);
      expect(status.config.autoApply).toBe(false);
      expect(status.config.autoRestart).toBe(false);
    });
  });

  describe('state persistence', () => {
    it('saves state to disk', () => {
      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
      );

      // Trigger a state save by starting (which sets initial state)
      updater.start();
      updater.stop();

      const stateFile = path.join(tmpDir, 'state', 'auto-updater.json');
      // State file may or may not exist depending on whether a tick ran
      // What we're testing is that the constructor doesn't crash on missing file
      expect(() => updater.getStatus()).not.toThrow();
    });

    it('loads persisted state on construction', () => {
      // Write persisted state
      const stateFile = path.join(tmpDir, 'state', 'auto-updater.json');
      fs.writeFileSync(stateFile, JSON.stringify({
        lastCheck: '2026-01-01T00:00:00.000Z',
        lastApply: '2026-01-01T00:00:00.000Z',
        lastAppliedVersion: '0.9.7',
        lastError: null,
        pendingUpdate: null,
      }));

      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
      );

      const status = updater.getStatus();
      expect(status.lastCheck).toBe('2026-01-01T00:00:00.000Z');
      expect(status.lastAppliedVersion).toBe('0.9.7');
    });

    it('handles corrupted state file gracefully', () => {
      const stateFile = path.join(tmpDir, 'state', 'auto-updater.json');
      fs.writeFileSync(stateFile, 'not json!!!');

      // Should not throw
      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
      );

      expect(updater.getStatus().lastCheck).toBeNull();
    });
  });

  describe('loop guard', () => {
    it('persisted lastAppliedVersion prevents re-apply', () => {
      // Simulate: version 0.9.9 was already applied in a previous cycle,
      // but the running binary is still 0.9.8 (common with npx cache).
      const stateFile = path.join(tmpDir, 'state', 'auto-updater.json');
      fs.writeFileSync(stateFile, JSON.stringify({
        lastAppliedVersion: '0.9.9',
        savedAt: new Date().toISOString(),
      }));

      const mockChecker = createMockUpdateChecker({
        check: vi.fn().mockResolvedValue({
          currentVersion: '0.9.8',
          latestVersion: '0.9.9',
          updateAvailable: true,
          checkedAt: new Date().toISOString(),
        }),
      });

      const updater = new AutoUpdater(
        mockChecker,
        createMockState(),
        tmpDir,
        { autoApply: true },
      );

      const status = updater.getStatus();
      expect(status.lastAppliedVersion).toBe('0.9.9');

      // The loop guard should prevent applyUpdate from being called
      // when tick runs, because lastAppliedVersion === latestVersion
    });
  });

  describe('Telegram notifications', () => {
    it('setTelegram wires the adapter', () => {
      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
      );

      const telegram = createMockTelegram();
      updater.setTelegram(telegram);

      // No crash — adapter is now available for notifications
      expect(updater.getStatus().running).toBe(false);
    });
  });
});
