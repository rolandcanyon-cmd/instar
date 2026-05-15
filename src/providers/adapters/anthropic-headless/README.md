# anthropic-headless adapter

Concrete `ProviderAdapter` implementation that satisfies the Phase 2
provider-portability substrate by delegating to Anthropic's `claude -p`
(headless / print mode) and existing Instar infrastructure.

**Provider ID:** `anthropic-headless`
**Billing path (post-2026-06-15):** Agent SDK credit pot
**Status:** in progress (Phase 3a)

## Why this adapter

This is the "current Instar behavior, ported onto the new substrate"
adapter. Every place existing Instar talks to Claude — judgment calls,
session spawning, hook event reception, quota polling — is re-expressed
through this adapter's primitives. Nothing changes about how Instar works
to its callers; what changes is that the path now goes through a generic
substrate that another provider could replace.

After 2026-06-15, calls through this adapter draw from Anthropic's $200/mo
Agent SDK credit pot (Max 20x tier). When the pot empties, the routing
policy (Phase 5) falls back to the sibling `anthropic-interactive-pool`
adapter (Phase 3b) that draws from the Max subscription via long-lived
`claude` REPL sessions.

## Primitives implemented

Active (real implementations):
- OneShotCompletion — `claude -p PROMPT --model X --max-turns 1`
- AgenticSessionHeadless — `claude -p PROMPT --dangerously-skip-permissions` in tmux
- HookEventReceiver — wraps existing monitoring/HookEventReceiver
- ConversationLogReader / Tailer — ~/.claude/projects/...
- UsageMeterProvider — /api/oauth/usage + /api/oauth/profile
- CredentialStorageProvider — macOS Keychain + ~/.claude config
- SessionId / ProcessLifecycle / SessionResumeIndex — lookups
- Control primitives the above need (hardKill, inputInjection, timeoutBound,
  idleBound, authCredentialInjection)

Stub (throw UnsupportedCapabilityError until consumer arrives):
- StructuredOneShot, AgenticSessionInteractive, WarmSessionInbox,
  AgenticSessionRpc, all capability primitives, several observability and
  control primitives, all integration primitives except SessionResumeIndex
- See `capabilities.ts` for the full declared set vs. implementation status

## Why both real and stub

The adapter declares ALL 36 universal capabilities so the registry can
route any request to it. Stubs throw loudly when called rather than
silently returning. This means:
- Tests that look up "is there an adapter for X" find this one.
- Calls to unimplemented primitives fail with a clear error pointing at
  the missing implementation.
- Phase 3a doesn't have to implement every primitive — just the ones with
  active consumers in current Instar source.

## Configuration

Adapter accepts a configuration object at construction:

```ts
new AnthropicHeadlessAdapter({
  claudePath: '/opt/homebrew/bin/claude',
  defaultModel: 'balanced',
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  // etc.
});
```

Configuration is mostly delegation to existing Instar config — the same
env vars Instar already uses for Claude paths and auth.

## Layout

```
anthropic-headless/
├── README.md
├── index.ts                  # ProviderAdapter export
├── capabilities.ts           # capability set declaration
├── transport/                # OneShotCompletion, AgenticSessionHeadless, ...
├── capability/               # ToolAccess, ToolAllowlist, ...  (mostly stubs)
├── observability/            # HookEventReceiver, ConversationLog*, UsageMeter, ...
├── control/                  # HardKill, InputInjection, ...
└── integration/              # SessionResumeIndex, ProviderScaffolder, ...
```

## Testing

The Phase 2 conformance suites are imported and run against the adapter
in `src/providers/conformance/_adapters/anthropic-headless.test.ts`.
Smoke tests against real `claude -p` are gated by `INSTAR_REAL_API=1`.
