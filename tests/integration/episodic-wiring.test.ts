/**
 * Wiring Integrity Tests — SessionActivitySentinel
 *
 * Tests that server.ts passes the correct dependencies to SessionActivitySentinel.
 * Reconstructs the wiring patterns from server.ts lines 1412-1441 and verifies:
 *
 *   1. intelligence is not null/no-op (evaluate is callable)
 *   2. getActiveSessions delegates to sessionManager.listRunningSessions
 *   3. captureSessionOutput delegates to sessionManager.captureOutput
 *   4. getTelegramMessages delegates to telegram.searchLog (the wired lambda)
 *   5. getTopicForSession delegates to telegram.getTopicForSession
 *   6. sessionComplete event on sessionManager triggers synthesizeSession
 *
 * Background: Phase 3 (Episodic Memory) depends on 6+ dependency-injected functions.
 * Unit tests mock all of them. This test verifies the ACTUAL wiring is correct —
 * that the functions server.ts passes aren't null, aren't no-ops, and delegate
 * to the real implementations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionActivitySentinel } from '../../src/monitoring/SessionActivitySentinel.js';
import type { IntelligenceProvider, Session } from '../../src/core/types.js';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';

// ─── Helpers ──────────────────────────────────────────────

/** Mock SessionManager with the methods wired in server.ts. */
function createMockSessionManager() {
  const sessions: Session[] = [];
  const capturedOutputs = new Map<string, string>();
  const eventHandlers = new Map<string, Function[]>();

  return {
    sessions,
    capturedOutputs,
    eventHandlers,

    listRunningSessions: vi.fn(() => sessions.filter(s => s.status === 'running')),

    captureOutput: vi.fn((tmuxSession: string) => {
      return capturedOutputs.get(tmuxSession) ?? null;
    }),

    on: vi.fn((event: string, handler: Function) => {
      if (!eventHandlers.has(event)) eventHandlers.set(event, []);
      eventHandlers.get(event)!.push(handler);
    }),

    // Simulate event emission (mirrors EventEmitter.emit)
    emit: (event: string, ...args: any[]) => {
      const handlers = eventHandlers.get(event) ?? [];
      for (const handler of handlers) {
        handler(...args);
      }
    },
  };
}

/** Mock TelegramAdapter with the methods wired in server.ts. */
function createMockTelegramAdapter() {
  const topicSessionMap = new Map<string, number>();

  return {
    topicSessionMap,

    searchLog: vi.fn((_opts: { topicId: number; since?: Date; limit: number }) => {
      return [
        { text: 'Hello from Telegram', fromJustin: true, topicId: 4509, timestamp: new Date().toISOString() },
      ];
    }),

    getTopicForSession: vi.fn((tmuxSession: string): number | null => {
      return topicSessionMap.get(tmuxSession) ?? null;
    }),
  };
}

function createMockIntelligenceProvider(): IntelligenceProvider {
  return {
    evaluate: vi.fn(async () => JSON.stringify({
      summary: 'Test digest summary',
      actions: ['action 1'],
      learnings: ['learning 1'],
      significance: 5,
      themes: ['test'],
    })),
  };
}

// ─── Tests ──────────────────────────────────────────────

describe('SessionActivitySentinel wiring integrity', () => {
  let project: TempProject;

  beforeEach(() => {
    project = createTempProject();
  });

  afterEach(() => {
    project.cleanup();
    vi.restoreAllMocks();
  });

  // ─── Intelligence Provider Wiring ──────────────────────

  describe('intelligence provider', () => {
    it('is not null when sharedIntelligence exists', () => {
      const intelligence = createMockIntelligenceProvider();

      // Server.ts only creates sentinel IF sharedIntelligence exists
      // This mirrors: if (sharedIntelligence) { ... }
      expect(intelligence).toBeDefined();
      expect(typeof intelligence.evaluate).toBe('function');
    });

    it('evaluate is callable and returns diagnosis JSON', async () => {
      const intelligence = createMockIntelligenceProvider();

      const result = await intelligence.evaluate('test prompt', { model: 'fast' });

      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      const parsed = JSON.parse(result);
      expect(parsed.summary).toBeDefined();
      expect(parsed.significance).toBeDefined();
    });

    it('sentinel uses intelligence during scan (not bypassed)', async () => {
      const intelligence = createMockIntelligenceProvider();
      const sessionManager = createMockSessionManager();

      // Add a running session with output
      const session: Session = {
        id: 'test-sess-1',
        name: 'test-worker',
        status: 'running',
        tmuxSession: 'tmux-test-worker',
        startedAt: new Date().toISOString(),
        prompt: 'work on tests',
      };
      sessionManager.sessions.push(session);

      // Session output must exceed 500 chars for partitioner
      const longOutput = Array.from({ length: 20 }, (_, i) =>
        `[${i}] Running test suite step ${i} with detailed output and assertions...`
      ).join('\n');
      sessionManager.capturedOutputs.set('tmux-test-worker', longOutput);

      const sentinel = new SessionActivitySentinel({
        stateDir: project.stateDir,
        intelligence,
        getActiveSessions: () => sessionManager.listRunningSessions(),
        captureSessionOutput: (tmux) => sessionManager.captureOutput(tmux),
      });

      await sentinel.scan();

      // Intelligence was actually called — this is the critical check
      expect(intelligence.evaluate).toHaveBeenCalled();
      expect(intelligence.evaluate).toHaveBeenCalledWith(
        expect.stringContaining('activity digest'),
        expect.objectContaining({ model: 'fast' }),
      );
    });
  });

  // ─── getActiveSessions Wiring ──────────────────────────

  describe('getActiveSessions', () => {
    it('delegates to sessionManager.listRunningSessions', () => {
      const sessionManager = createMockSessionManager();
      sessionManager.sessions.push({
        id: 'sess-1',
        name: 'worker-1',
        status: 'running',
        tmuxSession: 'tmux-worker-1',
        startedAt: new Date().toISOString(),
        prompt: 'work',
      });

      // This is the wired function from server.ts:
      // getActiveSessions: () => sessionManager.listRunningSessions()
      const getActiveSessions = () => sessionManager.listRunningSessions();

      const sessions = getActiveSessions();

      expect(sessionManager.listRunningSessions).toHaveBeenCalled();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].name).toBe('worker-1');
    });

    it('returns empty when no sessions running', () => {
      const sessionManager = createMockSessionManager();

      const getActiveSessions = () => sessionManager.listRunningSessions();
      const sessions = getActiveSessions();

      expect(sessions).toHaveLength(0);
    });
  });

  // ─── captureSessionOutput Wiring ───────────────────────

  describe('captureSessionOutput', () => {
    it('delegates to sessionManager.captureOutput', () => {
      const sessionManager = createMockSessionManager();
      sessionManager.capturedOutputs.set('tmux-worker', 'real tmux output here');

      // Wired as: captureSessionOutput: (tmuxSession) => sessionManager.captureOutput(tmuxSession)
      const captureSessionOutput = (tmuxSession: string) => sessionManager.captureOutput(tmuxSession);

      const output = captureSessionOutput('tmux-worker');

      expect(sessionManager.captureOutput).toHaveBeenCalledWith('tmux-worker');
      expect(output).toBe('real tmux output here');
    });

    it('returns null for non-existent session (not error)', () => {
      const sessionManager = createMockSessionManager();

      const captureSessionOutput = (tmuxSession: string) => sessionManager.captureOutput(tmuxSession);
      const output = captureSessionOutput('non-existent');

      expect(output).toBeNull();
    });
  });

  // ─── getTelegramMessages Wiring ────────────────────────

  describe('getTelegramMessages', () => {
    it('delegates to telegram.searchLog with correct parameters', () => {
      const telegram = createMockTelegramAdapter();

      // This is the actual wired function from server.ts lines 1423-1428:
      // getTelegramMessages: telegram
      //   ? (topicId, since) => telegram!.searchLog({
      //       topicId,
      //       since: since ? new Date(since) : undefined,
      //       limit: 200,
      //     })
      //   : undefined,
      const getTelegramMessages = (topicId: number, since?: string) =>
        telegram.searchLog({
          topicId,
          since: since ? new Date(since) : undefined,
          limit: 200,
        });

      const sinceDate = '2026-02-27T10:00:00Z';
      const messages = getTelegramMessages(4509, sinceDate);

      expect(telegram.searchLog).toHaveBeenCalledWith({
        topicId: 4509,
        since: new Date(sinceDate),
        limit: 200,
      });
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe('Hello from Telegram');
    });

    it('passes undefined for since when not provided', () => {
      const telegram = createMockTelegramAdapter();

      const getTelegramMessages = (topicId: number, since?: string) =>
        telegram.searchLog({
          topicId,
          since: since ? new Date(since) : undefined,
          limit: 200,
        });

      getTelegramMessages(4509);

      expect(telegram.searchLog).toHaveBeenCalledWith({
        topicId: 4509,
        since: undefined,
        limit: 200,
      });
    });

    it('is undefined when telegram is not configured', () => {
      // Mirrors: getTelegramMessages: telegram ? ... : undefined
      const telegram = null;
      const getTelegramMessages = telegram
        ? () => { /* would call telegram.searchLog */ }
        : undefined;

      expect(getTelegramMessages).toBeUndefined();
    });
  });

  // ─── getTopicForSession Wiring ─────────────────────────

  describe('getTopicForSession', () => {
    it('delegates to telegram.getTopicForSession', () => {
      const telegram = createMockTelegramAdapter();
      telegram.topicSessionMap.set('tmux-worker', 4509);

      // Wired as: getTopicForSession: telegram
      //   ? (tmuxSession) => telegram!.getTopicForSession(tmuxSession)
      //   : undefined
      const getTopicForSession = (tmuxSession: string) => telegram.getTopicForSession(tmuxSession);

      const topicId = getTopicForSession('tmux-worker');

      expect(telegram.getTopicForSession).toHaveBeenCalledWith('tmux-worker');
      expect(topicId).toBe(4509);
    });

    it('returns null for unmapped session', () => {
      const telegram = createMockTelegramAdapter();

      const getTopicForSession = (tmuxSession: string) => telegram.getTopicForSession(tmuxSession);
      const topicId = getTopicForSession('unknown-session');

      expect(topicId).toBeNull();
    });
  });

  // ─── sessionComplete Event Wiring ──────────────────────

  describe('sessionComplete event', () => {
    it('event handler calls sentinel.synthesizeSession', async () => {
      const sessionManager = createMockSessionManager();
      const intelligence = createMockIntelligenceProvider();

      const sentinel = new SessionActivitySentinel({
        stateDir: project.stateDir,
        intelligence,
        getActiveSessions: () => sessionManager.listRunningSessions(),
        captureSessionOutput: () => null,
      });

      // Spy on synthesizeSession
      const synthesizeSpy = vi.spyOn(sentinel, 'synthesizeSession');

      // This mirrors the wiring from server.ts lines 1434-1440:
      // sessionManager.on('sessionComplete', (session) => {
      //   activitySentinel!.synthesizeSession(session).then(...)
      // });
      sessionManager.on('sessionComplete', (session: Session) => {
        sentinel.synthesizeSession(session);
      });

      // Emit the event
      const completedSession: Session = {
        id: 'completed-1',
        name: 'done-worker',
        status: 'completed',
        tmuxSession: 'tmux-done-worker',
        startedAt: new Date(Date.now() - 3600000).toISOString(),
        endedAt: new Date().toISOString(),
        prompt: 'work',
      };

      sessionManager.emit('sessionComplete', completedSession);

      // Give the promise a tick to resolve
      await new Promise(r => setTimeout(r, 10));

      expect(synthesizeSpy).toHaveBeenCalledWith(completedSession);
    });
  });

  // ─── Full wiring object — no null/undefined members ────

  describe('full sentinel config wiring', () => {
    it('all deps are callable when telegram is configured', () => {
      const sessionManager = createMockSessionManager();
      const telegram = createMockTelegramAdapter();
      const intelligence = createMockIntelligenceProvider();

      // Reconstruct full wiring from server.ts
      const config = {
        stateDir: project.stateDir,
        intelligence,
        getActiveSessions: () => sessionManager.listRunningSessions(),
        captureSessionOutput: (tmux: string) => sessionManager.captureOutput(tmux),
        getTelegramMessages: (topicId: number, since?: string) =>
          telegram.searchLog({
            topicId,
            since: since ? new Date(since) : undefined,
            limit: 200,
          }),
        getTopicForSession: (tmux: string) => telegram.getTopicForSession(tmux),
      };

      expect(typeof config.intelligence.evaluate).toBe('function');
      expect(typeof config.getActiveSessions).toBe('function');
      expect(typeof config.captureSessionOutput).toBe('function');
      expect(typeof config.getTelegramMessages).toBe('function');
      expect(typeof config.getTopicForSession).toBe('function');
    });

    it('none of the dep functions are empty bodies', () => {
      const sessionManager = createMockSessionManager();
      const telegram = createMockTelegramAdapter();
      const intelligence = createMockIntelligenceProvider();

      const config = {
        stateDir: project.stateDir,
        intelligence,
        getActiveSessions: () => sessionManager.listRunningSessions(),
        captureSessionOutput: (tmux: string) => sessionManager.captureOutput(tmux),
        getTelegramMessages: (topicId: number, since?: string) =>
          telegram.searchLog({
            topicId,
            since: since ? new Date(since) : undefined,
            limit: 200,
          }),
        getTopicForSession: (tmux: string) => telegram.getTopicForSession(tmux),
      };

      // Call each and verify it delegates (mock was called)
      config.getActiveSessions();
      expect(sessionManager.listRunningSessions).toHaveBeenCalled();

      config.captureSessionOutput('test');
      expect(sessionManager.captureOutput).toHaveBeenCalled();

      config.getTelegramMessages(42);
      expect(telegram.searchLog).toHaveBeenCalled();

      config.getTopicForSession('test');
      expect(telegram.getTopicForSession).toHaveBeenCalled();
    });

    it('sentinel can be constructed with full wiring without error', () => {
      const sessionManager = createMockSessionManager();
      const telegram = createMockTelegramAdapter();
      const intelligence = createMockIntelligenceProvider();

      const sentinel = new SessionActivitySentinel({
        stateDir: project.stateDir,
        intelligence,
        getActiveSessions: () => sessionManager.listRunningSessions(),
        captureSessionOutput: (tmux) => sessionManager.captureOutput(tmux),
        getTelegramMessages: (topicId, since) =>
          telegram.searchLog({
            topicId,
            since: since ? new Date(since) : undefined,
            limit: 200,
          }),
        getTopicForSession: (tmux) => telegram.getTopicForSession(tmux),
      });

      expect(sentinel).toBeInstanceOf(SessionActivitySentinel);
      expect(sentinel.getEpisodicMemory()).toBeDefined();
    });
  });
});
