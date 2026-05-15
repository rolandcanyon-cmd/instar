/**
 * UsageMeterProvider: poll Anthropic OAuth usage API.
 *
 * Authoritative source: GET /api/oauth/usage and GET /api/oauth/profile
 * on api.anthropic.com. Requires CLAUDE_CODE_OAUTH_TOKEN (sk-ant-oat...).
 *
 * Phase 3a returns subscription-tier windows. The agentSdkCredit field is
 * populated when the API exposes it (post-2026-06-15 — pending discovery
 * of the exact endpoint Anthropic provides for the credit pot balance).
 */

import type {
  UsageMeterProvider,
  UsageSnapshot,
  UsageWindow,
} from '../../../primitives/observability/usageMeterProvider.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { AuthError } from '../../../errors.js';
import type { AnthropicHeadlessConfig } from '../config.js';
import { ANTHROPIC_HEADLESS_ID } from '../errors.js';

class AnthropicHeadlessUsageMeterProvider implements UsageMeterProvider {
  readonly capability = CapabilityFlag.UsageMeterProvider;

  constructor(private readonly config: AnthropicHeadlessConfig) {}

  isAuthoritative(): boolean {
    return true;
  }

  async read(): Promise<UsageSnapshot | null> {
    if (!this.config.credential || !this.config.credential.startsWith('sk-ant-oat')) {
      // OAuth usage API requires OAuth subscription token.
      return null;
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.credential}`,
      'anthropic-version': '2023-06-01',
    };
    let usageBody: Record<string, unknown> | null = null;
    try {
      const response = await fetch('https://api.anthropic.com/api/oauth/usage', { headers });
      if (response.ok) {
        usageBody = (await response.json()) as Record<string, unknown>;
      } else if (response.status === 401 || response.status === 403) {
        throw new AuthError(`Usage API returned ${response.status}`, ANTHROPIC_HEADLESS_ID);
      }
    } catch (err) {
      if (err instanceof AuthError) throw err;
      // Network failure: fall through; return null
      return null;
    }

    const windows: UsageWindow[] = [];
    if (usageBody) {
      // Map common shapes — Anthropic's API includes per-window data
      const win5h = usageBody['five_hour_window'] as
        | { used_percent?: number; resets_at?: string }
        | undefined;
      if (win5h) {
        windows.push({
          granularity: '5-hour',
          resetsAt: String(win5h.resets_at ?? new Date(Date.now() + 5 * 3600_000).toISOString()),
          usedPercent: Number(win5h.used_percent ?? 0),
        });
      }
      const winWeek = usageBody['weekly_window'] as
        | { used_percent?: number; resets_at?: string }
        | undefined;
      if (winWeek) {
        windows.push({
          granularity: 'week',
          resetsAt: String(winWeek.resets_at ?? new Date(Date.now() + 7 * 86400_000).toISOString()),
          usedPercent: Number(winWeek.used_percent ?? 0),
        });
      }
    }

    return {
      capturedAt: new Date().toISOString(),
      source: 'authoritative',
      windows,
      agentSdkCredit: null, // populated once Anthropic exposes credit balance API
    };
  }
}

export function createUsageMeterProvider(
  config: AnthropicHeadlessConfig,
): UsageMeterProvider {
  return new AnthropicHeadlessUsageMeterProvider(config);
}
