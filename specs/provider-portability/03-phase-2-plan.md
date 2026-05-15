# Phase 2 Plan — Interface Design & Conformance Test Suite

**Status:** Active (2026-05-14)
**Branch:** `spec/provider-portability`
**Prerequisite:** Phase 1 foundation complete, Codex deep-dive complete, feasibility prototype passed.

---

## ELI16 Overview

Phase 1 told us *what* needs to be abstracted — 51 primitives across five layers. Phase 2 turns those 51 primitives into actual TypeScript interface files that adapters will implement, plus a test suite that defines what "correctly implementing" each primitive means in a provider-agnostic way. No adapter code lands in Phase 2. Just contracts and the conformance tests that any adapter must pass.

The output of Phase 2 is:
1. `src/providers/primitives/*.ts` — one interface file per primitive (51 files).
2. `src/providers/events.ts` — canonical Instar event vocabulary that adapters normalize to.
3. `src/providers/capabilities.ts` — capability-flag types and discovery.
4. `src/providers/registry.ts` — runtime adapter discovery and selection.
5. `src/providers/routing.ts` — routing-policy interface (the *interface* — actual policies are Phase 5).
6. `src/providers/conformance/*.ts` — test suites per primitive that any adapter must pass.
7. `src/providers/types.ts` — shared cross-primitive types (session handle, provider id, capability flag enum, etc.).

When Phase 2 finishes, you can't actually use Instar against a new provider yet — there are no adapters. But you can compile the existing Anthropic code against the new interfaces (Phase 3a), and any contributor wanting to add a Codex adapter has a complete contract to implement against.

---

## Interface organization

Directory layout under `src/providers/`:

```
src/providers/
├── README.md                       # Overview, how to add a new provider
├── types.ts                        # Shared types (ProviderId, SessionHandle, CapabilityFlag, …)
├── events.ts                       # Canonical event vocabulary
├── capabilities.ts                 # Capability flag enum + discovery API
├── registry.ts                     # Runtime adapter registry
├── routing.ts                      # RoutingPolicy interface (no concrete policies)
├── errors.ts                       # Shared error types
├── primitives/
│   ├── index.ts                    # Barrel export
│   ├── transport/
│   │   ├── oneShotCompletion.ts
│   │   ├── structuredOneShot.ts
│   │   ├── agenticSessionHeadless.ts
│   │   ├── agenticSessionInteractive.ts
│   │   ├── warmSessionInbox.ts
│   │   └── agenticSessionRpc.ts
│   ├── capability/
│   │   ├── toolAccess.ts
│   │   ├── toolAllowlist.ts
│   │   ├── fileSystemAccess.ts
│   │   ├── pathAllowlist.ts
│   │   ├── bashExecution.ts
│   │   └── webAccess.ts
│   ├── observability/
│   │   ├── liveOutputStream.ts
│   │   ├── conversationLogReader.ts
│   │   ├── conversationLogTailer.ts
│   │   ├── hookEventReceiver.ts
│   │   ├── subagentLifecycleObserver.ts
│   │   ├── sessionId.ts
│   │   ├── usageMeterProvider.ts
│   │   ├── processLifecycle.ts
│   │   └── interactivePromptObserver.ts
│   ├── control/
│   │   ├── inputInjection.ts
│   │   ├── hardKill.ts
│   │   ├── interrupt.ts
│   │   ├── stopGateInterceptor.ts
│   │   ├── timeoutBound.ts
│   │   ├── idleBound.ts
│   │   ├── authCredentialInjection.ts
│   │   ├── credentialStorageProvider.ts
│   │   ├── contextScopeControl.ts
│   │   ├── compactionLifecycle.ts
│   │   └── intelligenceCallQueue.ts
│   ├── integration/
│   │   ├── providerScaffolder.ts
│   │   ├── mcpToolRegistry.ts
│   │   ├── sessionResumeIndex.ts
│   │   └── conversationLogProvider.ts
│   └── optional/
│       ├── threadFork.ts
│       ├── threadRollback.ts
│       ├── threadGoalSlot.ts
│       ├── profileSwitcher.ts
│       ├── customModelProvider.ts
│       ├── shellEnvironmentPolicy.ts
│       ├── otelExporter.ts
│       ├── complianceApi.ts
│       ├── pluginRegistry.ts
│       ├── filesystemRpc.ts
│       ├── processSpawn.ts
│       ├── capabilityNegotiation.ts
│       ├── notificationOptOut.ts
│       ├── codeReviewPreset.ts
│       ├── csvBatchMode.ts
│       ├── selfUpdate.ts
│       ├── trustedProjectGate.ts
│       └── requirementsToml.ts
└── conformance/
    ├── index.ts                    # Test runner entry point
    ├── runner.ts                   # Shared test infrastructure
    ├── transport/
    │   └── (one .test.ts per primitive)
    ├── capability/
    ├── observability/
    ├── control/
    ├── integration/
    └── optional/                   # Tests for optional primitives — skipped when capability absent
```

Each primitive interface file follows the same shape:

```ts
// src/providers/primitives/transport/oneShotCompletion.ts

import type { CapabilityFlag } from '../../capabilities.js';
import type { CanonicalEvent } from '../../events.js';

/**
 * One-shot completion: single prompt → single response, no tools.
 *
 * Used for: lightweight judgment calls (classification, routing, scoring).
 * Maps to: Claude's `claude -p`, OpenAI's Responses API.
 */
export interface OneShotCompletion {
  readonly capability: CapabilityFlag.OneShotCompletion;
  evaluate(prompt: string, options?: OneShotOptions): Promise<OneShotResult>;
}

export interface OneShotOptions {
  /** Model tier — provider maps to its own model IDs. */
  model?: 'fast' | 'balanced' | 'capable';
  /** Maximum tokens for the response. */
  maxTokens?: number;
  /** Temperature 0-1. */
  temperature?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Optional timeout in ms; provider enforces. */
  timeoutMs?: number;
}

export interface OneShotResult {
  text: string;
  /** Provider-reported usage if available; null if provider doesn't expose. */
  usage: UsageReport | null;
  /** Adapter-specific extension fields. */
  providerSpecific?: Record<string, unknown>;
}

export interface UsageReport {
  inputTokens: number;
  outputTokens: number;
  /** Cached tokens if provider reports separately (Anthropic's prompt cache, OpenAI's cached prefix). */
  cachedTokens?: number;
}
```

And each conformance test file:

```ts
// src/providers/conformance/transport/oneShotCompletion.test.ts

import { describe, it, expect } from 'vitest';
import type { OneShotCompletion } from '../../primitives/transport/oneShotCompletion.js';

export function runOneShotCompletionConformance(
  factory: () => OneShotCompletion,
  ctx: ConformanceContext,
) {
  describe('OneShotCompletion conformance', () => {
    it('returns text for a simple prompt', async () => {
      const subject = factory();
      const result = await subject.evaluate('Reply with exactly: HELLO');
      expect(result.text.trim()).toBe('HELLO');
    });

    it('honors abort signal', async () => {
      const subject = factory();
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 100);
      await expect(
        subject.evaluate('Count to 1000 slowly.', { signal: ac.signal })
      ).rejects.toThrow();
    });

    it('reports usage if capability claims to', async () => {
      const subject = factory();
      const result = await subject.evaluate('Reply: ok');
      if (ctx.capabilities.includes(CapabilityFlag.UsageReporting)) {
        expect(result.usage).not.toBeNull();
        expect(result.usage!.inputTokens).toBeGreaterThan(0);
      }
    });
  });
}
```

Adapters in Phase 3+ pull these test runners and pass their own factory. Same suite proves both Anthropic adapters work — and proves they're equivalent.

---

## Sequencing within Phase 2

Phase 2 is 51 interfaces + a substantial test framework. Done in the wrong order, it'll cycle (define an interface, realize the event vocabulary doesn't support it, redo). Done in the right order, each layer locks the next.

**Step 1: foundational types (no primitives yet)**
- `types.ts` — ProviderId, SessionHandle, RawProviderError
- `events.ts` — canonical event vocabulary (CanonicalEvent union: MessageDeltaEvent, ToolCallEvent, ToolResultEvent, TurnEndEvent, ErrorEvent, plus extension envelope for provider-specific events)
- `capabilities.ts` — CapabilityFlag enum (one entry per primitive) + `ProviderAdapter.capabilities: CapabilityFlag[]` discovery
- `errors.ts` — error hierarchy (ProviderError, AuthError, QuotaError, TimeoutError, …)

These five files have zero primitive dependencies. They're the substrate everything else builds on.

**Step 2: transport primitives (6 files)**
The transport layer defines how bytes flow. Interfaces here drive the shape of capability and control primitives.

**Step 3: capability primitives (6 files)**
Capabilities are mostly typed-data definitions (allowlist shapes, sandbox modes). Easy to define once transport is known.

**Step 4: observability primitives (9 files)**
This is the layer where the canonical event vocabulary gets exercised. If `events.ts` is shaped wrong, this is where we find out — cycle back to step 1.

**Step 5: control primitives (11 files)**
Most depend on transport (you control a session you've started). Some depend on observability (`stopGateInterceptor` needs hook events).

**Step 6: integration primitives (4 files)**
Provider scaffolding, MCP registry, session resume index, conversation log provider. Tie everything together.

**Step 7: optional primitives (15 files)**
The Codex-surfaced extras. Defined last because they all build on patterns established in steps 2-6.

**Step 8: registry + routing interface (2 files)**
- `registry.ts` — register adapters at runtime, query "which adapter has capability X"
- `routing.ts` — `RoutingPolicy` interface (no concrete policies — Phase 5 will add those)

**Step 9: conformance test framework (test infrastructure + per-primitive tests)**
- `conformance/runner.ts` — shared test plumbing (timeouts, capability-skip, golden-snapshot helpers)
- `conformance/<layer>/<primitive>.test.ts` — one runner per primitive

Conformance tests are *consumer-tied*: each test exercises the interface as a real consumer would. They don't test the adapter's internals.

---

## Open design questions to resolve as we go

These are the things I expect to need to decide mid-Phase-2 — calling them out so they don't surprise us:

1. **Event-vocabulary discriminator.** Should `CanonicalEvent` be a discriminated union by `type` field, or a class hierarchy? Lean: discriminated union, easier to serialize, no inheritance traps.
2. **Capability flag granularity.** One flag per primitive is conservative (51 flags). Alternative: roll up related primitives (e.g., a single `agenticSession` capability covering headless+interactive+rpc) and have callers declare needed variants. Lean: per-primitive flags.
3. **Promise vs AsyncIterable for streams.** `liveOutputStream` returns a stream of events. AsyncIterable is the idiomatic answer but doesn't compose well with cancellation. Alternative: callback-based with `subscribe`/`unsubscribe`. Lean: AsyncIterable with explicit `signal` parameter for cancellation; the Phase 3 adapter implementations will tell us if this hurts.
4. **Session handle opacity.** `SessionHandle` should be opaque from the consumer's perspective. Implementation: brand-typed string (`type SessionHandle = string & { __brand: 'SessionHandle' }`), or object with internal pointer to adapter state? Lean: branded string for simplicity, with all session ops requiring the adapter that issued it.
5. **Error normalization depth.** Should every adapter's errors map to a small set of canonical Instar errors, or should we pass through with a normalized wrapper? Lean: normalize to a small set (AuthError, QuotaError, TimeoutError, RateLimitError, NetworkError, AbortError, UnexpectedError) plus a `cause: unknown` field for the raw underlying error.
6. **Test framework choice.** Instar uses Vitest. Conformance tests should be Vitest-compatible. Test plumbing can be reused by adapter packages. Lean: just Vitest, no additional framework.

I'll record decisions as I make them in `04-design-decisions.md` so Phase 3 has the rationale.

---

## What success looks like

When Phase 2 is done:
- `src/providers/` compiles cleanly.
- Running the conformance suite against an empty placeholder adapter produces a list of "needs implementation" for every primitive — no false passes.
- Running the conformance suite against a *partial* adapter (only some capabilities) skips the missing ones rather than failing.
- The existing `IntelligenceProvider` interface in `src/core/types.ts` can be re-expressed as `oneShotCompletion` without behavior change.
- A reader of `src/providers/README.md` can see, in <5 minutes, what they'd need to do to add a new provider.

When Phase 2 is NOT done:
- We don't yet have a working Anthropic adapter (that's Phase 3a/3b).
- We can't actually invoke a session through the new interfaces (no adapter).
- The existing Instar source still uses `claude` directly — nothing in `src/core/SessionManager.ts` etc. has been refactored yet.

---

## Phase 2 estimated duration

Rough sizing: 51 interfaces × 30-60 min each = 25-50 hours of focused work. Conformance test framework + per-primitive tests = another 15-25 hours. Total: 40-75 hours, or roughly a week of focused work.

This isn't going in one sitting. The right cadence is: produce 5-8 interface files at a time, review them, commit, move on. Conformance tests can lag the interfaces by one batch — write them right before they're needed for the Phase 3a adapter.

I'll report progress at meaningful milestones (foundational types complete; transport layer complete; observability layer complete; etc.), not per-file.
