/**
 * Tests for the pool decay handler canary.
 *
 * The canary doesn't depend on real tmux/claude — it forces a
 * deterministic spawn failure via a known-bad claudePath. So these
 * tests run cleanly in unit-test environment without INSTAR_REAL_API.
 */

import { describe, it, expect } from 'vitest';
import { runPoolDecayCanary } from '../../../../../src/providers/adapters/anthropic-interactive-pool/canary/poolDecayCanary.js';

describe('runPoolDecayCanary', () => {
  it('passes when the degraded event fires and retry is scheduled', async () => {
    const result = await runPoolDecayCanary();
    expect(result.status).toBe('pass');
    expect(result.details.degradedEventFired).toBe(true);
    expect(result.details.retryScheduled).toBe(true);
    expect(result.details.degradedAttemptValue).toBe(0);
  });

  it('exits cleanly without leaking pool sessions', async () => {
    // Two runs in sequence should both pass — proves shutdown actually
    // cleans up.
    const first = await runPoolDecayCanary();
    const second = await runPoolDecayCanary();
    expect(first.status).toBe('pass');
    expect(second.status).toBe('pass');
  });
});
