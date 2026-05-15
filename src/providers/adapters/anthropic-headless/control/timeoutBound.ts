/**
 * TimeoutBound: external watchdog enforces deadline.
 *
 * Records deadlines in an in-memory map. The actual kill is driven by a
 * separate watchdog process (Instar's existing SessionWatchdog or similar)
 * that reads `getDeadline` and triggers HardKill when reached.
 *
 * Phase 3a: provides the interface contract. Phase 3b's interactive-pool
 * adapter uses the same approach; Phase 5's routing policy provides the
 * watchdog wiring.
 */

import type {
  TimeoutBound,
  TimeoutBoundOptions,
} from '../../../primitives/control/timeoutBound.js';
import type { SessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';

interface DeadlineRecord {
  deadlineAt: string;
  expiryAction: 'graceful' | 'hard-kill';
  reason?: string;
}

class AnthropicHeadlessTimeoutBound implements TimeoutBound {
  readonly capability = CapabilityFlag.TimeoutBound;
  private readonly deadlines = new Map<SessionHandle, DeadlineRecord>();

  async setDeadline(
    session: SessionHandle,
    durationMinutes: number,
    options?: TimeoutBoundOptions,
  ): Promise<void> {
    const deadline = new Date(Date.now() + durationMinutes * 60_000).toISOString();
    this.deadlines.set(session, {
      deadlineAt: deadline,
      expiryAction: options?.expiryAction ?? 'hard-kill',
      reason: options?.reason,
    });
  }

  async getDeadline(
    session: SessionHandle,
  ): Promise<{ deadlineAt: string; remainingMs: number } | null> {
    const record = this.deadlines.get(session);
    if (!record) return null;
    const remainingMs = new Date(record.deadlineAt).getTime() - Date.now();
    return { deadlineAt: record.deadlineAt, remainingMs };
  }

  async clearDeadline(session: SessionHandle): Promise<void> {
    this.deadlines.delete(session);
  }
}

export function createTimeoutBound(): TimeoutBound {
  return new AnthropicHeadlessTimeoutBound();
}
