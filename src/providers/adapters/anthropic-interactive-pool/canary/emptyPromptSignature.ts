/**
 * Empty-prompt detector signature store.
 *
 * The completion-detector in promptRunner.ts reads from here to decide
 * what to look for in the bottom of the pane buffer when checking
 * whether Claude Code is at a ready prompt. The default pattern matches
 * Claude Code's current `❯` glyph; the canary (see {@link emptyPromptCanary})
 * can re-derive the pattern at startup if the upstream UI evolves and
 * persist the new signature.
 *
 * Per Rule 3 of the path constraints (see specs/provider-portability/
 * 05-state-detection-robustness.md): deterministic state-detection code
 * against an evolving upstream must self-heal rather than silently fail.
 * This module is the substrate for that self-heal on the empty-prompt
 * detector specifically.
 */

/** Default signature — matches Claude Code as of 2026-05-15. */
const DEFAULT_PATTERN = /^❯\s*$/;
const DEFAULT_PROMPT_LINE_PATTERN = /^❯(\s|$)/;

export type SignatureSource = 'default' | 'canary-derived';

export interface EmptyPromptSignature {
  /** Regex matching an empty (ready-state) prompt line. */
  emptyPromptPattern: RegExp;
  /** Regex matching ANY prompt line (empty or with content) — used to find the most recent prompt line. */
  anyPromptLinePattern: RegExp;
  /** Where this signature came from. */
  source: SignatureSource;
  /** When this signature was derived (ISO timestamp). */
  derivedAt: string;
}

let current: EmptyPromptSignature = {
  emptyPromptPattern: DEFAULT_PATTERN,
  anyPromptLinePattern: DEFAULT_PROMPT_LINE_PATTERN,
  source: 'default',
  derivedAt: new Date(0).toISOString(),
};

/** Read the currently-active signature. The completion detector calls this. */
export function getSignature(): EmptyPromptSignature {
  return current;
}

/**
 * Replace the active signature. Called by the canary when it derives a
 * new pattern from a known input/output pair. Persistence (writing to
 * disk so future startups inherit the derived signature) is a follow-up;
 * the in-process store is sufficient for the canary-at-startup case.
 */
export function setSignature(sig: Omit<EmptyPromptSignature, 'derivedAt'>): void {
  current = { ...sig, derivedAt: new Date().toISOString() };
}

/** Test helper — reset to default. */
export function resetSignatureForTests(): void {
  current = {
    emptyPromptPattern: DEFAULT_PATTERN,
    anyPromptLinePattern: DEFAULT_PROMPT_LINE_PATTERN,
    source: 'default',
    derivedAt: new Date(0).toISOString(),
  };
}
