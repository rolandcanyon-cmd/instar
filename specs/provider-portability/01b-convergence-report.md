# Phase 1b — Verification Pass &amp; Convergence Report

**Status:** Draft v0.1 (2026-05-14)
**Pass:** Second (verification of expanded primitives against full source)
**Method:** Same four agents re-deployed against same slices, but this time handed the expanded 33-primitive list and asked: "for every file in your slice, does its coupling fit one of these primitives, or do we need a new one?"

---

## ELI16 Summary

The first pass produced a functional map and uncovered 12 new primitive categories beyond the initial Phase 1 inventory. To check whether we'd actually achieved full coverage — or whether more categories were lurking — we re-ran the same four agents over the same slices, this time with the expanded primitive list in hand. Each agent was asked to either cleanly map every file in their slice to a primitive (or set of primitives), declare a file provider-agnostic, OR flag a file whose coupling pattern still didn't fit anywhere we'd named.

The result is the practical answer to "have we converged." Across all four slices, agents proposed 15 additional primitive categories. After review (filtering out application infrastructure that doesn't need provider abstraction, redundant categories already covered, and refinements that fit better as splits of existing primitives), **three genuinely new primitives survived**, plus one existing primitive that needs to be split into two.

The big lesson from this pass: **the verification agents kept misclassifying instar's own application subsystems as "primitives that need abstraction."** Things like instar's reviewer framework, the autonomy profile system, the dispatch system, the multi-machine ledger sync protocol — these are all built on top of `IntelligenceProvider` and tmux, but they're application logic. They don't need to be re-implemented per provider. They just need the underlying primitives (IntelligenceProvider, agenticSession, etc.) to keep working. This is an important distinction we need to be explicit about going into Phase 2: the abstraction we're building is a thin substrate, not a redesign of instar.

---

## What the Verification Pass Proposed

| Slice | Proposals | Genuinely new? | Notes |
|---|---|---|---|
| 1 (Central nervous system) | 5 | 0 | All five were instar application subsystems (multi-machine ledger sync, reviewer framework, autonomy profiles, dispatch system, blocker-learning loop), not provider primitives. Each runs *on top of* primitives we already have. |
| 2 (Communication layer) | 3 | 1 | `agenticSession-a2a` is a genuinely new transport (A2A JSON-RPC). `warmSessionInboxFilePoller` is a control-layer policy on top of `warmSessionInbox`. `networkTunnelProxy` is server-exposure infra, not Claude coupling. |
| 3 (Observability + persistence) | 3 | 2 + 1 split | `intelligenceCallQueue` is a real control-layer primitive (quota-aware concurrent LLM dispatch). `conversationLogProvider` deserves splitting into archival reader vs. real-time tailer. `interactiveTerminalControl` is better expressed as a refinement (composite of `liveOutputStream` + `inputInjection`). |
| 4 (Entry points + utilities) | 4 | 0 | `sessionInvocationContext` is a consequence of the abstraction work (public API surface), not a primitive. `hookScriptRegistry` is already covered by `providerScaffolder`. `intelligenceProviderAdapter` is a factory pattern (infrastructure). `sessionOutputFormatting` is a refinement of existing transport/observability. |
| **Total** | **15 proposals** | **3 new + 1 split** | Filtering ratio: ~25% of proposals were genuinely useful. |

### Why so many false positives?

The verification agents over-categorized for two reasons:

1. **Application infrastructure looks like primitive coupling.** Instar's reviewer framework calls LLMs through `IntelligenceProvider`. Naively, this looks like provider coupling. But it's the *interface* that's the primitive, not the framework. Different providers can satisfy the same `IntelligenceProvider` interface; the reviewer framework doesn't change.

2. **"Provider-agnostic" vs "provider-portability-scope" confusion.** Tunnel management, identity crypto, multi-machine ledger sync, etc. are provider-agnostic in the sense that they don't touch Claude. But they're *also* not in scope for provider portability — they're orthogonal subsystems that need to keep working through the port. The agents conflated "doesn't fit a primitive" with "needs to be a primitive."

For Phase 2 we need to be explicit: **the primitive set is the abstraction substrate, not a redesign of instar.** Anything above the substrate is application code that should compile unchanged.

---

## Final Primitive Set (post-convergence)

### TRANSPORT (6) — how bytes flow to a provider
1. `oneShotCompletion` — single prompt → single response, no tools
2. `structuredOneShot` — single prompt → schema-validated JSON
3. `agenticSession-headless` — multi-turn session, tools+files, no human
4. `agenticSession-interactive` — multi-turn session, TTY-attached human
5. `warmSessionInbox` — long-lived session with file-based message-injection inbox
6. **`agenticSession-a2a`** *(new from verification pass)* — multi-turn session driven by A2A JSON-RPC tasks with external task store + execution event bus

### CAPABILITY (6) — what the provider can do
7. `toolAccess`
8. `toolAllowlist`
9. `fileSystemAccess`
10. `pathAllowlist`
11. `bashExecution`
12. `webAccess`

### OBSERVABILITY (9) — what we can see
13. `liveOutputStream` — tmux capture-pane equivalent
14. **`conversationLogReader`** *(was conversationLogProvider — split)* — post-hoc read of provider's session log
15. **`conversationLogTailer`** *(new from verification pass — split sibling)* — real-time tailing of provider's session log for stall/crash detection
16. `hookEventReceiver` — 10+ Claude Code event types
17. `subagentLifecycleObserver`
18. `sessionId` — provider-side unique session ID
19. `usageMeterProvider` — per-provider quota/usage API
20. `processLifecycle`
21. `interactivePromptObserver` — CLI terminal UI prompt detection

### CONTROL (11) — how we steer
22. `inputInjection`
23. `hardKill`
24. `interrupt` — interrupt mid-generation (vs. hard kill)
25. `stopGateInterceptor` — intercept provider's pre-stop signal
26. `timeoutBound`
27. `idleBound`
28. `authCredentialInjection` — spawn-time credential routing
29. `credentialStorageProvider` — persistent OAuth credential storage
30. `contextScopeControl` — what context the session sees (CLAUDE.md, settings, sources)
31. `compactionLifecycle` — PreCompact + marker + resume protocol
32. **`intelligenceCallQueue`** *(new from verification pass)* — quota-aware concurrent LLM dispatch with deduplication, batching, daily spend caps, per-tier rate limits, AbortSignal coordination

### INTEGRATION (4) — how we live alongside the provider
33. `providerScaffolder` — install per-provider config (settings.json, hook scripts, skill dirs)
34. `mcpToolRegistry` — register Instar's MCP tools with provider's host
35. `sessionResumeIndex` — provider-side index of resumable sessions
36. `conversationLogProvider` — abstract over `conversationLogReader` + `conversationLogTailer` for callers that don't care about freshness

**Final count: 36 primitives** across five layers. (Phase 1 started at 21; this represents a ~70% expansion driven by the mapping + verification work.)

---

## Convergence Verdict

**CONVERGED with high confidence.**

Evidence:
- All 441 files mapped to primitives or declared provider-agnostic across both passes.
- Verification pass surfaced only 3 genuinely new primitives + 1 split — substantially fewer than the 12 surfaced in Pass 1a's expansion. Diminishing returns reached.
- Of 15 proposals from the verification pass, 12 were filtered out for valid reasons (application infrastructure mistaken for primitives, redundancy with existing primitives, refinement-not-addition).
- No proposed primitive from Pass 2 represented a coupling category Pass 1a had completely missed; all were refinements or sibling categories of existing primitives.

Risk of remaining unfound primitives: **LOW**. Could a third pass surface something? Possible, but unlikely to be in a new coupling category — more likely a refinement of an existing one. The cost of one more pass (4 more agent runs + synthesis) vs. the value (catch a refinement) does not justify continuing.

**Recommendation:** Stop here, lock the primitive set at 36, proceed to Phase 2 (interface design).

---

## Phase 2 Implications

### What's in scope for the abstraction layer

The 36 primitives above. Phase 2 produces TypeScript interface definitions for each, plus a provider-agnostic conformance test suite.

### What's NOT in scope (kept above the substrate)

These instar application subsystems were proposed as primitives but rejected because they sit *above* the abstraction:

- **Reviewer framework** (`CoherenceReviewer`, `CustomReviewerLoader`, 10+ reviewers) — uses `oneShotCompletion`; doesn't need per-provider variants.
- **Autonomy profile management** (`AutonomyProfileManager`, `AutonomySkill`, `TrustRecovery`, `AutoApprover`) — policy logic, provider-agnostic.
- **Dispatch system** (`DispatchManager`, `DispatchExecutor`, journals, verifiers) — instar workflow primitive, sits on `agenticSession-headless`.
- **Multi-machine ledger sync** (`WorkLedger`, `LedgerAuth`, `NonceStore`, `MachineIdentity`, `PairingProtocol`) — orthogonal distributed-systems subsystem.
- **Blocker-learning loop** (`BlockerLearningLoop`, `CommitmentSweeper`) — application learning, provider-agnostic.
- **Tunnel management** (`TunnelManager`) — server-exposure infra; doesn't touch the provider.
- **Identity crypto** (`identity/*` — Ed25519, key rotation, recovery phrase) — agent identity, not provider.
- **Memory + knowledge infrastructure** (`SemanticMemory`, `MemoryIndex`, `VectorSearch`, `Chunker`, `EmbeddingProvider`, `TreeTraversal`, `KnowledgeManager`) — all provider-agnostic by design.

Phase 2 will produce:
1. `src/providers/primitives/*` — interface files, one per primitive
2. `src/providers/conformance/*` — test suites that any adapter must pass
3. `src/providers/registry.ts` — runtime discovery and selection
4. `src/providers/routing.ts` — policy interface for "I need a session that supports X, Y, Z"

No adapter code in Phase 2. Phase 3 ports Anthropic onto the new interfaces (proving the substrate doesn't lose anything we have today). Phase 4 ports Codex (proving the substrate isn't accidentally Anthropic-shaped).

### Where the primitive count maps file-counts

Roughly:
- **Files implementing primitives** (~50): the actual adapter surface. Anthropic adapter + Codex adapter + Gemini adapter + local adapter each implement these.
- **Files using primitives via interface** (~110): application code that imports `IntelligenceProvider` or `SessionManager` and doesn't care about the concrete provider. These should compile unchanged through the port.
- **Files provider-agnostic** (~270): no provider interaction at all. Untouched by the port.
- **Files needing one-time refactor** (~10): files that hardcode `~/.claude/` paths, `claudeSessionId` field names, etc. These need to switch from concrete to abstract types.

Total Phase 3 (Anthropic port) surface: roughly 50-60 files touched directly, plus interface tweaks rippling through ~110 application files (mostly type renames).

---

## Open Questions for Phase 2

These didn't get resolved in the mapping work and need explicit decisions at the start of Phase 2:

1. **Provider scaffolding namespace** — keep `.claude/` for Claude, add `.codex/` for Codex, etc.? Or generalize to `.agent/<provider>/`? The former is less disruptive; the latter is cleaner long-term.

2. **Session ID namespace** — keep `claudeSessionId` as the field name and treat it as per-provider opaque, or rename to `providerSessionId` and force a schema migration? Migration cost is real but the rename is correct.

3. **MCP-as-tool-protocol assumption** — Codex supports MCP, but Gemini doesn't natively. Do we shim MCP for non-supporting providers, or do we accept that tool access has provider-tier differences and let the routing policy handle it?

4. **Conformance test depth** — how strict? "Any adapter must pass these 200 tests" is great for correctness but might be impossible for local Ollama (no usage meter, limited capability). Probably tier the tests: "MUST pass" core set + "MAY pass" advanced set.

5. **Per-provider settings file format** — Claude's `.claude/settings.json` has a specific schema. Do we generalize that into `IProviderSettings` with per-provider extensions, or have entirely separate settings files per provider?

I have opinions on each but want to wait until Phase 2 design starts before locking them.
