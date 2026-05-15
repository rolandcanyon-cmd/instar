/**
 * Interrupt implementation: send Ctrl-C via tmux to interrupt mid-turn.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Interrupt, InterruptOptions } from '../../../primitives/control/interrupt.js';
import type { SessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { UnexpectedError } from '../../../errors.js';
import type { AnthropicHeadlessConfig } from '../config.js';
import { ANTHROPIC_HEADLESS_ID } from '../errors.js';
import { tmuxSessionFromHandle } from '../transport/agenticSessionHeadless.js';

const execFileAsync = promisify(execFile);

class AnthropicHeadlessInterrupt implements Interrupt {
  readonly capability = CapabilityFlag.Interrupt;

  constructor(private readonly config: AnthropicHeadlessConfig) {}

  async interrupt(session: SessionHandle, _options?: InterruptOptions): Promise<void> {
    const tmuxName = tmuxSessionFromHandle(session);
    try {
      await execFileAsync(this.config.tmuxPath, ['send-keys', '-t', `=${tmuxName}:`, 'C-c'], {
        timeout: 5000,
      });
    } catch (err) {
      throw new UnexpectedError(
        `Failed to interrupt ${tmuxName}: ${(err as Error).message}`,
        ANTHROPIC_HEADLESS_ID,
        err,
      );
    }
  }

  isNonDestructive(): boolean {
    // Ctrl-C interrupts generation but the REPL stays available.
    return true;
  }
}

export function createInterrupt(config: AnthropicHeadlessConfig): Interrupt {
  return new AnthropicHeadlessInterrupt(config);
}
