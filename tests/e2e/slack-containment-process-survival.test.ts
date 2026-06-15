/**
 * E2E "feature is alive" test (Robustness Net #1, FD-8).
 *
 * The single most important test for this feature: prove that the REAL
 * process-level guards keep a process ALIVE through a contained Slack error, and
 * still CRASH (exit 1) on a genuinely-unknown one. A naive boot-time test would
 * false-green — server.ts's existing boot try/catch already contains a start()
 * failure, so the regression under test (a throw from an un-awaited POST-boot
 * listener, surfacing as uncaughtException OR unhandledRejection) never fires
 * during boot. Instead we spawn a real child process that registers the real
 * handlers via the built dist `handleProcessLevelError`, emits the error from an
 * un-awaited context, and we assert the OS-level process outcome.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const POLICY_PATH = path.resolve(__dirname, '../../dist/core/uncaughtExceptionPolicy.js');
const REPO_ROOT = path.resolve(__dirname, '../..');

// The child registers the REAL handlers (real process.on, real process.exit)
// delegating to the built handleProcessLevelError — the production wiring.
const CHILD_SCRIPT = `
const { handleProcessLevelError } = await import(process.env.POLICY_PATH);
const onFatalCleanup = () => {};
process.on('uncaughtException', (e) => handleProcessLevelError(e, 'uncaughtException', { onFatalCleanup }));
process.on('unhandledRejection', (r) => handleProcessLevelError(r, 'unhandledRejection', { onFatalCleanup }));
const scenario = process.env.SCENARIO;
if (scenario === 'contained-uncaught') {
  setTimeout(() => { throw new Error('WebSocket is not open: readyState 2'); }, 10);
} else if (scenario === 'contained-rejection') {
  Promise.reject(new Error('WebSocket is not open: readyState 2'));
} else if (scenario === 'control-uncaught') {
  setTimeout(() => { throw new Error('genuine unknown corruption — must crash'); }, 10);
}
// If the process is still alive after the error would have fired, declare it.
setTimeout(() => { process.stdout.write('STILL-ALIVE\\n'); process.exit(0); }, 300);
`;

interface ChildResult { code: number | null; stdout: string; stderr: string; }

function runChild(scenario: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT], {
      env: { ...process.env, POLICY_PATH, SCENARIO: scenario },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('Slack containment — process survives a contained error, crashes on an unknown one', () => {
  beforeAll(() => {
    // The E2E exercises the BUILT artifact (closest to production). CI builds
    // before tests; build here if the dist is missing so the test is self-contained.
    if (!existsSync(POLICY_PATH)) {
      execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });
    }
    expect(existsSync(POLICY_PATH)).toBe(true);
  }, 300_000);

  it('survives a contained Slack WebSocket error thrown as an uncaughtException', async () => {
    const { code, stdout } = await runChild('contained-uncaught');
    expect(stdout).toContain('STILL-ALIVE');
    expect(code).toBe(0);
  }, 30_000);

  it('survives a contained Slack WebSocket error surfacing as an unhandledRejection', async () => {
    const { code, stdout } = await runChild('contained-rejection');
    expect(stdout).toContain('STILL-ALIVE');
    expect(code).toBe(0);
  }, 30_000);

  it('STILL crashes (exit 1) on a genuinely-unknown error — fail-toward-crash preserved', async () => {
    const { code, stdout } = await runChild('control-uncaught');
    expect(stdout).not.toContain('STILL-ALIVE');
    expect(code).toBe(1);
  }, 30_000);
});
