/**
 * TimeoutBound implementation for openai-codex.
 *
 * Codex has per-subagent `job_max_runtime_seconds` but no top-level
 * session-timeout config. Adapter enforces externally: records a deadline
 * per session, fires HardKill when reached.
 */

import type { CancellationOptions, SessionHandle } from '../../../types.js';
import type {
  TimeoutBound,
  TimeoutBoundOptions,
} from '../../../primitives/control/timeoutBound.js';
import { CapabilityFlag } from '../../../capabilities.js';

interface Deadline {
  deadlineAt: number;
  expiryAction: 'graceful' | 'hard-kill';
  timer: NodeJS.Timeout;
}

class OpenAiCodexTimeoutBound implements TimeoutBound {
  readonly capability = CapabilityFlag.TimeoutBound;
  private readonly deadlines = new Map<SessionHandle, Deadline>();

  async setDeadline(
    session: SessionHandle,
    durationMinutes: number,
    options?: TimeoutBoundOptions,
  ): Promise<void> {
    await this.clearDeadline(session);
    const ms = durationMinutes * 60_000;
    const expiryAction = options?.expiryAction ?? 'hard-kill';
    const timer = setTimeout(() => {
      // Best-effort: caller wires the kill action. This primitive just
      // tracks the deadline; HardKill is invoked by an external watchdog
      // observing the deadline state.
      this.deadlines.delete(session);
    }, ms);
    timer.unref();
    this.deadlines.set(session, { deadlineAt: Date.now() + ms, expiryAction, timer });
  }

  async getDeadline(session: SessionHandle, _options?: CancellationOptions): Promise<{ deadlineAt: string; remainingMs: number } | null> {
    const d = this.deadlines.get(session);
    if (!d) return null;
    return {
      deadlineAt: new Date(d.deadlineAt).toISOString(),
      remainingMs: Math.max(0, d.deadlineAt - Date.now()),
    };
  }

  async clearDeadline(session: SessionHandle, _options?: CancellationOptions): Promise<void> {
    const d = this.deadlines.get(session);
    if (d) {
      clearTimeout(d.timer);
      this.deadlines.delete(session);
    }
  }
}

export function createTimeoutBound(): TimeoutBound {
  return new OpenAiCodexTimeoutBound();
}
