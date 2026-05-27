/**
 * MentorOnboardingRunner — thin glue that assembles the real services into the
 * pure runMentorTick core (FRAMEWORK-ONBOARDING-MENTOR-SPEC §19.4).
 *
 * The runner holds no orchestration logic of its own — that lives in
 * runMentorTick (pure, fully unit-tested). The runner's only job is to (a) read
 * the mentor config and short-circuit when the feature is off, and (b) wire the
 * injected services (ledger, Stage-A spawn, Stage-B forensics, mentee-busy check,
 * budget gate, surface builder) into the tick's callbacks. Every service is
 * injected, so the runner is testable with fakes and carries no hard dependency
 * on SessionManager/tmux/LLM at construction.
 *
 * Ships dormant: `mentor.enabled=false` / `mentor.mode='off'` by default (§16).
 */
import { runMentorTick, type MentorTickResult, type MentorMode } from './MentorOnboardingTick.js';
import type { ConversationSurface } from '../monitoring/MentorStageA.js';
import type { CaptureRunInput, CaptureRunResult, ForensicFinding } from '../monitoring/FrameworkIssueLedger.js';

export interface MentorConfig {
  enabled: boolean;
  mode: 'off' | 'dry-run' | 'live';
  /** The framework being mentored (parametric). */
  menteeFramework: string;
  minIntervalMs: number;
  maxRoundsPerDay: number;
  dailySpendCapUsd: number;
}

export const DEFAULT_MENTOR_CONFIG: MentorConfig = {
  enabled: false,
  mode: 'off',
  menteeFramework: 'codex-cli',
  minIntervalMs: 600_000, // 10 min floor
  maxRoundsPerDay: 24,
  dailySpendCapUsd: 0.5,
};

export interface MentorRunnerServices {
  /** Write findings + log the run to the ledger funnel (§19.2). */
  capture: (input: CaptureRunInput) => CaptureRunResult;
  /** Spawn Stage A with the empty tool grant; return its transcript. */
  spawnStageA: (prompt: string) => Promise<string>;
  /** Stage-B forensics for the framework; return findings. */
  runStageBForensics: (framework: string) => Promise<ForensicFinding[]>;
  /** Durable safe-window inputs. */
  isMenteeBusy: () => boolean;
  minIntervalElapsed: () => boolean;
  /** Fail-closed budget gate. */
  budgetOk: () => boolean;
  /** Build the conversation surface (Stage A's only input). */
  getSurface: (framework: string) => ConversationSurface;
  /** Called once when a tick actually RAN (ran=true) — lets the host advance the
   *  min-interval clock and the per-day run counter. */
  onTickRan?: () => void;
  now?: () => number;
}

export type MentorRunReason = MentorTickResult['reason'] | 'disabled';

export interface MentorRunResult extends Omit<MentorTickResult, 'reason'> {
  reason: MentorRunReason;
}

export class MentorOnboardingRunner {
  constructor(
    private readonly services: MentorRunnerServices,
    private readonly getConfig: () => MentorConfig,
  ) {}

  status(): { enabled: boolean; mode: MentorConfig['mode']; menteeFramework: string } {
    const cfg = this.getConfig();
    return { enabled: cfg.enabled, mode: cfg.mode, menteeFramework: cfg.menteeFramework };
  }

  /** Run one tick. Short-circuits to `disabled` when the feature is off (§16). */
  async tick(): Promise<MentorRunResult> {
    const cfg = this.getConfig();
    if (!cfg.enabled || cfg.mode === 'off') {
      return { ran: false, reason: 'disabled' };
    }
    const framework = cfg.menteeFramework;
    const mode: MentorMode = cfg.mode === 'live' ? 'live' : 'dry-run';
    const result = await runMentorTick({
      framework,
      mode,
      surface: this.services.getSurface(framework),
      // Safe window = mentee at rest AND the min-interval floor elapsed (§12 Q3).
      safeWindowOpen: !this.services.isMenteeBusy() && this.services.minIntervalElapsed(),
      budgetOk: this.services.budgetOk(),
      spawnStageA: this.services.spawnStageA,
      runStageBForensics: () => this.services.runStageBForensics(framework),
      capture: this.services.capture,
      now: this.services.now,
    });
    if (result.ran) this.services.onTickRan?.();
    return result;
  }
}
