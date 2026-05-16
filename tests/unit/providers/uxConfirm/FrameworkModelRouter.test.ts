/**
 * Unit tests for FrameworkModelRouter (Phase 5b.4 — composition root).
 *
 * Verifies every flow path: cached-silent, confirmed (cache + one-shot),
 * overridden (this-task + this-pattern), reset, default-no-reply,
 * no-topic, unclassified. Uses real (in-memory) PreferenceStore +
 * CostStateTracker; stubs for TaskClassifier, TelegramConfirmer,
 * and CatalogProvider so each path is deterministic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  FrameworkModelRouter,
  type CatalogProvider,
  type RouteInput,
} from '../../../../src/providers/uxConfirm/FrameworkModelRouter.js';
import {
  PreferenceStore,
  type FrameworkModelPreference,
} from '../../../../src/providers/uxConfirm/PreferenceStore.js';
import { CostStateTracker } from '../../../../src/providers/costAwareRouting.js';
import { TaskClassifier, UNCLASSIFIED_PATTERN } from '../../../../src/providers/uxConfirm/TaskClassifier.js';
import {
  TelegramConfirmer,
  type ConfirmationResult,
  type ConfirmationTransport,
} from '../../../../src/providers/uxConfirm/TelegramConfirmer.js';
import { OverrideDetector } from '../../../../src/providers/uxConfirm/OverrideDetector.js';
import type { IntelligenceProvider } from '../../../../src/core/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PATTERN = 'code-refactor-typescript';
const USER = 'justin';
const TOPIC = '9984';

function makeCatalog(): CatalogProvider {
  return {
    currentVersion: () => 'v0.1',
    defaultFor: () => ({
      framework: 'claude-code',
      model: 'opus-4.7',
      confidence: 'HIGH',
    }),
    confidenceFor: () => 'HIGH',
  };
}

function makeClassifier(slug: string): TaskClassifier {
  return new TaskClassifier({
    intelligence: { evaluate: async () => slug },
  });
}

function stubConfirmer(result: ConfirmationResult): TelegramConfirmer {
  const transport: ConfirmationTransport = {
    send: async () => {},
    awaitReply: async () => null,
  };
  const detector = new OverrideDetector({
    intelligence: { evaluate: async () => '{"override":false}' },
    knownFrameworks: ['claude-code', 'codex-cli'],
    knownModels: ['opus-4.7', 'gemini'],
  });
  const c = new TelegramConfirmer({ transport, overrideDetector: detector });
  // Override confirm to return the stub result directly.
  c.confirm = vi.fn(async () => result);
  return c;
}

function makeRouter(opts: {
  classifierSlug?: string;
  classifierFailure?: boolean;
  confirmation?: ConfirmationResult;
  catalog?: CatalogProvider;
  store?: PreferenceStore;
}): { router: FrameworkModelRouter; store: PreferenceStore } {
  const store = opts.store ?? new PreferenceStore({ dbPath: ':memory:' });
  const classifier = opts.classifierFailure
    ? new TaskClassifier({
        intelligence: {
          evaluate: async () => {
            throw new Error('upstream down');
          },
        },
      })
    : makeClassifier(opts.classifierSlug ?? PATTERN);
  const costStateTracker = new CostStateTracker({
    readSdkCredit: async () => null,
  });
  const confirmer = stubConfirmer(opts.confirmation ?? { kind: 'default-no-reply' });
  const catalog = opts.catalog ?? makeCatalog();
  return {
    router: new FrameworkModelRouter({ classifier, store, confirmer, costStateTracker, catalog }),
    store,
  };
}

const INPUT: RouteInput = {
  userId: USER,
  taskPrompt: 'refactor the imessage adapter to use the new transport',
  taskDescription: 'refactor imessage adapter',
  telegramTopicId: TOPIC,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FrameworkModelRouter — auto-default paths', () => {
  it('returns catalog default with source=auto-defaulted-no-topic when telegramTopicId is null', async () => {
    const { router } = makeRouter({});
    const result = await router.route({ ...INPUT, telegramTopicId: null });
    expect(result.source).toBe('auto-defaulted-no-topic');
    expect(result.framework).toBe('claude-code');
    expect(result.model).toBe('opus-4.7');
  });

  it('returns catalog default with source=auto-defaulted-no-topic when telegramTopicId is undefined', async () => {
    const { router } = makeRouter({});
    const result = await router.route({
      userId: USER,
      taskPrompt: 'whatever',
      taskDescription: 'whatever',
    });
    expect(result.source).toBe('auto-defaulted-no-topic');
  });

  it('returns auto-defaulted-unclassified when the classifier throws / fails', async () => {
    const { router, store } = makeRouter({ classifierFailure: true });
    const result = await router.route(INPUT);
    expect(result.source).toBe('auto-defaulted-unclassified');
    expect(result.taskPattern).toBe(UNCLASSIFIED_PATTERN);
    // Cache should NOT be written for an unclassified pattern.
    expect(store.get(USER, UNCLASSIFIED_PATTERN)).toBeNull();
  });

  it('returns auto-defaulted-no-reply when the confirmer times out', async () => {
    const { router } = makeRouter({
      confirmation: { kind: 'default-no-reply' },
    });
    const result = await router.route(INPUT);
    expect(result.source).toBe('auto-defaulted-no-reply');
  });
});

describe('FrameworkModelRouter — cached-silent path', () => {
  it('uses cached preference when gate returns silent-use', async () => {
    const store = new PreferenceStore({ dbPath: ':memory:' });
    const pref: FrameworkModelPreference = {
      framework: 'codex-cli',
      model: 'gpt-5.3-codex',
      confirmedAt: '2026-05-15T00:00:00Z',
      costStateSnapshot: { capturedAt: '2026-05-15T00:00:00Z', agentSdkCredit: null },
      catalogVersionAtCache: 'v0.1', // matches catalog
      confidenceAtCache: 'HIGH',
    };
    store.set(USER, PATTERN, pref);

    const { router } = makeRouter({ store });
    const result = await router.route(INPUT);
    expect(result.source).toBe('cached-silent');
    expect(result.framework).toBe('codex-cli');
    expect(result.model).toBe('gpt-5.3-codex');
  });

  it('always populates catalogDefault for audit trail even on cached-silent', async () => {
    const store = new PreferenceStore({ dbPath: ':memory:' });
    store.set(USER, PATTERN, {
      framework: 'codex-cli',
      model: 'gpt-5.3-codex',
      confirmedAt: '2026-05-15T00:00:00Z',
      costStateSnapshot: { capturedAt: '2026-05-15T00:00:00Z', agentSdkCredit: null },
      catalogVersionAtCache: 'v0.1',
      confidenceAtCache: 'HIGH',
    });
    const { router } = makeRouter({ store });
    const result = await router.route(INPUT);
    expect(result.catalogDefault).toEqual({
      framework: 'claude-code',
      model: 'opus-4.7',
      confidence: 'HIGH',
    });
  });
});

describe('FrameworkModelRouter — confirmed paths', () => {
  it('returns source=confirmed and writes cache when user confirms with cache', async () => {
    const { router, store } = makeRouter({
      confirmation: {
        kind: 'confirmed',
        cache: true,
        framework: 'claude-code',
        model: 'opus-4.7',
      },
    });
    const result = await router.route(INPUT);
    expect(result.source).toBe('confirmed');
    const cached = store.get(USER, PATTERN);
    expect(cached?.framework).toBe('claude-code');
    expect(cached?.model).toBe('opus-4.7');
  });

  it('returns source=confirmed-one-shot and does NOT write cache when user picks one-shot', async () => {
    const { router, store } = makeRouter({
      confirmation: {
        kind: 'confirmed',
        cache: false,
        framework: 'claude-code',
        model: 'opus-4.7',
      },
    });
    const result = await router.route(INPUT);
    expect(result.source).toBe('confirmed-one-shot');
    expect(store.get(USER, PATTERN)).toBeNull();
  });
});

describe('FrameworkModelRouter — overridden paths', () => {
  it('returns source=overridden-this-task without writing cache', async () => {
    const { router, store } = makeRouter({
      confirmation: {
        kind: 'overridden',
        scope: 'this-task',
        model: 'gemini',
      },
    });
    const result = await router.route(INPUT);
    expect(result.source).toBe('overridden-this-task');
    expect(result.model).toBe('gemini');
    // Override missing framework — falls back to catalog default.
    expect(result.framework).toBe('claude-code');
    expect(store.get(USER, PATTERN)).toBeNull();
  });

  it('returns source=overridden-this-pattern and writes cache', async () => {
    const { router, store } = makeRouter({
      confirmation: {
        kind: 'overridden',
        scope: 'this-pattern',
        framework: 'codex-cli',
      },
    });
    const result = await router.route(INPUT);
    expect(result.source).toBe('overridden-this-pattern');
    expect(result.framework).toBe('codex-cli');
    expect(result.model).toBe('opus-4.7'); // catalog default
    const cached = store.get(USER, PATTERN);
    expect(cached?.framework).toBe('codex-cli');
    expect(cached?.model).toBe('opus-4.7');
  });

  it('overridden with no named pick falls back to catalog default for both fields', async () => {
    const { router } = makeRouter({
      confirmation: { kind: 'overridden', scope: 'this-task' },
    });
    const result = await router.route(INPUT);
    expect(result.framework).toBe('claude-code');
    expect(result.model).toBe('opus-4.7');
  });
});

describe('FrameworkModelRouter — reset path', () => {
  it('clears the cached preference and returns catalog default with source=reset-defaulted', async () => {
    const store = new PreferenceStore({ dbPath: ':memory:' });
    store.set(USER, PATTERN, {
      framework: 'codex-cli',
      model: 'gpt-5.3-codex',
      confirmedAt: '2026-05-15T00:00:00Z',
      costStateSnapshot: { capturedAt: '2026-05-15T00:00:00Z', agentSdkCredit: null },
      catalogVersionAtCache: 'v0.0', // mismatched to force version bump
      confidenceAtCache: 'HIGH',
    });
    // Catalog must report LOW confidence to fire ask-low-confidence
    // (version bumped + current confidence is LOW).
    const lowConfidenceCatalog: CatalogProvider = {
      currentVersion: () => 'v0.1',
      defaultFor: () => ({ framework: 'claude-code', model: 'opus-4.7', confidence: 'HIGH' }),
      confidenceFor: () => 'LOW',
    };
    const { router } = makeRouter({
      store,
      catalog: lowConfidenceCatalog,
      confirmation: { kind: 'reset' },
    });
    const result = await router.route(INPUT);
    expect(result.source).toBe('reset-defaulted');
    expect(result.framework).toBe('claude-code');
    expect(store.get(USER, PATTERN)).toBeNull();
  });
});

describe('FrameworkModelRouter — confirmer is called with right inputs', () => {
  it('passes the catalog default as the proposed pick and the right reason', async () => {
    const confirm = vi.fn(async () => ({ kind: 'default-no-reply' as const }));
    const store = new PreferenceStore({ dbPath: ':memory:' });
    const costStateTracker = new CostStateTracker({ readSdkCredit: async () => null });

    const classifier = makeClassifier(PATTERN);

    const transport: ConfirmationTransport = {
      send: async () => {},
      awaitReply: async () => null,
    };
    const detector = new OverrideDetector({
      intelligence: { evaluate: async () => '{"override":false}' },
      knownFrameworks: [],
      knownModels: [],
    });
    const confirmer = new TelegramConfirmer({ transport, overrideDetector: detector });
    (confirmer as any).confirm = confirm;

    const router = new FrameworkModelRouter({
      classifier, store, confirmer, costStateTracker, catalog: makeCatalog(),
    });

    await router.route(INPUT);

    const promptArg = confirm.mock.calls[0]?.[0];
    expect(promptArg).toBeDefined();
    expect(promptArg!.proposedFramework).toBe('claude-code');
    expect(promptArg!.proposedModel).toBe('opus-4.7');
    expect(promptArg!.confidence).toBe('HIGH');
    expect(promptArg!.reason).toBe('new-pattern'); // no cached pref → new-pattern
    expect(promptArg!.taskPattern).toBe(PATTERN);
    expect(promptArg!.topicId).toBe(TOPIC);
  });
});
