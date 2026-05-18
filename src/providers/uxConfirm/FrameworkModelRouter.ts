/**
 * FrameworkModelRouter — Phase 5b composition root.
 *
 * Wires together TaskClassifier, PreferenceStore, TriggerGate,
 * TelegramConfirmer, CostStateTracker, and the catalog into the
 * full suggest-and-confirm flow described in
 * `specs/provider-portability/10-suggest-and-confirm-ux.md`.
 *
 * The router answers the question: "given this task, what framework
 * and model should run it?" — emitting a structured `RouteResult`
 * that downstream routing (Phase 5c `CostAwareRoutingPolicy`) uses
 * to pick the concrete adapter.
 *
 * Locked behavior (per Justin's Telegram answers 2026-05-15):
 *   1. Telegram-only — non-Telegram origins auto-default with note.
 *   2. Sticky-yes with "(auto-picked X)" surfaced via `source: cached-silent`.
 *   3. Re-ask only on three triggers — implemented by `TriggerGate`.
 *   4. Override via slash OR inline phrasing — implemented by `TelegramConfirmer`.
 */

import type { CostStateTracker } from '../costAwareRouting.js';
import type { PreferenceStore, ConfidenceLevel, FrameworkModelPreference } from './PreferenceStore.js';
import type { TaskClassifier } from './TaskClassifier.js';
import type { TelegramConfirmer, ConfirmationReason } from './TelegramConfirmer.js';
import { runTriggerGate, type TriggerGateOutcome } from './TriggerGate.js';
import { UNCLASSIFIED_PATTERN } from './TaskClassifier.js';

// ---------------------------------------------------------------------------
// Catalog provider — Phase 5a fitness data, abstracted
// ---------------------------------------------------------------------------

/**
 * Abstract over the fitness catalogs Phase 5a produced. The router
 * doesn't read markdown — the catalog provider is the bridge.
 */
export interface CatalogProvider {
  /** Current catalog version. Bumps when fitness data changes meaningfully. */
  currentVersion(): string;
  /**
   * Default framework+model for a task pattern (used when the user
   * has no cached preference OR when reply times out). The catalog
   * provider picks based on whatever scoring it implements.
   */
  defaultFor(taskPattern: string): {
    framework: string;
    model: string;
    confidence: ConfidenceLevel;
  };
  /**
   * Catalog's current confidence for a specific (pattern, framework, model)
   * tuple. Used by the trigger gate to detect confidence-dropped triggers.
   */
  confidenceFor(taskPattern: string, framework: string, model: string): ConfidenceLevel;
}

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface RouteInput {
  /** Stable user identifier used as the cache key prefix. */
  userId: string;
  /** Full task prompt for classification. */
  taskPrompt: string;
  /** Optional classification bias tags. */
  taskTags?: ReadonlyArray<string>;
  /** Short description for the confirmation prompt's header. */
  taskDescription: string;
  /**
   * Telegram topic the task originated from. When null/undefined, the
   * router skips the UX entirely and returns the catalog default with
   * `source: auto-defaulted-no-topic` (background work, autonomous loops).
   */
  telegramTopicId?: string | null;
}

export type RouteSource =
  | 'cached-silent'              // cached preference, no trigger fired, used silently
  | 'confirmed'                  // user confirmed via prompt; cache updated
  | 'confirmed-one-shot'         // user confirmed but asked NOT to cache
  | 'overridden-this-task'       // user overrode to a different pick for this task only
  | 'overridden-this-pattern'    // user overrode AND asked to update cache
  | 'reset-defaulted'            // user cleared cache; this run uses catalog default
  | 'auto-defaulted-no-topic'    // no Telegram topic → no UX → catalog default
  | 'auto-defaulted-no-reply'    // timeout / no reply → catalog default with note
  | 'auto-defaulted-unclassified'; // classification failed → catalog default, no cache write

export interface RouteResult {
  framework: string;
  model: string;
  taskPattern: string;
  source: RouteSource;
  /**
   * The (framework, model) that the catalog reports as default for this
   * pattern, separately from the chosen pick. Used by the dashboard's
   * historical view + audit trail.
   */
  catalogDefault: { framework: string; model: string; confidence: ConfidenceLevel };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FrameworkModelRouterOptions {
  classifier: TaskClassifier;
  store: PreferenceStore;
  confirmer: TelegramConfirmer;
  costStateTracker: CostStateTracker;
  catalog: CatalogProvider;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function outcomeToReason(outcome: TriggerGateOutcome): ConfirmationReason | null {
  switch (outcome.kind) {
    case 'ask-new-pattern':
      return 'new-pattern';
    case 'ask-cost-shift':
      return 'cost-shift';
    case 'ask-low-confidence':
      return 'low-confidence';
    case 'silent-use':
      return null;
  }
}

function outcomeDetail(outcome: TriggerGateOutcome): string | undefined {
  if (outcome.kind === 'ask-cost-shift') return outcome.reason;
  if (outcome.kind === 'ask-low-confidence') return outcome.reason;
  return undefined;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class FrameworkModelRouter {
  private readonly classifier: TaskClassifier;
  private readonly store: PreferenceStore;
  private readonly confirmer: TelegramConfirmer;
  private readonly costStateTracker: CostStateTracker;
  private readonly catalog: CatalogProvider;

  constructor(options: FrameworkModelRouterOptions) {
    this.classifier = options.classifier;
    this.store = options.store;
    this.confirmer = options.confirmer;
    this.costStateTracker = options.costStateTracker;
    this.catalog = options.catalog;
  }

  async route(input: RouteInput): Promise<RouteResult> {
    // Step 1: classify
    const classifyResult = await this.classifier.classify({
      prompt: input.taskPrompt,
      tags: input.taskTags,
    });
    const taskPattern = classifyResult.taskPattern;

    // Get the catalog default for this pattern — needed for every code
    // path either as the chosen pick or for the audit trail.
    const catalogDefault = this.catalog.defaultFor(taskPattern);

    // Unclassified — short-circuit to default without writing cache.
    if (classifyResult.source === 'fallback') {
      return {
        framework: catalogDefault.framework,
        model: catalogDefault.model,
        taskPattern,
        source: 'auto-defaulted-unclassified',
        catalogDefault,
      };
    }

    // Step 2: non-Telegram origin → catalog default, skip UX.
    if (!input.telegramTopicId) {
      return {
        framework: catalogDefault.framework,
        model: catalogDefault.model,
        taskPattern,
        source: 'auto-defaulted-no-topic',
        catalogDefault,
      };
    }

    // Step 3: look up cached preference + current state.
    const cached = this.store.get(input.userId, taskPattern);
    const currentCostState = await this.costStateTracker.snapshot();
    const currentCatalogVersion = this.catalog.currentVersion();
    const currentConfidence = cached
      ? this.catalog.confidenceFor(taskPattern, cached.framework, cached.model)
      : undefined;

    // Step 4: run the gate.
    const outcome = runTriggerGate({
      cached,
      currentCostState,
      currentCatalogVersion,
      currentConfidence,
      costStateTracker: this.costStateTracker,
    });

    if (outcome.kind === 'silent-use') {
      return {
        framework: outcome.preference.framework,
        model: outcome.preference.model,
        taskPattern,
        source: 'cached-silent',
        catalogDefault,
      };
    }

    // Step 5: gate fired — invoke the confirmer.
    const reason = outcomeToReason(outcome);
    if (reason === null) {
      // Defensive — TS narrows but be explicit.
      return {
        framework: catalogDefault.framework,
        model: catalogDefault.model,
        taskPattern,
        source: 'auto-defaulted-unclassified',
        catalogDefault,
      };
    }

    const confirmation = await this.confirmer.confirm({
      topicId: input.telegramTopicId,
      taskDescription: input.taskDescription,
      taskPattern,
      proposedFramework: catalogDefault.framework,
      proposedModel: catalogDefault.model,
      confidence: catalogDefault.confidence,
      reason,
      ...(outcomeDetail(outcome) !== undefined ? { reasonDetail: outcomeDetail(outcome)! } : {}),
    });

    // Step 6: apply the result.
    switch (confirmation.kind) {
      case 'confirmed': {
        if (confirmation.cache) {
          this.writeCache(input.userId, taskPattern, {
            framework: confirmation.framework,
            model: confirmation.model,
            confirmedAt: new Date().toISOString(),
            costStateSnapshot: currentCostState,
            catalogVersionAtCache: currentCatalogVersion,
            confidenceAtCache: this.catalog.confidenceFor(
              taskPattern,
              confirmation.framework,
              confirmation.model,
            ),
          });
          return {
            framework: confirmation.framework,
            model: confirmation.model,
            taskPattern,
            source: 'confirmed',
            catalogDefault,
          };
        }
        return {
          framework: confirmation.framework,
          model: confirmation.model,
          taskPattern,
          source: 'confirmed-one-shot',
          catalogDefault,
        };
      }

      case 'overridden': {
        // Decide on chosen framework / model. If the user didn't name
        // specifics, fall back to the catalog default for them.
        const framework = confirmation.framework ?? catalogDefault.framework;
        const model = confirmation.model ?? catalogDefault.model;
        if (confirmation.scope === 'this-pattern') {
          this.writeCache(input.userId, taskPattern, {
            framework,
            model,
            confirmedAt: new Date().toISOString(),
            costStateSnapshot: currentCostState,
            catalogVersionAtCache: currentCatalogVersion,
            confidenceAtCache: this.catalog.confidenceFor(taskPattern, framework, model),
          });
          return {
            framework,
            model,
            taskPattern,
            source: 'overridden-this-pattern',
            catalogDefault,
          };
        }
        return {
          framework,
          model,
          taskPattern,
          source: 'overridden-this-task',
          catalogDefault,
        };
      }

      case 'reset': {
        this.store.clear(input.userId, taskPattern);
        return {
          framework: catalogDefault.framework,
          model: catalogDefault.model,
          taskPattern,
          source: 'reset-defaulted',
          catalogDefault,
        };
      }

      case 'default-no-reply': {
        return {
          framework: catalogDefault.framework,
          model: catalogDefault.model,
          taskPattern,
          source: 'auto-defaulted-no-reply',
          catalogDefault,
        };
      }
    }
  }

  private writeCache(
    userId: string,
    taskPattern: string,
    preference: FrameworkModelPreference,
  ): void {
    this.store.set(userId, taskPattern, preference);
  }
}
