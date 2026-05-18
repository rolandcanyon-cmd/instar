# Provider Portability Substrate

This directory is the abstraction layer between Instar's application logic and the concrete agent provider it's running against (Claude, Codex, Gemini, local models).

**Status:** Phase 2 (interface design) in progress. No adapters yet — see `specs/provider-portability/` for the design docs.

---

## Directory layout

```
providers/
├── README.md             # this file
├── types.ts              # cross-primitive shared types
├── events.ts             # canonical event vocabulary
├── capabilities.ts       # capability flag enum + discovery
├── errors.ts             # error hierarchy
├── registry.ts           # adapter registry (runtime discovery + selection) — Phase 2 step 8
├── routing.ts            # RoutingPolicy interface — Phase 2 step 8
├── primitives/           # 51 interface files (Phase 2)
│   ├── transport/
│   ├── capability/
│   ├── observability/
│   ├── control/
│   ├── integration/
│   └── optional/
├── conformance/          # provider-agnostic test suites (Phase 2 step 9)
└── adapters/             # concrete adapter implementations (Phase 3+)
    ├── anthropic-headless/   (Phase 3a)
    ├── anthropic-interactive/ (Phase 3b)
    ├── openai-codex/         (Phase 4)
    └── local-ollama/         (Phase 6)
```

---

## How to add a new provider (target — not yet operational)

1. Implement the universal primitives in `primitives/transport/`, `primitives/capability/`, `primitives/observability/`, `primitives/control/`, `primitives/integration/`. Each is a TypeScript interface; the adapter implements as many as the provider supports.
2. Declare the adapter's capabilities by exporting a `CapabilityFlag[]` array.
3. Register the adapter via `registry.register({ id, capabilities, factory })`.
4. Run the conformance test suite: `npm run test:providers -- --adapter <id>`. It runs each universal-primitive suite if the capability is claimed, and each optional-primitive suite when claimed.
5. If the provider has unique features not in the universal set, propose a new optional primitive in `specs/provider-portability/` first — don't add adapter-specific methods to shared interfaces.

---

## How application code uses this (target)

Instar's application code never imports a concrete adapter. It goes through:

```ts
import { registry } from './providers/registry.js';

const session = await registry
  .resolve({ requires: ['agenticSessionHeadless', 'toolAccess'] })
  .agenticSessionHeadless
  .start({ prompt, model: 'balanced' });
```

The routing policy (Phase 5) decides which concrete adapter satisfies the request based on capability availability, current quota state, cost preference, and user override.

---

## Why these primitives, why this many

51 primitives is more than a typical abstraction. The count is forced by what Instar actually needs from a provider — it isn't speculative coverage. Each primitive maps to specific instar source files that today couple to Claude. Removing or merging primitives would re-introduce coupling we're trying to eliminate.

See `specs/provider-portability/01b-convergence-report.md` for the full primitive list and what each one covers. See `specs/provider-portability/00-functional-map.md` for which existing instar files each primitive abstracts.
