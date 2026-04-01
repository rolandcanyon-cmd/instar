/**
 * Session Error Nudge — validates that sessions idle after an API error
 * get nudged to continue instead of being killed by the zombie detector.
 *
 * Root cause: When Claude Code hits an API error (e.g., 400 "Could not process image"),
 * it displays the error and returns to the idle prompt. The session just stops.
 * Without this fix, the zombie detector kills it 15 minutes later with no recovery.
 *
 * The fix: On first idle detection, check terminal output for error patterns.
 * If found, inject a nudge message to get the session working again.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Session error nudge', () => {
  const SM_PATH = path.join(process.cwd(), 'src/core/SessionManager.ts');
  let source: string;

  it('source file exists', () => {
    source = fs.readFileSync(SM_PATH, 'utf-8');
    expect(source).toBeTruthy();
  });

  describe('error detection patterns', () => {
    it('defines TERMINAL_ERROR_PATTERNS', () => {
      source = fs.readFileSync(SM_PATH, 'utf-8');
      expect(source).toContain('TERMINAL_ERROR_PATTERNS');
    });

    it('includes API error patterns', () => {
      source = fs.readFileSync(SM_PATH, 'utf-8');
      expect(source).toContain("'API Error:'");
      expect(source).toContain("'invalid_request_error'");
      expect(source).toContain("'Could not process'");
    });

    it('includes rate limit and timeout patterns', () => {
      source = fs.readFileSync(SM_PATH, 'utf-8');
      expect(source).toContain("'rate_limit_error'");
      expect(source).toContain("'Request timed out'");
      expect(source).toContain("'overloaded_error'");
    });

    it('includes network error patterns', () => {
      source = fs.readFileSync(SM_PATH, 'utf-8');
      expect(source).toContain("'ECONNREFUSED'");
      expect(source).toContain("'ETIMEDOUT'");
      expect(source).toContain("'fetch failed'");
    });
  });

  describe('nudge mechanism', () => {
    it('tracks error-nudged sessions', () => {
      source = fs.readFileSync(SM_PATH, 'utf-8');
      expect(source).toContain('errorNudgedSessions');
    });

    it('only nudges once per session (prevents infinite loops)', () => {
      source = fs.readFileSync(SM_PATH, 'utf-8');
      // Should check errorNudgedSessions before nudging
      expect(source).toContain('errorNudgedSessions.has(session.id)');
      // Should add to set after nudging
      expect(source).toContain('errorNudgedSessions.add(session.id)');
    });

    it('nudges on first idle detection when error is present', () => {
      source = fs.readFileSync(SM_PATH, 'utf-8');
      // The nudge should happen inside the "first idle" block (when idlePromptSince doesn't have the session)
      expect(source).toContain('idle after API error');
      expect(source).toContain('nudging to continue');
    });

    it('sends a recovery message via sendInput', () => {
      source = fs.readFileSync(SM_PATH, 'utf-8');
      expect(source).toContain('sendInput(session.tmuxSession');
      // The nudge message should tell Claude to continue
      expect(source).toContain('continue your work');
      expect(source).toContain('skip or work around');
    });

    it('resets idle timer after nudge', () => {
      source = fs.readFileSync(SM_PATH, 'utf-8');
      // After nudging, the idle timer should be cleared so the 15m countdown restarts
      expect(source).toContain('idlePromptSince.delete(session.id)');
    });

    it('cleans up nudge tracker on session complete', () => {
      source = fs.readFileSync(SM_PATH, 'utf-8');
      expect(source).toContain('errorNudgedSessions.delete(session.id)');
    });

    it('captures 30 lines of terminal output for error detection', () => {
      source = fs.readFileSync(SM_PATH, 'utf-8');
      // Should capture enough lines to see the error (not just the prompt)
      expect(source).toContain('captureOutput(session.tmuxSession, 30)');
    });
  });
});

describe('Crash detector error classification', () => {
  const CD_PATH = path.join(process.cwd(), 'src/monitoring/crash-detector.ts');
  let source: string;

  it('classifies 400 errors as API type', () => {
    source = fs.readFileSync(CD_PATH, 'utf-8');
    expect(source).toContain("'400'");
  });

  it('classifies invalid_request_error as API type', () => {
    source = fs.readFileSync(CD_PATH, 'utf-8');
    expect(source).toContain("'invalid_request_error'");
  });

  it('classifies 502 errors as API type', () => {
    source = fs.readFileSync(CD_PATH, 'utf-8');
    expect(source).toContain("'502'");
  });

  it('classifies overloaded_error as API type', () => {
    source = fs.readFileSync(CD_PATH, 'utf-8');
    expect(source).toContain("'overloaded_error'");
  });
});
