/**
 * HardKill implementation for anthropic-headless. Uses `tmux kill-session`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HardKill, HardKillOptions } from '../../../primitives/control/hardKill.js';
import type { SessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { UnexpectedError } from '../../../errors.js';
import type { AnthropicHeadlessConfig } from '../config.js';
import { ANTHROPIC_HEADLESS_ID } from '../errors.js';
import { tmuxSessionFromHandle } from '../transport/agenticSessionHeadless.js';

const execFileAsync = promisify(execFile);

class AnthropicHeadlessHardKill implements HardKill {
  readonly capability = CapabilityFlag.HardKill;

  constructor(private readonly config: AnthropicHeadlessConfig) {}

  async kill(session: SessionHandle, _options?: HardKillOptions): Promise<void> {
    const tmuxName = tmuxSessionFromHandle(session);
    try {
      await execFileAsync(this.config.tmuxPath, ['kill-session', '-t', `=${tmuxName}:`], {
        timeout: 5000,
      });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      // kill-session on a missing session is fine — already dead
      if (/can't find session|session not found/i.test(msg)) {
        return;
      }
      throw new UnexpectedError(
        `Failed to kill tmux session ${tmuxName}: ${msg}`,
        ANTHROPIC_HEADLESS_ID,
        err,
      );
    }
  }
}

export function createHardKill(config: AnthropicHeadlessConfig): HardKill {
  return new AnthropicHeadlessHardKill(config);
}
