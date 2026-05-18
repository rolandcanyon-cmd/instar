/**
 * Interrupt implementation for openai-codex.
 *
 * Sends Ctrl-C via tmux send-keys to interrupt the current turn without
 * ending the session. Same pattern as Anthropic adapter for the bare-CLI
 * path. Future iteration: when the app-server is in use, route through
 * `turn/interrupt` JSON-RPC method instead.
 */

import { execFileSync } from 'node:child_process';
import type { SessionHandle } from '../../../types.js';
import type { Interrupt, InterruptOptions } from '../../../primitives/control/interrupt.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { tmuxSessionFromHandle } from '../transport/agenticSessionHeadless.js';
import type { OpenAiCodexConfig } from '../config.js';

class OpenAiCodexInterrupt implements Interrupt {
  readonly capability = CapabilityFlag.Interrupt;

  constructor(private readonly config: OpenAiCodexConfig) {}

  async interrupt(session: SessionHandle, _options?: InterruptOptions): Promise<void> {
    const tmuxName = tmuxSessionFromHandle(session);
    try {
      execFileSync(this.config.tmuxPath, ['send-keys', '-t', tmuxName, 'C-c'], {
        encoding: 'utf-8',
        timeout: 5000,
      });
    } catch {
      /* ignore — session may already be ending */
    }
  }

  isNonDestructive(): boolean { return true; }
}

export function createInterrupt(config: OpenAiCodexConfig): Interrupt {
  return new OpenAiCodexInterrupt(config);
}
