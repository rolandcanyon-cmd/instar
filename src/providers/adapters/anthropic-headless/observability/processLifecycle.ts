/**
 * ProcessLifecycle: process state for tmux-hosted Claude sessions.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ProcessLifecycle,
  ProcessState,
  ProcessStateChange,
} from '../../../primitives/observability/processLifecycle.js';
import type { SessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import type { AnthropicHeadlessConfig } from '../config.js';
import { tmuxSessionFromHandle } from '../transport/agenticSessionHeadless.js';

const execFileAsync = promisify(execFile);

class AnthropicHeadlessProcessLifecycle implements ProcessLifecycle {
  readonly capability = CapabilityFlag.ProcessLifecycle;

  constructor(private readonly config: AnthropicHeadlessConfig) {}

  async state(session: SessionHandle): Promise<ProcessState> {
    const tmuxName = tmuxSessionFromHandle(session);
    let alive = false;
    let pids: number[] = [];
    let startedAt = new Date(0).toISOString();
    try {
      const { stdout } = await execFileAsync(
        this.config.tmuxPath,
        ['list-panes', '-t', `=${tmuxName}:`, '-F', '#{pane_pid} #{session_created}'],
        { timeout: 5000 },
      );
      const lines = stdout.trim().split('\n').filter(Boolean);
      if (lines.length > 0) {
        alive = true;
        pids = lines.map((line) => parseInt(line.split(' ')[0]!, 10)).filter((p) => !Number.isNaN(p));
        const created = parseInt(lines[0]!.split(' ')[1]!, 10);
        if (!Number.isNaN(created)) {
          startedAt = new Date(created * 1000).toISOString();
        }
      }
    } catch {
      // session not found = dead
    }
    return { alive, pids, startedAt };
  }

  subscribe(session: SessionHandle): AsyncIterable<ProcessStateChange> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        let lastAlive: boolean | null = null;
        while (true) {
          const state = await self.state(session);
          if (lastAlive !== null && lastAlive !== state.alive) {
            yield {
              session,
              kind: state.alive ? 'restarted' : 'died',
              state,
              timestamp: new Date().toISOString(),
            };
          }
          lastAlive = state.alive;
          if (!state.alive) return;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      },
    };
  }
}

export function createProcessLifecycle(config: AnthropicHeadlessConfig): ProcessLifecycle {
  return new AnthropicHeadlessProcessLifecycle(config);
}
