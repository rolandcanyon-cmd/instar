/**
 * AnthropicIntelligenceProvider — OPTIONAL IntelligenceProvider using the Anthropic Messages API.
 *
 * ⚠️  This provider uses API tokens (extra cost). For most Instar agents, the
 * ClaudeCliIntelligenceProvider (which uses the Claude subscription) is the
 * correct default. Only use this provider when:
 *   - The user explicitly sets intelligenceProvider: "anthropic-api" in config
 *   - The Claude CLI is not available
 *   - The user has a specific reason to prefer direct API access
 *
 * No SDK dependency — direct fetch calls, following the TelegramAdapter pattern.
 */

import type { IntelligenceProvider, IntelligenceOptions } from './types.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';

/** Model mapping: abstract tiers → concrete Anthropic model IDs */
const MODEL_MAP: Record<string, string> = {
  fast: 'claude-haiku-4-5-20251001',
  balanced: 'claude-sonnet-4-5-20250514',
  capable: 'claude-opus-4-0-20250514',
};

const DEFAULT_MODEL = 'fast';

export class AnthropicIntelligenceProvider implements IntelligenceProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Create a provider from environment variables, or null if no key available.
   * Follows the same graceful degradation pattern as TelegramAdapter's voice providers.
   */
  static fromEnv(): AnthropicIntelligenceProvider | null {
    const apiKey = process.env['ANTHROPIC_API_KEY']?.trim();
    if (!apiKey) {
      return null;
    }
    return new AnthropicIntelligenceProvider(apiKey);
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    const model = MODEL_MAP[options?.model ?? DEFAULT_MODEL] ?? MODEL_MAP[DEFAULT_MODEL];
    const maxTokens = options?.maxTokens ?? 100;
    const temperature = options?.temperature ?? 0;

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text?: string }>;
    };

    // Extract text from the response
    const textBlock = data.content?.find((block) => block.type === 'text');
    return textBlock?.text ?? '';
  }
}
