/**
 * Model-tier resolution for openai-codex.
 *
 * Maps the canonical ModelTier ('fast' | 'balanced' | 'capable') onto a
 * concrete OpenAI/Codex model name. Per the deep-dive (02-codex-deep-
 * dive.md), Codex uses `--model <name>` to select. ChatGPT-subscription
 * auth restricts available models; OPENAI_API_KEY mode opens the full
 * surface.
 */

import type { ModelTier } from '../../types.js';

/**
 * Default tier-to-name map. Callers can override per-call via
 * OneShotCompletionOptions.model or AgenticSessionHeadlessOptions.model
 * (which accepts either a tier name or a raw model name).
 */
const TIER_TO_MODEL: Record<ModelTier, string> = {
  fast: 'gpt-4o-mini',
  balanced: 'gpt-4o',
  capable: 'gpt-5-codex',
};

/**
 * Resolve a tier or raw model string to a concrete model name to pass to
 * the codex CLI. If `tierOrModel` doesn't match a known tier, it's
 * returned verbatim (treated as a raw model name).
 */
export function resolveCliModelFlag(tierOrModel: string | ModelTier | undefined): string {
  if (!tierOrModel) return TIER_TO_MODEL.balanced;
  if (tierOrModel in TIER_TO_MODEL) {
    return TIER_TO_MODEL[tierOrModel as ModelTier];
  }
  return tierOrModel;
}
