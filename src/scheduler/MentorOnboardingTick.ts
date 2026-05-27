/**
 * MentorOnboardingTick — the structural core of one mentor heartbeat tick
 * (FRAMEWORK-ONBOARDING-MENTOR-SPEC §3, §4, §6, §19.4).
 *
 * This is PURE orchestration logic with every side-effect injected as a
 * callback, so the whole tick is unit-testable without tmux, an LLM, or a
 * server. The structural guarantees the spec demands live HERE (in code), not
 * in a prompt:
 *
 *   - The leak canary runs FIRST every tick; a dead detector halts the tick and
 *     self-reports (§4.3) — the detector can't silently rot.
 *   - The budget check is a fail-closed PRE-tick gate: under budget pressure the
 *     ENTIRE tick is skipped before any spend or any contact (§6) — never a
 *     partial Stage A without Stage B.
 *   - The safe-window check gates on a durable mentee state, not a clock (§12 Q3).
 *   - Stage A is driven via the injected `spawnStageA` (the §19.4 runner passes
 *     the empty-tool-grant spawn); its transcript is run through the leakage
 *     detector and any leak is captured as an instar-integration-gap (§4.3).
 *   - Stage B forensics + capture run via injected callbacks; the ledger's
 *     captureRun logs the run to the funnel even when nothing is found (§19.2).
 */
import {
  buildStageAContext,
  detectStageALeak,
  runLeakCanary,
  leakToFinding,
  type ConversationSurface,
} from '../monitoring/MentorStageA.js';
import type { CaptureRunInput, CaptureRunResult, ForensicFinding } from '../monitoring/FrameworkIssueLedger.js';

/** Mentor run modes (spec §16). `off` never reaches the tick; `dry-run` does
 *  everything except deliver a message to the mentee; `live` is the full loop. */
export type MentorMode = 'dry-run' | 'live';

export interface MentorTickDeps {
  framework: string;
  mode: MentorMode;
  /** The user-visible conversation surface (Stage A's only input). */
  surface: ConversationSurface;
  /** Durable safe-window: true when the mentee is at a stable point (task-complete /
   *  waiting / blocked / quiet-after-user-msg) AND the min-interval floor has elapsed. */
  safeWindowOpen: boolean;
  /** Fail-closed budget gate (the GET /autonomous/can-start precedent). */
  budgetOk: boolean;
  /** Spawn Stage A (empty tool grant) and return its transcript. Injected so the
   *  pure tick has no SessionManager/tmux dependency. */
  spawnStageA: (prompt: string) => Promise<string>;
  /** Stage-B forensics: read the mentee's logs/rollouts/diff and return findings.
   *  Injected so the pure tick has no LLM dependency. */
  runStageBForensics: () => Promise<ForensicFinding[]>;
  /** Write findings + log the run to the ledger funnel (§19.2). */
  capture: (input: CaptureRunInput) => CaptureRunResult;
  /** Tick id for provenance/episode keying. */
  tickId?: string;
  now?: () => number;
  /** Leak-detector liveness check; defaults to the real canary. Injected for tests. */
  canaryCheck?: () => boolean;
}

export type MentorTickReason =
  | 'canary-failed'
  | 'budget'
  | 'unsafe-window'
  | 'stage-a-failed'
  | 'ran';

export interface MentorTickResult {
  ran: boolean;
  reason: MentorTickReason;
  mode?: MentorMode;
  leakDetected?: boolean;
  observationsWritten?: number;
  findingsCount?: number;
  /** The Stage-A message the mentor produced (delivered only in `live` mode by the runner). */
  stageAMessage?: string;
}

/**
 * Run one mentor tick. Returns a structured result; the only side effects are
 * via the injected callbacks. Order is load-bearing (canary → budget →
 * safe-window → Stage A → leak → Stage B → capture).
 */
export async function runMentorTick(deps: MentorTickDeps): Promise<MentorTickResult> {
  const tickId = deps.tickId ?? `mentor-${(deps.now ?? Date.now)()}`;

  // 1. Leak canary FIRST — a dead detector can't be trusted to police Stage A,
  //    so we halt and self-report rather than run blind (§4.3).
  const canary = deps.canaryCheck ?? runLeakCanary;
  if (!canary()) {
    deps.capture({
      framework: deps.framework,
      tickId,
      findings: [
        {
          bucket: 'instar-integration-gap',
          title: 'Mentor leak detector canary failed — detector may be inert',
          dedupKey: `${deps.framework}::leak-canary-failed`,
          signature: 'leak-canary-failed',
          severity: 'high',
          episodeKey: tickId,
        },
      ],
    });
    return { ran: false, reason: 'canary-failed' };
  }

  // 2. Budget gate — fail-closed BEFORE any spend or contact (§6).
  if (!deps.budgetOk) return { ran: false, reason: 'budget' };

  // 3. Safe-window — only act at a durable mentee state transition (§12 Q3).
  if (!deps.safeWindowOpen) return { ran: false, reason: 'unsafe-window' };

  // 4. Stage A — drive the mentee from the conversation surface only.
  let transcript: string;
  try {
    transcript = await deps.spawnStageA(buildStageAContext(deps.surface));
  } catch {
    deps.capture({
      framework: deps.framework,
      tickId,
      findings: [
        {
          bucket: 'instar-integration-gap',
          title: 'Stage-A spawn failed during a mentor tick',
          dedupKey: `${deps.framework}::stage-a-spawn-failed`,
          signature: 'stage-a-spawn-failed',
          severity: 'medium',
          episodeKey: tickId,
        },
      ],
    });
    return { ran: false, reason: 'stage-a-failed' };
  }

  // 5. Leakage detection on the Stage-A transcript (§4.3).
  const leak = detectStageALeak(transcript, deps.surface);
  const findings: ForensicFinding[] = [];
  if (leak.leaked) findings.push(leakToFinding(deps.framework, leak, tickId));

  // 6. Stage B forensics (separate step, full tool access in the runner).
  const stageBFindings = await deps.runStageBForensics();
  findings.push(...stageBFindings);

  // 7. Capture — writes findings + logs the run to the funnel (§19.2),
  //    even if findings is empty (inert-writer guard).
  const captured = deps.capture({ framework: deps.framework, tickId, findings });

  return {
    ran: true,
    reason: 'ran',
    mode: deps.mode,
    leakDetected: leak.leaked,
    observationsWritten: captured.observationsWritten,
    findingsCount: findings.length,
    // The tick SURFACES the Stage-A message it produced; it does NOT deliver it.
    // No mentee-delivery path is wired yet — `live` mode is not reachable until
    // the persist-only delivery (§6) is built + tested. Until then both dry-run
    // and live only observe + capture. Delivery is a live-promotion blocker.
    // <!-- tracked: topic-13435 -->
    stageAMessage: transcript,
  };
}
