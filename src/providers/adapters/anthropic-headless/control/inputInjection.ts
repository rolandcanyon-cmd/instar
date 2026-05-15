/**
 * InputInjection implementation for anthropic-headless via tmux send-keys.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  InputInjection,
  InputInjectionOptions,
  ControlKey,
} from '../../../primitives/control/inputInjection.js';
import type { SessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { UnexpectedError } from '../../../errors.js';
import type { AnthropicHeadlessConfig } from '../config.js';
import { ANTHROPIC_HEADLESS_ID } from '../errors.js';
import { tmuxSessionFromHandle } from '../transport/agenticSessionHeadless.js';

const execFileAsync = promisify(execFile);

const KEY_MAP: Record<ControlKey, string> = {
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  BackTab: 'BTab',
  Backspace: 'BSpace',
  Delete: 'DC',
  'C-c': 'C-c',
  'C-d': 'C-d',
  'C-z': 'C-z',
  'C-l': 'C-l',
  Up: 'Up',
  Down: 'Down',
  Left: 'Left',
  Right: 'Right',
};

class AnthropicHeadlessInputInjection implements InputInjection {
  readonly capability = CapabilityFlag.InputInjection;

  constructor(private readonly config: AnthropicHeadlessConfig) {}

  async send(
    session: SessionHandle,
    input: string,
    options?: InputInjectionOptions,
  ): Promise<void> {
    const tmuxName = tmuxSessionFromHandle(session);
    const submit = options?.submitOnEnter !== false;
    const padding = options?.paddingMs ?? 500;

    try {
      await execFileAsync(
        this.config.tmuxPath,
        ['send-keys', '-t', `=${tmuxName}:`, '-l', input],
        { timeout: 5000 },
      );

      if (submit) {
        if (padding > 0) {
          await new Promise((resolve) => setTimeout(resolve, padding));
        }
        await execFileAsync(this.config.tmuxPath, ['send-keys', '-t', `=${tmuxName}:`, 'Enter'], {
          timeout: 5000,
        });
      }
    } catch (err) {
      throw new UnexpectedError(
        `Failed to inject input into ${tmuxName}: ${(err as Error).message}`,
        ANTHROPIC_HEADLESS_ID,
        err,
      );
    }
  }

  async sendKey(session: SessionHandle, key: ControlKey): Promise<void> {
    const tmuxName = tmuxSessionFromHandle(session);
    const tmuxKey = KEY_MAP[key];
    if (!tmuxKey) {
      throw new UnexpectedError(`Unmapped control key: ${key}`, ANTHROPIC_HEADLESS_ID);
    }
    try {
      await execFileAsync(this.config.tmuxPath, ['send-keys', '-t', `=${tmuxName}:`, tmuxKey], {
        timeout: 5000,
      });
    } catch (err) {
      throw new UnexpectedError(
        `Failed to send key ${key} to ${tmuxName}: ${(err as Error).message}`,
        ANTHROPIC_HEADLESS_ID,
        err,
      );
    }
  }
}

export function createInputInjection(config: AnthropicHeadlessConfig): InputInjection {
  return new AnthropicHeadlessInputInjection(config);
}
