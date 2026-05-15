/**
 * Empty-prompt detector canary.
 *
 * Per Rule 3 of the path constraints (see specs/provider-portability/
 * 05-state-detection-robustness.md): every state-detection code path that
 * parses output from an evolving upstream system ships with a canary
 * that verifies the detector still reads the upstream correctly, and
 * self-heals when it doesn't.
 *
 * This canary runs at pool spawn (per session) and on a recurring
 * schedule. It does NOT use the completion detector being tested —
 * instead it uses a fixed-time wait so it can independently observe
 * upstream drift. The flow:
 *
 *   1. Capture the pane buffer BEFORE sending (baseline).
 *   2. Send a known short prompt: "reply with only the digit 7".
 *   3. Wait a fixed window (default 20s — generous for a 1-token reply).
 *   4. Capture the pane AFTER.
 *   5. Verify the new content (after \ before) contains "7" — proves the
 *      response itself completed. If not: hard failure.
 *   6. Find the empty prompt line in the after-buffer — that's the
 *      structural signature the detector should look for.
 *   7. If the current signature would have detected completion on this
 *      pane: signature is still valid, no action.
 *   8. If not: re-derive the signature from the structurally-located
 *      empty prompt line, set it as the new active signature. This is
 *      the self-heal path.
 *
 * On hard failure (step 5: the model itself didn't respond as expected,
 * suggesting Claude Code is in a fundamentally different state than we
 * understand), the canary reports a DegradationReporter event. The
 * pool refuses to bring the session up. Per Rule 3.2 this surfaces to
 * Echo-only Telegram by default.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { InteractivePool, PoolSession } from '../pool.js';
import type { InteractivePoolConfig } from '../config.js';
import { getSignature, setSignature, type EmptyPromptSignature } from './emptyPromptSignature.js';

const execFileAsync = promisify(execFile);

/**
 * The canary prompt — short, deterministic, model-agnostic.
 *
 * Token choice rationale: must be a string that's extremely unlikely to
 * appear in Claude Code's welcome banner or status bar (otherwise the
 * "after contains token, before doesn't" check false-negatives). The
 * banner contains "Opus 4.7", "Claude Max", etc. — so plain digits and
 * common English fail. A made-up uppercase compound with no spaces is
 * cheap, instructable, and not in any UI chrome.
 */
const CANARY_PROMPT = 'Reply with only the literal text PONGXYZ. Do not include any other text, punctuation, quotes, or explanation.';
const CANARY_EXPECTED = /PONGXYZ/;

/** Wait window for canary completion (ms). Generous for a 1-token reply. */
const CANARY_WAIT_MS = 20_000;

/** Total pane height in lines to inspect for the empty-prompt position. */
const PROMPT_SEARCH_DEPTH = 30;

export interface CanaryResult {
  status: 'pass' | 'self-healed' | 'fail';
  /** Human-readable summary for logs / DegradationReporter. */
  message: string;
  /** Detail about what happened, for debugging. */
  details: {
    /** Did the response itself include the expected digit? */
    responseContained7: boolean;
    /** Did the existing signature detect completion correctly? */
    existingSignatureMatched: boolean;
    /** New signature if we re-derived one. */
    newSignature?: EmptyPromptSignature;
    /** First line of the derived empty-prompt for diagnostics. */
    derivedEmptyPromptLine?: string;
    /** Captured-pane preview for hard-failure diagnostics. */
    afterPaneTail?: string;
  };
}

/**
 * Run the canary against a freshly-spawned (or running) pool session.
 *
 * Returns CanaryResult describing the outcome. Pool callers should treat
 * `fail` as a fatal startup error and refuse to bring the session ready.
 * `self-healed` and `pass` are both healthy outcomes.
 */
export async function runEmptyPromptCanary(
  pool: InteractivePool,
  session: PoolSession,
  config: InteractivePoolConfig,
  options?: { waitMs?: number; promptSearchDepth?: number },
): Promise<CanaryResult> {
  const waitMs = options?.waitMs ?? CANARY_WAIT_MS;
  const searchDepth = options?.promptSearchDepth ?? PROMPT_SEARCH_DEPTH;

  // Step 1: baseline
  const beforeBuf = (await pool.capturePane(session.tmuxName, searchDepth)) ?? '';

  // Step 2: send canary prompt
  try {
    await execFileAsync(
      config.tmuxPath,
      ['send-keys', '-t', `=${session.tmuxName}:`, '-l', CANARY_PROMPT],
      { timeout: 5000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await execFileAsync(
      config.tmuxPath,
      ['send-keys', '-t', `=${session.tmuxName}:`, 'Enter'],
      { timeout: 5000 },
    );
  } catch (err) {
    return {
      status: 'fail',
      message: `canary failed at send-keys: ${(err as Error).message}`,
      details: { responseContained7: false, existingSignatureMatched: false },
    };
  }

  // Step 3: fixed-time wait (canary deliberately does NOT use the detector
  // being tested — it watches from outside).
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  // Step 4: capture after
  const afterBuf = (await pool.capturePane(session.tmuxName, searchDepth)) ?? '';

  // Step 5: verify the response contains the expected digit. The simplest
  // check that's robust across UI rearrangement: just search the whole
  // after-buffer for the digit. If it's not there, the response itself
  // didn't happen and we can't trust anything downstream.
  const responseContained7 = CANARY_EXPECTED.test(afterBuf) && !CANARY_EXPECTED.test(beforeBuf);
  if (!responseContained7) {
    return {
      status: 'fail',
      message:
        'canary response did not contain the expected digit 7 — upstream may have changed '
        + 'response format or the model didn\'t reply in the wait window',
      details: {
        responseContained7: false,
        existingSignatureMatched: false,
        afterPaneTail: afterBuf.split('\n').slice(-15).join('\n'),
      },
    };
  }

  // Step 6: structurally find the empty-prompt line in the after-buffer.
  // We walk from the bottom up looking for any line that LOOKS like a
  // prompt line — heuristically: not blank, not a horizontal rule, and
  // not the status bar (which contains the static UI strings). The most
  // recent prompt line after a completed response should be the empty
  // one (Claude Code's "your turn again" cue).
  const lines = afterBuf.split('\n');
  let derivedEmptyPromptLine: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // Skip horizontal rule lines.
    if (/^[─━=_-]{5,}$/.test(trimmed)) continue;
    // Skip the status bar — recognized by containing one of the legacy idle markers.
    if (config.idleMarkers.some((m) => line.includes(m))) continue;
    // First non-blank, non-rule, non-status-bar line from the bottom is
    // our candidate for the empty-prompt line.
    derivedEmptyPromptLine = line;
    break;
  }

  // Step 7: does the existing signature detect completion on this pane?
  const existingSig = getSignature();
  const existingSignatureMatched = lines.some((l) => existingSig.emptyPromptPattern.test(l));

  if (existingSignatureMatched) {
    return {
      status: 'pass',
      message: 'canary passed; existing empty-prompt signature is valid',
      details: { responseContained7: true, existingSignatureMatched: true },
    };
  }

  // Step 8: re-derive. Try to extract a regex from the derived empty-prompt
  // line. The simplest robust thing: match the first non-whitespace char
  // as a literal, followed by optional whitespace to end of line.
  if (!derivedEmptyPromptLine) {
    return {
      status: 'fail',
      message:
        'response succeeded but no empty-prompt line could be derived from the after-buffer — '
        + 'upstream may have restructured its UI past recognition',
      details: {
        responseContained7: true,
        existingSignatureMatched: false,
        afterPaneTail: lines.slice(-15).join('\n'),
      },
    };
  }
  const firstChar = derivedEmptyPromptLine.trim()[0];
  if (!firstChar) {
    return {
      status: 'fail',
      message: 'derived empty-prompt line was effectively blank — cannot self-heal',
      details: {
        responseContained7: true,
        existingSignatureMatched: false,
        derivedEmptyPromptLine,
      },
    };
  }
  // Build new patterns from the derived char. The "empty" pattern matches
  // the char followed by only-whitespace; the "any prompt line" pattern
  // matches the char followed by either whitespace or EOL.
  const charEsc = firstChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const newSig: EmptyPromptSignature = {
    emptyPromptPattern: new RegExp(`^${charEsc}\\s*$`),
    anyPromptLinePattern: new RegExp(`^${charEsc}(\\s|$)`),
    source: 'canary-derived',
    derivedAt: new Date().toISOString(),
  };

  // Verify the new pattern actually matches the derived line and DOES NOT
  // match content lines (sanity-check against deriving a pattern that's
  // too permissive).
  if (!newSig.emptyPromptPattern.test(derivedEmptyPromptLine)) {
    return {
      status: 'fail',
      message: `derived pattern does not match its own derivation line: ${JSON.stringify(derivedEmptyPromptLine)}`,
      details: {
        responseContained7: true,
        existingSignatureMatched: false,
        derivedEmptyPromptLine,
        newSignature: newSig,
      },
    };
  }

  setSignature(newSig);
  return {
    status: 'self-healed',
    message: `empty-prompt signature re-derived from canary output; new prompt char detected: ${JSON.stringify(firstChar)}`,
    details: {
      responseContained7: true,
      existingSignatureMatched: false,
      derivedEmptyPromptLine,
      newSignature: newSig,
    },
  };
}
