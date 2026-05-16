/**
 * intelligenceProviderFactory — pick the right IntelligenceProvider
 * implementation for a configured framework.
 *
 * Provider-portability v1.0.0: until v0.x, ClaudeCliIntelligenceProvider
 * was the ONLY implementation, and every reviewer/sentinel/canary
 * routed through `claude -p`. This factory lets the composition root
 * pick `claude-code`, `codex-cli`, or another framework's implementation
 * at startup based on `INSTAR_FRAMEWORK` env var or the agent's
 * configured `primaryFramework`.
 *
 * When the configured framework's binary isn't installed, the factory
 * returns null. The composition root decides whether that's a fatal
 * error or a "fall back to whatever IS installed" situation.
 */

import type { IntelligenceProvider } from './types.js';
import { detectClaudePath, detectCodexPath } from './Config.js';
import { ClaudeCliIntelligenceProvider } from './ClaudeCliIntelligenceProvider.js';
import { CodexCliIntelligenceProvider } from './CodexCliIntelligenceProvider.js';

/**
 * Stable framework identifiers the factory recognizes. Adding a new
 * framework requires (a) extending this union and (b) wiring up a case
 * in `buildIntelligenceProvider`.
 */
/**
 * Stable framework identifiers.
 *
 * `claude-code` — Claude Code CLI in interactive subscription mode
 *   (OAuth token from `claude login`; default).
 *
 * `claude-code-agent-sdk` — Same Claude Code CLI, but the spawn path
 *   forces `ANTHROPIC_API_KEY` auth (clearing OAuth) so usage bills
 *   against the separate Anthropic Agent SDK $200/mo Max 20x credit
 *   bucket per the June 2026 billing notice. Same binary, different
 *   billing pool.
 *
 * `codex-cli` — OpenAI Codex CLI.
 *
 * Adding a new framework requires (a) extending this union and
 * (b) wiring up a case in `buildIntelligenceProvider` AND in the
 * `frameworkSessionLaunch` builders.
 */
export type IntelligenceFramework = 'claude-code' | 'claude-code-agent-sdk' | 'codex-cli';

export interface BuildIntelligenceProviderOptions {
  /**
   * Which framework's CLI to route through. Defaults to 'claude-code'
   * for backwards-compat — v0.x behavior is preserved when the field
   * is unset.
   */
  framework?: IntelligenceFramework;
  /**
   * Explicit binary path override. When unset, detection runs.
   */
  binaryPath?: string;
  /**
   * Optional working directory (currently used only by Codex).
   */
  workingDirectory?: string;
}

/**
 * Build an IntelligenceProvider for the given framework. Returns null
 * if the required binary can't be located. The caller decides what
 * happens next — fatal error, fall-back to a different framework, or
 * disable LLM-backed paths entirely.
 *
 * @example
 *   const intel = buildIntelligenceProvider({ framework: 'codex-cli' });
 *   if (intel === null) {
 *     console.warn('Codex CLI not found — LLM-backed paths disabled.');
 *   }
 */
export function buildIntelligenceProvider(
  options: BuildIntelligenceProviderOptions = {},
): IntelligenceProvider | null {
  const framework = options.framework ?? 'claude-code';

  switch (framework) {
    case 'claude-code':
    case 'claude-code-agent-sdk': {
      // Both Claude framework variants share the same IntelligenceProvider
      // implementation — the variant only changes the SESSION SPAWN credential
      // pathway (OAuth vs API key), not the reviewer/sentinel evaluator path.
      // Reviewers always run through the local `claude` binary via subscription
      // (cheap, fast, already cached).
      const path = options.binaryPath ?? detectClaudePath();
      if (!path) return null;
      return new ClaudeCliIntelligenceProvider(path);
    }
    case 'codex-cli': {
      const path = options.binaryPath ?? detectCodexPath();
      if (!path) return null;
      return new CodexCliIntelligenceProvider({
        codexPath: path,
        ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
      });
    }
    default: {
      // Exhaustiveness check — extending IntelligenceFramework without
      // adding a case here is a type error.
      const _exhaustive: never = framework;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Convenience: read the framework selection from the environment.
 * Returns null when no framework is explicitly selected, leaving
 * the caller to apply the default (`claude-code`) or its own logic.
 */
export function frameworkFromEnv(env: NodeJS.ProcessEnv = process.env): IntelligenceFramework | null {
  const raw = env['INSTAR_FRAMEWORK']?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'claude-code' || raw === 'claude') return 'claude-code';
  if (raw === 'claude-code-agent-sdk' || raw === 'agent-sdk' || raw === 'claude-agent-sdk') return 'claude-code-agent-sdk';
  if (raw === 'codex-cli' || raw === 'codex') return 'codex-cli';
  return null;
}
