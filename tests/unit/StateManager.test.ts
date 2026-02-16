import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager } from '../../src/core/StateManager.js';
import type { Session, ActivityEvent } from '../../src/core/types.js';

describe('StateManager', () => {
  let tmpDir: string;
  let state: StateManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kit-test-'));
    // Create required subdirectories
    fs.mkdirSync(path.join(tmpDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true });
    state = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Session State', () => {
    const makeSession = (overrides?: Partial<Session>): Session => ({
      id: 'test-123',
      name: 'test-session',
      status: 'running',
      tmuxSession: 'project-test-session',
      startedAt: new Date().toISOString(),
      ...overrides,
    });

    it('saves and retrieves a session', () => {
      const session = makeSession();
      state.saveSession(session);

      const retrieved = state.getSession('test-123');
      expect(retrieved).toEqual(session);
    });

    it('returns null for unknown session', () => {
      expect(state.getSession('nonexistent')).toBeNull();
    });

    it('lists sessions by status', () => {
      state.saveSession(makeSession({ id: 'a', status: 'running' }));
      state.saveSession(makeSession({ id: 'b', status: 'completed' }));
      state.saveSession(makeSession({ id: 'c', status: 'running' }));

      const running = state.listSessions({ status: 'running' });
      expect(running).toHaveLength(2);
      expect(running.map(s => s.id).sort()).toEqual(['a', 'c']);
    });

    it('lists all sessions without filter', () => {
      state.saveSession(makeSession({ id: 'a', status: 'running' }));
      state.saveSession(makeSession({ id: 'b', status: 'completed' }));

      const all = state.listSessions();
      expect(all).toHaveLength(2);
    });
  });

  describe('Job State', () => {
    it('saves and retrieves job state', () => {
      const jobState = {
        slug: 'email-check',
        lastRun: new Date().toISOString(),
        lastResult: 'success' as const,
        consecutiveFailures: 0,
      };

      state.saveJobState(jobState);
      const retrieved = state.getJobState('email-check');
      expect(retrieved).toEqual(jobState);
    });

    it('returns null for unknown job', () => {
      expect(state.getJobState('nonexistent')).toBeNull();
    });
  });

  describe('Activity Events', () => {
    it('appends and queries events', () => {
      const event: ActivityEvent = {
        type: 'session_start',
        summary: 'Started email check job',
        sessionId: 'test-123',
        timestamp: new Date().toISOString(),
      };

      state.appendEvent(event);
      state.appendEvent({ ...event, type: 'session_end', summary: 'Finished' });

      const events = state.queryEvents({});
      expect(events).toHaveLength(2);
    });

    it('filters events by type', () => {
      state.appendEvent({
        type: 'session_start',
        summary: 'Start',
        timestamp: new Date().toISOString(),
      });
      state.appendEvent({
        type: 'job_complete',
        summary: 'Done',
        timestamp: new Date().toISOString(),
      });

      const starts = state.queryEvents({ type: 'session_start' });
      expect(starts).toHaveLength(1);
      expect(starts[0].type).toBe('session_start');
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        state.appendEvent({
          type: 'test',
          summary: `Event ${i}`,
          timestamp: new Date().toISOString(),
        });
      }

      const events = state.queryEvents({ limit: 3 });
      expect(events).toHaveLength(3);
    });
  });

  describe('Generic Key-Value', () => {
    it('stores and retrieves values', () => {
      state.set('test-key', { foo: 'bar', count: 42 });
      const value = state.get<{ foo: string; count: number }>('test-key');
      expect(value).toEqual({ foo: 'bar', count: 42 });
    });

    it('returns null for missing keys', () => {
      expect(state.get('missing')).toBeNull();
    });
  });
});
