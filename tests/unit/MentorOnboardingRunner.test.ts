/**
 * Tier-1 unit tests for MentorOnboardingRunner — the thin glue around the pure
 * tick core (FRAMEWORK-ONBOARDING-MENTOR-SPEC §19.4). Verifies the off-by-default
 * short-circuit and correct service wiring with fakes (no tmux/LLM/server).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MentorOnboardingRunner,
  DEFAULT_MENTOR_CONFIG,
  type MentorConfig,
  type MentorRunnerServices,
} from '../../src/scheduler/MentorOnboardingRunner.js';

function fakeServices(over: Partial<MentorRunnerServices> = {}): MentorRunnerServices {
  return {
    capture: vi.fn(() => ({ runId: 'r', framework: 'codex-cli', findingsCount: 0, observationsWritten: 0, newIssues: 0, regressionCandidates: [] })),
    spawnStageA: vi.fn(async () => 'clean conversational reply'),
    runStageBForensics: vi.fn(async () => []),
    isMenteeBusy: vi.fn(() => false),
    minIntervalElapsed: vi.fn(() => true),
    budgetOk: vi.fn(() => true),
    getSurface: vi.fn((framework: string) => ({ framework, threadlineHistory: 'hi' })),
    ...over,
  };
}

describe('MentorOnboardingRunner', () => {
  it('ships dormant: disabled config short-circuits to reason=disabled (no work)', async () => {
    const svc = fakeServices();
    const runner = new MentorOnboardingRunner(svc, () => ({ ...DEFAULT_MENTOR_CONFIG }));
    const r = await runner.tick();
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('disabled');
    expect(svc.spawnStageA).not.toHaveBeenCalled();
    expect(svc.budgetOk).not.toHaveBeenCalled();
  });

  it('mode "off" also short-circuits even if enabled flag flips', async () => {
    const svc = fakeServices();
    const cfg: MentorConfig = { ...DEFAULT_MENTOR_CONFIG, enabled: true, mode: 'off' };
    const runner = new MentorOnboardingRunner(svc, () => cfg);
    expect((await runner.tick()).reason).toBe('disabled');
  });

  it('when enabled + safe + in budget, runs a full tick and captures', async () => {
    const svc = fakeServices();
    const cfg: MentorConfig = { ...DEFAULT_MENTOR_CONFIG, enabled: true, mode: 'dry-run' };
    const runner = new MentorOnboardingRunner(svc, () => cfg);
    const r = await runner.tick();
    expect(r.ran).toBe(true);
    expect(r.mode).toBe('dry-run');
    expect(svc.spawnStageA).toHaveBeenCalled();
    expect(svc.capture).toHaveBeenCalled();
  });

  it('treats a busy mentee as an unsafe window (skips)', async () => {
    const svc = fakeServices({ isMenteeBusy: () => true });
    const cfg: MentorConfig = { ...DEFAULT_MENTOR_CONFIG, enabled: true, mode: 'live' };
    const r = await new MentorOnboardingRunner(svc, () => cfg).tick();
    expect(r.reason).toBe('unsafe-window');
    expect(svc.spawnStageA).not.toHaveBeenCalled();
  });

  it('treats not-yet-elapsed min-interval as unsafe (anti-forced-cadence)', async () => {
    const svc = fakeServices({ minIntervalElapsed: () => false });
    const cfg: MentorConfig = { ...DEFAULT_MENTOR_CONFIG, enabled: true, mode: 'live' };
    const r = await new MentorOnboardingRunner(svc, () => cfg).tick();
    expect(r.reason).toBe('unsafe-window');
  });

  it('status() reflects config', () => {
    const cfg: MentorConfig = { ...DEFAULT_MENTOR_CONFIG, enabled: true, mode: 'live', menteeFramework: 'cursor' };
    const runner = new MentorOnboardingRunner(fakeServices(), () => cfg);
    expect(runner.status()).toEqual({ enabled: true, mode: 'live', menteeFramework: 'cursor' });
  });
});
