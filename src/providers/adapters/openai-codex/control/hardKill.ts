/**
 * HardKill implementation for openai-codex.
 *
 * tmux kill-session for the headless-exec path. Same pattern as the
 * Anthropic adapter.
 */

import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionHandle } from '../../../types.js';
import type { HardKill, HardKillOptions } from '../../../primitives/control/hardKill.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { tmuxSessionFromHandle } from '../transport/agenticSessionHeadless.js';
import type { OpenAiCodexConfig } from '../config.js';

const execFileAsync = promisify(execFile);

class OpenAiCodexHardKill implements HardKill {
  readonly capability = CapabilityFlag.HardKill;

  constructor(private readonly config: OpenAiCodexConfig) {}

  async kill(session: SessionHandle, _options?: HardKillOptions): Promise<void> {
    const tmuxName = tmuxSessionFromHandle(session);
    try {
      await execFileAsync(this.config.tmuxPath, ['kill-session', '-t', tmuxName], { timeout: 10_000 });
    } catch {
      /* already dead is fine */
    }
    // Verify
    try {
      execFileSync(this.config.tmuxPath, ['has-session', '-t', tmuxName], { stdio: 'ignore', timeout: 3000 });
      // If has-session succeeded, session still exists — escalate (best-effort).
      try {
        execFileSync(this.config.tmuxPath, ['kill-session', '-t', tmuxName], { encoding: 'utf-8', timeout: 5000 });
      } catch {
        /* ignore */
      }
    } catch {
      // Verified gone.
    }
  }
}

export function createHardKill(config: OpenAiCodexConfig): HardKill {
  return new OpenAiCodexHardKill(config);
}
