/**
 * Integration Tests — Model Resolution Across Components
 *
 * Verifies that ClaudeCliIntelligenceProvider and StallTriageNurse correctly
 * resolve model tiers through the centralized dictionary (src/core/models.ts).
 *
 * Note: direct Anthropic API calls are forbidden per the provider-portability
 * path constraints (specs/provider-portability/04-anthropic-path-constraints.md).
 * The only sanctioned intelligence path is `claude -p`, so model resolution is
 * verified through the CLI args (`--model <flag>`) rather than HTTP bodies.
 */

import { describe, it, expect, vi } from 'vitest';
import { ANTHROPIC_MODELS, CLI_MODEL_FLAGS, resolveModelId } from '../../src/core/models.js';

// ─── ClaudeCliIntelligenceProvider Integration ──────────────

// Mock node:child_process.execFile so the provider doesn't actually shell out
// to `claude`. The fake invokes the callback with empty stdout to resolve the
// promise; the test inspects the args passed to execFile.
const execFileSpy = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    execFile: (...args: any[]) => {
      execFileSpy(...args);
      const cb = args[args.length - 1];
      // Return a stub with .stdin so the provider can call .stdin?.end()
      const stub = { stdin: { end: () => {} } };
      // Invoke the callback asynchronously with no error.
      setImmediate(() => cb(null, '', ''));
      return stub;
    },
  };
});

describe('ClaudeCliIntelligenceProvider + model dictionary', () => {
  it('resolves "fast" tier to haiku CLI flag', async () => {
    execFileSpy.mockClear();
    const { ClaudeCliIntelligenceProvider } = await import(
      '../../src/core/ClaudeCliIntelligenceProvider.js'
    );
    const provider = new ClaudeCliIntelligenceProvider('/usr/local/bin/claude');
    await provider.evaluate('test', { model: 'fast' });

    const args = execFileSpy.mock.calls[0][1] as string[];
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe(CLI_MODEL_FLAGS.haiku);
  });

  it('resolves "balanced" tier to sonnet CLI flag', async () => {
    execFileSpy.mockClear();
    const { ClaudeCliIntelligenceProvider } = await import(
      '../../src/core/ClaudeCliIntelligenceProvider.js'
    );
    const provider = new ClaudeCliIntelligenceProvider('/usr/local/bin/claude');
    await provider.evaluate('test', { model: 'balanced' });

    const args = execFileSpy.mock.calls[0][1] as string[];
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe(CLI_MODEL_FLAGS.sonnet);
  });

  it('resolves "capable" tier to opus CLI flag', async () => {
    execFileSpy.mockClear();
    const { ClaudeCliIntelligenceProvider } = await import(
      '../../src/core/ClaudeCliIntelligenceProvider.js'
    );
    const provider = new ClaudeCliIntelligenceProvider('/usr/local/bin/claude');
    await provider.evaluate('test', { model: 'capable' });

    const args = execFileSpy.mock.calls[0][1] as string[];
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe(CLI_MODEL_FLAGS.opus);
  });

  it('defaults to haiku (fast tier) when no model specified', async () => {
    execFileSpy.mockClear();
    const { ClaudeCliIntelligenceProvider } = await import(
      '../../src/core/ClaudeCliIntelligenceProvider.js'
    );
    const provider = new ClaudeCliIntelligenceProvider('/usr/local/bin/claude');
    await provider.evaluate('test');

    const args = execFileSpy.mock.calls[0][1] as string[];
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe(CLI_MODEL_FLAGS.haiku);
  });

  it('uses CLI flags from the centralized dictionary, not hardcoded values', async () => {
    const { ClaudeCliIntelligenceProvider } = await import(
      '../../src/core/ClaudeCliIntelligenceProvider.js'
    );
    const provider = new ClaudeCliIntelligenceProvider('/usr/local/bin/claude');

    for (const [tier, expectedFlag] of Object.entries({
      fast: CLI_MODEL_FLAGS.haiku,
      balanced: CLI_MODEL_FLAGS.sonnet,
      capable: CLI_MODEL_FLAGS.opus,
    })) {
      execFileSpy.mockClear();
      await provider.evaluate('test', { model: tier as any });
      const args = execFileSpy.mock.calls[0][1] as string[];
      const modelIdx = args.indexOf('--model');
      expect(args[modelIdx + 1]).toBe(expectedFlag);
    }
  });
});

// ─── StallTriageNurse Integration ──────────────────────────

describe('StallTriageNurse + model dictionary', () => {
  it('default config resolves "sonnet" tier to sonnet model ID', async () => {
    // The StallTriageNurse defaults to resolveModelId('sonnet')
    // This test verifies that the resolution produces the right model ID
    const resolved = resolveModelId('sonnet');
    expect(resolved).toBe(ANTHROPIC_MODELS.sonnet);
  });

  it('env var STALL_TRIAGE_MODEL accepts tier names', () => {
    // Test that tier names resolve correctly (simulating env var values)
    expect(resolveModelId('sonnet')).toBe(ANTHROPIC_MODELS.sonnet);
    expect(resolveModelId('haiku')).toBe(ANTHROPIC_MODELS.haiku);
    expect(resolveModelId('opus')).toBe(ANTHROPIC_MODELS.opus);
  });

  it('env var STALL_TRIAGE_MODEL accepts raw model IDs', () => {
    // Users can still pass raw model IDs via env var
    expect(resolveModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(resolveModelId('claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('StallTriageNurse constructor resolves tier names to model IDs', async () => {
    // Direct API access (callAnthropicApi) was removed when the nurse moved
    // to the IntelligenceProvider abstraction. The remaining surface for the
    // resolved model is the nurse's config — passing a tier name to the
    // constructor should yield the resolved model ID on the config object.
    const { StallTriageNurse } = await import(
      '../../src/monitoring/StallTriageNurse.js'
    );

    const deps = {
      captureSessionOutput: vi.fn().mockReturnValue('some output'),
      isSessionAlive: vi.fn().mockReturnValue(true),
      sendKey: vi.fn().mockReturnValue(true),
      sendInput: vi.fn().mockReturnValue(true),
      getTopicHistory: vi.fn().mockReturnValue([]),
      sendToTopic: vi.fn().mockResolvedValue({}),
      respawnSession: vi.fn().mockResolvedValue(undefined),
      clearStallForTopic: vi.fn(),
    };

    const nurse = new StallTriageNurse(deps, {
      config: { apiKey: 'test-key', model: 'haiku', useIntelligenceProvider: false },
    });

    // The nurse exposes its resolved config (the constructor calls
    // resolveModelId on the tier name).
    expect((nurse as any).config.model).toBe(ANTHROPIC_MODELS.haiku);
  });
});

// ─── Cross-Component Consistency ──────────────────────────

describe('model dictionary consistency across components', () => {
  it('all components resolve the same tier to the same model ID', () => {
    // The centralized dictionary ensures this — verify the contract
    const tiers = ['fast', 'balanced', 'capable', 'haiku', 'sonnet', 'opus'];

    for (const tier of tiers) {
      const resolved = resolveModelId(tier);
      // Every tier should resolve to a known ANTHROPIC_MODELS value
      expect(Object.values(ANTHROPIC_MODELS)).toContain(resolved);
    }
  });

  it('no dated model IDs appear in resolution results', () => {
    const tiers = ['fast', 'balanced', 'capable', 'haiku', 'sonnet', 'opus'];

    for (const tier of tiers) {
      const resolved = resolveModelId(tier);
      // Dated IDs have 8-digit suffixes like -20250929
      expect(resolved).not.toMatch(/-\d{8}$/);
    }
  });
});
