# Codex Provider-Portability Comparison

**Status:** Pre-Phase-2 research, complete (2026-05-14)
**Method:** Authoritative-source research against the Codex CLI / docs / app-server README, cross-referenced against our 36-primitive abstraction.

---

## ELI16 Overview

Before locking the Phase 2 interface design, we wanted to know how closely Codex CLI maps onto the 36 primitives we derived from Claude. The fear was that our abstraction would be "accidentally Claude-shaped" — interfaces that look generic but really only fit one provider's mental model.

Good news: Codex CLI is much closer to Claude Code than expected. They share design DNA — both have hooks, both have MCP tool registries, both have JSONL session logs, both have AGENTS.md-style instruction files (Codex literally uses `AGENTS.md`; Claude uses `CLAUDE.md`; there's an [open spec at agents.md](https://agents.md/) that both reference). Both have a headless print mode (`claude -p` / `codex exec`) and an interactive REPL (`claude` / `codex`). Both have subagents. The hook return contract is even **deliberately compatible** between the two — same JSON shape, same exit code 2 semantics.

Of our 36 primitives, 35 map cleanly. One needs a rename for neutrality. The research surfaced ~15 *additional* primitives we hadn't named because Codex offers them but Claude doesn't (thread forking, thread rollback, profile switching, custom model providers, OpenTelemetry export, plugin registry, trusted-project gating, etc.).

The most important finding for Phase 2: about 5 primitives are *asymmetric* between the two providers. Either Codex lacks them (no PreCompact hook, no public usage API), or they're shaped differently enough that pretending they're symmetric will leak (approval UX is structured-event on Codex's app-server vs. terminal-scraped on Claude's TUI). These need to be **capability-flagged**: any caller asking "does this provider support X" gets an honest yes/no answer rather than a silent failure.

Net: the abstraction direction is correct. Phase 2 interface design proceeds with these refinements.

---

## Primitive Mapping Table (all 36)

| # | Primitive | Codex equivalent | Notes |
|---|---|---|---|
| 1 | oneShotCompletion | `codex exec` (alias `codex e`) | Always wires a tool surface; pure tool-less generation needs OpenAI Responses API directly |
| 2 | structuredOneShot | `codex exec --output-last-message <path>` + prompt-side JSON request | No native `--output-schema`; schema validation is caller-side |
| 3 | agenticSession-headless | `codex exec` with JSONL streaming via `--json` | Direct analog of `claude -p` |
| 4 | agenticSession-interactive | Bare `codex` launches the TUI REPL | Direct analog of bare `claude` |
| 5 | warmSessionInbox | **No native equivalent.** Workaround: `codex remote-control` + `turn/steer`, or tmux + `send-keys` | Same shim shape as Claude |
| 6 | agenticSession-a2a → **agenticSession-rpc** | `codex remote-control` exposes app-server JSON-RPC 2.0 | Far richer than A2A; see §2 for splitting strategy |
| 7 | toolAccess | bash, file edits, web search, MCP, image gen, subagent spawn | Configured per profile |
| 8 | toolAllowlist | `mcp_servers.<id>` allowlist + sandbox-mode gating | Stricter than Claude — requires server **identity** match, not just name |
| 9 | fileSystemAccess | `sandbox_mode = "read-only" \| "workspace-write" \| "danger-full-access"` | TOML config |
| 10 | pathAllowlist | `permissions.<name>.filesystem` named profiles | More expressive than Claude's `--add-dir` |
| 11 | bashExecution | Sandboxed via `command/exec` or built-in tools; unsandboxed via `process/spawn` | Two tiers |
| 12 | webAccess | On by default, toggleable per profile via `permissions.<name>.network` | Cached search |
| 13 | liveOutputStream | `codex exec --json` emits `item.commandExecution.outputDelta`, `item.agentMessage.delta` | Cleaner than tmux scraping |
| 14 | conversationLogReader | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | **Date-partitioned, not UUID-flat like Claude** |
| 15 | conversationLogTailer | Same files; tail by polling | No documented inotify hook |
| 16 | hookEventReceiver | **First-class. 6 events: `SessionStart`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `Stop`** | Registered in `~/.codex/hooks.json` or `config.toml`. Hook contract intentionally Claude-compatible. ([hooks docs](https://developers.openai.com/codex/hooks)) |
| 17 | subagentLifecycleObserver | **Partial.** Subagents exist but no SubagentStart/SubagentStop hook. Workaround: tail app-server `thread/started`/`thread/closed` notifications | Capability-flag |
| 18 | sessionId | UUIDv7 thread IDs, visible in `/status` + rollout filename | Mature |
| 19 | usageMeterProvider | **No public equivalent.** Internal `/backend-api/wham/usage` (undocumented) + `account/rateLimits/read` JSON-RPC | Capability-flag; fall back to local accounting from `turn.completed.usage` |
| 20 | processLifecycle | POSIX child process; `/readyz`/`/healthz` HTTP probes on app-server | |
| 21 | interactivePromptObserver | **Structured by default.** App-server emits `item/commandExecution/requestApproval` notifications. TUI scrape only needed for plain `codex` mode | **Better than Claude here** |
| 22 | inputInjection | `turn/steer` JSON-RPC method (clean) OR tmux `send-keys` (legacy) | Two paths |
| 23 | hardKill | POSIX kill; app-server has graceful `thread/closed` | |
| 24 | interrupt | `turn/interrupt` JSON-RPC method | Mid-generation cancel |
| 25 | stopGateInterceptor | `Stop` hook returning `{"decision":"block","reason":"..."}` → continuation prompt | Semantically identical to Claude |
| 26 | timeoutBound | Per-hook `timeout` (default 600s), per-subagent `job_max_runtime_seconds` | No top-level session timeout — enforce externally |
| 27 | idleBound | **No native idle-timeout config.** Enforce via external watchdog | Capability-flag |
| 28 | authCredentialInjection | `CODEX_API_KEY` env var, or `codex login --with-api-key`, or OAuth via `codex login` | Multiple paths |
| 29 | credentialStorageProvider | `cli_auth_credentials_store = "file" \| "keyring" \| "auto"` in config.toml | **Cleaner than Claude** — first-class config key |
| 30 | contextScopeControl | `project_doc_max_bytes` (32 KiB), `project_doc_fallback_filenames`, trusted-project gating | AGENTS.md cascade root→cwd vs. Claude's monolithic |
| 31 | compactionLifecycle | Auto-compact at `effective_window - 13k`; manual `/compact`; `thread/compact/start` method | **No `PreCompact` hook** — capability-flag, poll usage instead |
| 32 | intelligenceCallQueue | No CLI-side queue; subagent concurrency cap `agents.max_threads` (default 6) | Same as Claude — quota dispatch lives in Instar |
| 33 | providerScaffolder | Writes `~/.codex/hooks.json`, `config.toml`, `.codex/agents/*.toml`, AGENTS.md | `codex /init` scaffolds AGENTS.md |
| 34 | mcpToolRegistry | `[mcp_servers.<id>]` TOML tables with stdio or HTTP transport | Identity match required for security |
| 35 | sessionResumeIndex | Date-partitioned FS + SQLite index at `sqlite_home`; `codex resume`, `--last`, `--all` picker | More developed than Claude |
| 36 | conversationLogProvider | Same rollout files as #14/#15 | Abstracts cleanly |

---

## Critical Shape Differences

These are the places where the abstraction has to bend or fork. Five categories rise above the rest.

### A. Headless JSON-RPC surface is structurally richer on Codex

Claude's A2A is task-RPC over JSON-RPC. Codex's app-server exposes filesystem (`fs/*`), command execution (`command/exec`), config mutation (`config/value/write`), thread management (`thread/fork`, `thread/rollback`, `thread/archive`), plugin management (`plugin/install`), and 30+ notification types. **Recommendation:** model `agenticSession-rpc` as narrow (start/steer/interrupt/observe). Add a separate optional `appServerControlPlane` capability that covers the fs/config/plugin surface when present. Claude returns `null` for the latter; Codex returns a typed handle.

### B. Hook event vocabulary partially overlaps but diverges on lifecycle

Codex has 6 hook events. Claude has 10+. Claude alone has: `SubagentStart`, `SubagentStop`, `WorktreeCreate`, `WorktreeRemove`, `TaskCompleted`, `SessionEnd`, `PreCompact`, `InstructionsLoaded`. **Recommendation:** `hookEventReceiver` exposes a union enum with per-event `availableOn: ('claude' | 'codex')[]` flags. For subagent lifecycle events on Codex, the adapter synthesizes them from app-server `thread/started`/`thread/closed` notifications and presents them through the same hook interface.

### C. Streaming event vocabulary differs

Codex `exec --json`: `thread.started`, `turn.started`, `turn.completed`, `item.started`, `item.completed`, `item.*.delta`, `error`. Claude: `assistant`, `user`, `tool_use`, `tool_result`, `result`. **Recommendation:** define a canonical Instar event model (`messageDelta`, `toolCall`, `toolResult`, `turnEnd`, `error`) and require each adapter to normalize. Never pass provider-raw events through — that leaks the abstraction at every consumer.

### D. Usage/quota is asymmetric

Anthropic exposes `GET /api/oauth/usage` publicly. Codex has no documented public quota endpoint. **Recommendation:** `usageMeterProvider` is optional — returns `null | UsageSnapshot`. The Codex adapter falls back to local accounting from `turn.completed.usage` fields (input/output/cached/reasoning tokens). `intelligenceCallQueue` (our quota-aware dispatch) must work with either authoritative or estimated usage data.

### E. Compaction has no hook on Codex

Claude has `PreCompact`. Codex silently auto-compacts at `effective_window - 13k` tokens. **Recommendation:** `compactionLifecycle` becomes a polling primitive in the Codex adapter — watch `turn.completed.usage.context_window_used` and emit a synthetic `compactionImminent` event before Codex's silent auto-compact fires. Same API surface for consumers.

---

## New Optional Primitives (Codex Offers, We Didn't Name)

These are first-class Codex features that don't fit our 36 primitives but are useful enough that a Codex-flavor Instar instance would want them. Add as **optional capabilities** — providers return `null` / `Unsupported` if absent.

| # | Primitive | What it is | Claude analog? |
|---|---|---|---|
| 37 | `threadFork` | Branch from any prior turn into a new thread without losing the parent (`thread/fork`) | None — `cp` the JSONL and rewrite |
| 38 | `threadRollback` | Drop last N turns and continue (`thread/rollback`) | None |
| 39 | `threadGoalSlot` | Structured "what is this thread trying to accomplish" field separate from messages | None — Instar approximates with topics |
| 40 | `profileSwitcher` | Named TOML config sets (review-only, dangerous-build, cheap-haiku) switchable via `--profile <name>` | Per-project `.claude/settings.json` (no atomic switch) |
| 41 | `customModelProvider` | `[model_providers.<id>]` supports built-in `openai`, `ollama`, `lmstudio`, plus arbitrary providers with base URL, auth, headers, command-backed credential helpers | **None — Claude is Anthropic-locked.** Major win — partially solves our Phase 6 (local model adapter) |
| 42 | `shellEnvironmentPolicy` | `shell_environment_policy` controls which env vars subprocess tools see (clean / trimmed / pass-through) | Manual scrubbing in Instar's SessionManager |
| 43 | `otelExporter` | `[otel]` config block — native OTLP HTTP/gRPC traces for API requests, prompts, tool approvals | None |
| 44 | `complianceApi` | Org-level audit log endpoint | Anthropic Admin API events, different shape |
| 45 | `pluginRegistry` | `plugin/list`, `plugin/install`, `plugin/uninstall`; plugins can bundle hooks via `hooks/hooks.json` | None — Claude has skills but no plugin protocol |
| 46 | `filesystemRPC` | `fs/readFile`, `fs/writeFile`, `fs/watch`, `fs/copy` via app-server | None |
| 47 | `processSpawn` | Unsandboxed process execution via app-server (experimental) | None |
| 48 | `capabilityNegotiation` | App-server init handshake supports per-feature opt-in | None — implicit detection |
| 49 | `notificationOptOut` | Clients declare unwanted notifications during `initialize` | None |
| 50 | `codeReviewPreset` | `/review` slash command with diff/branch/commit presets | Skills approximate it |
| 51 | `csvBatchMode` | Subagent system runs across CSV rows with per-row timeout | Build-on-top required |
| 52 | `selfUpdate` | Built-in `codex update` | npm/global install management |
| 53 | `trustedProjectGate` | `.codex/config.toml` only loaded for explicitly-trusted projects; first encounter prompts user | **None — Claude is vulnerable to malicious-CLAUDE.md.** Worth adopting as a portability-layer policy regardless of provider |
| 54 | `requirementsToml` | Org-managed config that locks down which models/sandboxes/MCP servers are permitted | None |

**Total expanded primitive set: 36 → 51 (15 optional additions).** Adapters declare capability flags; routing policy can require a provider that supports specific primitives.

---

## Implications for Phase 2

### Interface design refinements
1. **Rename** `agenticSession-a2a` → `agenticSession-rpc` (more neutral).
2. **Split** the rich JSON-RPC surface: narrow `agenticSession-rpc` (universal) + optional `appServerControlPlane` (Codex-only today).
3. **Add 15 optional primitives** from the table above. All are flag-gated; providers return `null` if absent.
4. **Capability-flag 5 primitives** that are asymmetric: `usageMeterProvider`, `compactionLifecycle.preHook`, `subagentLifecycleObserver`, `idleBound`, `interactivePromptObserver.structured`.
5. **Define canonical Instar event vocabulary** — `messageDelta`, `toolCall`, `toolResult`, `turnEnd`, `error`. Adapters normalize from provider-specific events.

### Strategic wins
- **Codex's `customModelProvider` partially solves Phase 6.** Instead of building an Ollama adapter from scratch, we can configure Codex to use Ollama as its underlying model — Codex handles the agent loop, tool dispatch, hooks, scaffolding, and Instar's Codex adapter passes through. We still want a direct local-model path eventually, but this is a faster route to "Instar works against a local model."
- **Codex's `trustedProjectGate` is a security primitive worth adopting** even when running on Claude. Instar should require explicit project-trust before loading any provider-specific config.
- **Codex's structured-event approval UX is better than Claude's terminal-scraping.** When designing `interactivePromptObserver`, default to the structured path; the scrape implementation is the fallback, not the canonical case.

### Uncertainty flags
- **`/backend-api/wham/usage`** is undocumented and may move. Treat as best-effort; don't depend on it.
- **WebSocket transport on the app-server** is marked experimental. Use stdio for production; treat WebSocket as opt-in.
- **Subagent lifecycle observability** on Codex: docs don't confirm whether child threads fire `SessionStart` hooks or only emit app-server notifications. Verify with a smoke test before relying on it.

---

## Sources

Authoritative sources used (a subset):

- [openai/codex (GitHub)](https://github.com/openai/codex)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [Codex Hooks documentation](https://developers.openai.com/codex/hooks)
- [Codex Configuration Reference](https://developers.openai.com/codex/config-reference)
- [Codex Subagents](https://developers.openai.com/codex/subagents)
- [App Server JSON-RPC README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex Authentication](https://developers.openai.com/codex/auth)
- [Codex MCP support](https://developers.openai.com/codex/mcp)
- [AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md)
- [agents.md open spec](https://agents.md/)
- [Codex Skills](https://developers.openai.com/codex/skills)
- [Codex non-interactive mode (exec --json)](https://developers.openai.com/codex/noninteractive)
- [Context compaction deep-dive (3rd party)](https://codex.danielvaughan.com/2026/04/14/context-compaction-deep-dive-codex-cli-claude-code-opencode/)
