/**
 * Semantic Verification Tests
 *
 * Tests the decision boundaries of StallTriageNurse.verifyAction().
 * The original verification was too weak: any tmux output change counted
 * as "recovered," including a mere newline echo from nudge. These tests
 * verify the corrected logic distinguishes genuine recovery from noise.
 *
 * The verification logic (for nudge/interrupt/unstick) checks:
 * 1. If output is identical → NOT recovered
 * 2. If output has new work indicators (Read, Write, etc.) → recovered
 * 3. If output grew by 100+ chars without work indicators → recovered
 * 4. Otherwise → NOT recovered
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StallTriageNurse } from '../../src/monitoring/StallTriageNurse.js';
import type { TriageDeps, TriageContext } from '../../src/monitoring/StallTriageNurse.types.js';

// ─── Helpers ──────────────────────────────────────────────

function createMockDeps(): TriageDeps {
  return {
    captureSessionOutput: vi.fn().mockReturnValue('default output'),
    isSessionAlive: vi.fn().mockReturnValue(true),
    sendKey: vi.fn().mockReturnValue(true),
    sendInput: vi.fn().mockReturnValue(true),
    getTopicHistory: vi.fn().mockReturnValue([]),
    sendToTopic: vi.fn().mockResolvedValue({}),
    respawnSession: vi.fn().mockResolvedValue(undefined),
    clearStallForTopic: vi.fn(),
  };
}

/**
 * Create a TriageContext with specific tmuxOutput for verification testing.
 * The context.tmuxOutput represents the "before" state that verification
 * compares against.
 */
function createContext(tmuxOutput: string): TriageContext {
  return {
    sessionName: 'test-session',
    topicId: 1,
    tmuxOutput,
    sessionStatus: 'alive',
    recentMessages: [],
    pendingMessage: 'hello',
    waitMinutes: 5,
  };
}

// ─── Tests ──────────────────────────────────────────────

describe('Semantic Verification', () => {
  let deps: TriageDeps;
  let nurse: StallTriageNurse;

  beforeEach(() => {
    deps = createMockDeps();
    nurse = new StallTriageNurse(deps, {
      config: { enabled: true, verifyDelayMs: 0 },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── status_update always passes ─────────────────────

  describe('status_update', () => {
    it('always returns true (no verification needed)', async () => {
      const result = await nurse.verifyAction('status_update', createContext('any output'));
      expect(result).toBe(true);
    });

    it('returns true even with empty output', async () => {
      const result = await nurse.verifyAction('status_update', createContext(''));
      expect(result).toBe(true);
    });
  });

  // ─── restart checks liveness ──────────────────────────

  describe('restart', () => {
    it('returns true when session is alive after restart', async () => {
      (deps.isSessionAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const result = await nurse.verifyAction('restart', createContext('old output'));
      expect(result).toBe(true);
    });

    it('returns false when session is dead after restart', async () => {
      (deps.isSessionAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const result = await nurse.verifyAction('restart', createContext('old output'));
      expect(result).toBe(false);
    });
  });

  // ─── nudge/interrupt/unstick output verification ──────

  describe('identical output (NOT recovered)', () => {
    it('rejects when output is exactly the same', async () => {
      const beforeOutput = 'session output here';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(beforeOutput);

      const result = await nurse.verifyAction('nudge', createContext(beforeOutput));
      expect(result).toBe(false);
    });

    it('rejects when output is exactly the same for interrupt', async () => {
      const beforeOutput = 'stuck in loop';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(beforeOutput);

      const result = await nurse.verifyAction('interrupt', createContext(beforeOutput));
      expect(result).toBe(false);
    });

    it('rejects when output is exactly the same for unstick', async () => {
      const beforeOutput = 'hanging process';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(beforeOutput);

      const result = await nurse.verifyAction('unstick', createContext(beforeOutput));
      expect(result).toBe(false);
    });
  });

  describe('null output (NOT recovered)', () => {
    it('rejects when captureSessionOutput returns null (session died)', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const result = await nurse.verifyAction('nudge', createContext('some output'));
      // null is coerced to '' which differs from 'some output', but has no work indicators
      // and negative growth
      expect(result).toBe(false);
    });
  });

  describe('trivial changes (NOT recovered)', () => {
    it('rejects newline-only addition', async () => {
      const before = 'session output';
      const after = 'session output\n';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('nudge', createContext(before));
      // Output changed by just 1 char (newline), no work indicators, growth < 100
      expect(result).toBe(false);
    });

    it('rejects prompt echo (small output growth without work indicators)', async () => {
      const before = 'session output';
      const after = 'session output\n❯ ';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('nudge', createContext(before));
      // Only 4 chars of growth, no work indicators
      expect(result).toBe(false);
    });

    it('rejects empty line echo from nudge', async () => {
      const before = 'Waiting for input...';
      const after = 'Waiting for input...\n\n❯';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('nudge', createContext(before));
      // Just echoed a blank line + prompt, no real work
      expect(result).toBe(false);
    });

    it('rejects ^C echo without meaningful output', async () => {
      const before = 'hanging process';
      const after = 'hanging process\n^C\n❯';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('unstick', createContext(before));
      // ^C was echoed, but no work indicators and growth < 100
      expect(result).toBe(false);
    });

    it('rejects Escape echo without meaningful output', async () => {
      const before = 'stuck in loop';
      const after = 'stuck in loop\n^[\n';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('interrupt', createContext(before));
      expect(result).toBe(false);
    });
  });

  describe('work indicator detection (recovered)', () => {
    it('accepts output with new Read tool activity', async () => {
      const before = 'session output';
      const after = 'session output\nRead(file.ts) output: file contents here';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('nudge', createContext(before));
      expect(result).toBe(true);
    });

    it('accepts output with new Write tool activity', async () => {
      const before = 'session output';
      const after = 'session output\nWrite(file.ts) completed: updated file.ts';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('nudge', createContext(before));
      expect(result).toBe(true);
    });

    it('accepts output with new Edit tool activity', async () => {
      const before = 'session output';
      const after = 'session output\nEdit(src/index.ts) applied changes';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('interrupt', createContext(before));
      expect(result).toBe(true);
    });

    it('accepts output with new Bash tool activity', async () => {
      const before = 'session output';
      const after = 'session output\nBash(npm test) running tests';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('unstick', createContext(before));
      expect(result).toBe(true);
    });

    it('accepts output with new Grep tool activity', async () => {
      const before = 'session output';
      const after = 'session output\nGrep(pattern) found 5 matches';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('nudge', createContext(before));
      expect(result).toBe(true);
    });

    it('accepts output with new Glob tool activity', async () => {
      const before = 'session output';
      const after = 'session output\nGlob(**/*.ts) matched 12 files';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('nudge', createContext(before));
      expect(result).toBe(true);
    });

    it('accepts output with telegram-reply activity', async () => {
      const before = 'session output';
      const after = 'session output\ntelegram-reply sent to topic 42';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('nudge', createContext(before));
      expect(result).toBe(true);
    });

    it('accepts output with Sent chars to topic (Telegram reply evidence)', async () => {
      const before = 'session output';
      const after = 'session output\nSent 142 chars to topic 42';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('nudge', createContext(before));
      expect(result).toBe(true);
    });

    it('does NOT count pre-existing work indicators as recovery', async () => {
      // The "before" already had Read( in it — same count doesn't indicate recovery
      const before = 'Read(file.ts) output: old stuff';
      const after = 'Read(file.ts) output: old stuff\nprompt echo';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('nudge', createContext(before));
      // Same number of "Read(" occurrences, no telegram reply = NOT recovered
      expect(result).toBe(false);
    });
  });

  describe('output growth without work indicators (NOT recovered)', () => {
    // The new verification logic requires explicit evidence of user-message handling:
    // Telegram reply, pending message keywords, or new tool calls.
    // Raw output growth alone is no longer sufficient — it was causing false positives
    // where autonomous work was mistaken for recovery.

    it('rejects output that grew by 100+ chars without work indicators', async () => {
      const before = 'session output';
      const padding = 'a'.repeat(120);
      const after = `session output\n${padding}`;
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('nudge', createContext(before));
      expect(result).toBe(false);
    });

    it('rejects output that grew by only 50 chars without work indicators', async () => {
      const before = 'session output';
      const padding = 'x'.repeat(50);
      const after = `session output\n${padding}`;
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('nudge', createContext(before));
      expect(result).toBe(false);
    });

    it('rejects output that grew by exactly 100 chars', async () => {
      const before = 'session output';
      const padding = 'x'.repeat(100);
      const after = `session output\n${padding}`;
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('nudge', createContext(before));
      expect(result).toBe(false);
    });

    it('rejects output that grew by 99 chars', async () => {
      const before = 'session output';
      const padding = 'x'.repeat(99);
      const after = `session output${padding}`;
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('nudge', createContext(before));
      expect(result).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles empty before output gracefully', async () => {
      const after = 'new output here';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('nudge', createContext(''));
      // Growth of 15 chars < 100, no work indicators = NOT recovered
      expect(result).toBe(false);
    });

    it('handles empty before output with work indicators', async () => {
      const after = 'Read(files.ts) output: scanning files';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const result = await nurse.verifyAction('nudge', createContext(''));
      expect(result).toBe(true);
    });

    it('handles empty after output (session crashed)', async () => {
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue('');

      const result = await nurse.verifyAction('nudge', createContext('had output before'));
      // Output shrank = different from before, but negative growth, no indicators
      expect(result).toBe(false);
    });

    it('verifies each action type uses the same logic for nudge/interrupt/unstick', async () => {
      const before = 'session output';
      const after = 'session output\nRead(file.ts) completed: new file content here';
      (deps.captureSessionOutput as ReturnType<typeof vi.fn>).mockReturnValue(after);

      const nudgeResult = await nurse.verifyAction('nudge', createContext(before));
      const interruptResult = await nurse.verifyAction('interrupt', createContext(before));
      const unstickResult = await nurse.verifyAction('unstick', createContext(before));

      expect(nudgeResult).toBe(true);
      expect(interruptResult).toBe(true);
      expect(unstickResult).toBe(true);
    });
  });
});
