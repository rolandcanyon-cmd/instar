# Instar Provider Portability — Phase 1: Primitives Inventory

**Status:** Draft v0.1 (2026-05-14)
**Branch:** `spec/provider-portability`
**Author:** Echo
**Phase:** 1 of 6 (foundation)

---

## ELI16 Overview

Instar talks to Claude in a bunch of different ways. Some of those ways are quick "answer this yes/no question" calls. Some are long "go work on this for an hour" sessions inside a terminal multiplexer. Some are watchdogs reading a stuck session's output and asking an LLM what's wrong. Each one has different needs — different shapes of input, different ways of getting output back, different expectations about cost, latency, and how much can go wrong.

Right now all of these ways are hardwired to Claude (the CLI binary and the Anthropic API). Anthropic just made a pricing change that triples or quadruples Instar's effective cost. So we want Instar to be able to talk to *any* capable agent provider — Claude, OpenAI Codex, Google Gemini, a local Ollama model — without rewriting Instar.

The way to do that is: find the underlying *patterns* in how Instar talks to Claude (we're calling these "primitives"), describe each pattern as a generic contract that doesn't mention any specific provider, then write adapters that satisfy the contract for each provider we want to support.

This document is the first step: a complete catalog of every place Instar currently talks to Claude, what each call is *doing functionally* (not what code path it takes), and which primitive that call belongs to. Once this catalog is complete and reviewed, the next phase designs the primitive contracts themselves.

The goal is that when we're done with all six phases, switching Instar from Anthropic to Codex is a config change, not a rewrite. And running Instar against a self-hosted model is a config change too.

---

## Method

For each Claude integration point in Instar, the inventory captures:

1. **Call site** — file:line, function, where in the codebase
2. **Functional purpose** — what is this trying to accomplish, in domain terms (not implementation terms)
3. **Transport pattern** — how bytes flow (one-shot completion, REPL session, tool-loop, etc.)
4. **Inputs** — what context is sent (prompt only? prompt + tools? prompt + files? session history?)
5. **Outputs** — what shape we expect back (free text? structured JSON? tool calls? streamed events?)
6. **Capabilities used** — tool access, file system access, web fetch, etc.
7. **Observability needs** — what does the caller need to see during/after the call
8. **Control needs** — interrupt, abort, mid-flight steering, context window management
9. **Failure tolerance** — what happens when it fails (silent fallback? user-visible error? retry?)
10. **Volume class** — high/medium/low frequency, to inform cost budgets

The catalog is grouped by functional category, not by code path, because the same primitive shows up in multiple files.

---

## Call-Site Inventory

### Category A — Lightweight Judgment Calls

Short, one-shot LLM calls for classification, routing, scoring, summarization. The IntelligenceProvider interface already abstracts these.

#### A.1 — IntelligenceProvider.evaluate() (the umbrella case)
- **Call sites:** any module taking an `IntelligenceProvider` (`src/core/types.ts:427`)
- **Implementations:** `ClaudeCliIntelligenceProvider` (default), `AnthropicIntelligenceProvider` (opt-in)
- **Functional purpose:** "Given this prompt with context, give me a short answer." Used for: stall classification, scope routing, content moderation, message-pair classification, threadline trust evaluation, etc.
- **Transport:** one-shot completion. CLI provider invokes `claude -p --model X --max-turns 1`. API provider POSTs to `/v1/messages`.
- **Inputs:** prompt string (full context baked in)
- **Outputs:** raw text string; caller parses (often JSON, sometimes free-form)
- **Capabilities used:** none beyond text completion
- **Observability:** none required; success/fail is enough
- **Control:** timeout (default 30s on CLI, 15s on API)
- **Failure tolerance:** modules fall back to heuristic-only behavior; not fatal
- **Volume class:** high — many calls per session

#### A.2 — Threadline message classifier
- **Call site:** `src/threadline/PipeSessionSpawner.ts:106`
- **Functional purpose:** Decide whether an incoming thread message is in-scope for autonomous response (vs. requires human)
- **Transport:** `echo PROMPT | claude -p --model haiku` (one-shot, shell-piped)
- **Inputs:** prompt with message + thread context
- **Outputs:** structured short answer
- **Capabilities used:** none
- **Observability:** none
- **Control:** none beyond process kill
- **Failure tolerance:** conservative fallback (don't auto-respond)
- **Volume class:** medium

#### A.3 — Threadline history summarizer
- **Call site:** `src/threadline/PipeSessionSpawner.ts:171`
- **Functional purpose:** Reduce thread history to a short summary before injecting it into a deeper session (strips jailbreak assemblies)
- **Transport:** same shell-piped one-shot pattern
- **Inputs:** thread messages
- **Outputs:** summary text
- **Failure tolerance:** if summarization fails, the deeper session is not spawned
- **Volume class:** low-medium

#### A.4 — StallTriageNurse diagnosis
- **Call site:** `src/monitoring/StallTriageNurse.ts` (uses `IntelligenceProvider` or direct Anthropic API per `useIntelligenceProvider` flag)
- **Functional purpose:** Given a stuck session's tmux output + recent message history + pending message, decide what's wrong and how to unstick it
- **Transport:** one-shot completion expected to return structured JSON (`TriageDiagnosis`: summary + action + confidence + userMessage)
- **Inputs:** tmux capture, session state, recent messages, wait duration
- **Outputs:** **structured JSON** with discriminated-union action field — this is a *schema-constrained* completion
- **Capabilities used:** none
- **Observability:** caller emits triage events (`triage:diagnosed`, `triage:treated`, etc.)
- **Control:** timeout, cooldown between triages for same topic
- **Failure tolerance:** falls back to no-op (session left to user)
- **Volume class:** low (only on stalls)
- **Note:** this call is a strong candidate to need a "structured output" primitive distinct from raw text completion

---

### Category B — Long-Running Agent Sessions

Multi-turn, tool-using, file-touching sessions that look like a human at a Claude Code prompt. Currently spawned headless via `claude -p` inside a tmux window.

#### B.1 — Job sessions
- **Call site:** `src/core/SessionManager.ts:659` (spawn into tmux), invoked from job scheduler + Telegram lifeline + manual triggers
- **Functional purpose:** Run a substantive piece of work — a job's scheduled task, a topic-bound conversation, an autonomous loop iteration. Sessions can write code, run commands, talk to APIs, send Telegram messages back.
- **Transport:** `claude --dangerously-skip-permissions --model X -p PROMPT` inside a detached `tmux new-session`. Long-lived. tmux scrollback captured for monitoring.
- **Inputs:** initial prompt, model tier, working directory (with CLAUDE.md), env vars (auth tokens, server URL, fencing token, optional Anthropic API key)
- **Outputs:** stdout into the tmux pane (captured asynchronously), plus side effects (files written, HTTP calls to instar server hooks, Telegram messages)
- **Capabilities used:** **all** — read/write/bash/web/MCP servers. Skill-restricted but otherwise unrestricted.
- **Observability:** tmux `capture-pane` for live output, Claude Code hook events POSTed back to the instar server (session start, tool use, completion), Claude Code session UUID lazy-bound to instar session
- **Control:** tmux `send-keys` for input injection, `kill-session` for hard kill, idle-at-prompt watchdog, max-duration safety net, work-tree fencing
- **Failure tolerance:** failures surface via stall triage, watchdog, or completion patterns; can respawn from same topic
- **Volume class:** high — this is the core Instar workload
- **Note:** this is the single most important primitive to nail. Whatever Codex/local equivalent is, it has to support: persistent multi-turn session, tool use, file system access, async I/O, external event hooks for observability, ability to inject mid-stream input, ability to be killed.

#### B.2 — Threadline pipe sessions
- **Call site:** `src/threadline/PipeSessionSpawner.ts:265`
- **Functional purpose:** Lightweight one-message-per-session Claude Code workers that respond to threadline messages and then exit
- **Transport:** `cat PROMPT_FILE | claude -p` with restricted tools + restricted paths
- **Inputs:** prompt with `<untrusted-message>` wrapped content, allowed tools list, allowed paths list, 10-minute timeout
- **Outputs:** model output (which may include `threadline_send` MCP tool calls)
- **Capabilities used:** restricted set — `threadline_send`, `Read`, `Glob`, `Grep`
- **Observability:** process tracking (active session map, PIDs)
- **Control:** timeout, process-group kill
- **Failure tolerance:** session counted as failed, no retry
- **Volume class:** medium
- **Note:** key feature: **MCP tool restriction** — provider abstraction must support saying "this session can only call these specific tools"

#### B.3 — Setup wizard session
- **Call site:** `src/commands/setup.ts:251, 328`
- **Functional purpose:** Walk a human through agent setup (project init, secret config) using a Claude Code session as the conversational interface
- **Transport:** `spawn(claude, [..., '/setup-wizard ...'], { stdio: 'inherit' })` — true interactive REPL with TTY pass-through to user
- **Inputs:** initial command + project context
- **Outputs:** user-visible terminal output, file writes to project
- **Capabilities used:** all (skill-scoped)
- **Observability:** none — the user is watching it directly
- **Control:** user has direct TTY control (Ctrl-C, typing)
- **Failure tolerance:** wizard tells user what went wrong
- **Volume class:** very low (one-shot per agent install)
- **Note:** this is **already** a primitive distinct from B.1 — interactive-with-human, not headless. Provider abstraction should preserve it.

---

### Category C — Direct API Calls

Cases where Instar goes around the CLI to talk to the Anthropic API directly.

#### C.1 — AnthropicIntelligenceProvider (opt-in alternative to CLI provider)
- **Call site:** `src/core/AnthropicIntelligenceProvider.ts:42`
- **Functional purpose:** Same as A.1 (lightweight judgment) but via direct API instead of CLI
- **Transport:** `fetch('https://api.anthropic.com/v1/messages')` with `x-api-key` header
- **Inputs:** prompt, model, max_tokens, temperature
- **Outputs:** parsed `content[].text` from JSON response
- **Capabilities used:** none
- **Observability:** HTTP status code; full error body on non-2xx
- **Control:** none beyond fetch timeout
- **Failure tolerance:** caller may fall back to CLI provider or heuristics
- **Volume class:** opt-in; rare in default config
- **Note:** this and A.1 share an interface (`IntelligenceProvider`); they are different *transports* for the same *primitive*.

#### C.2 — StallTriageNurse direct API path
- **Call site:** `src/monitoring/StallTriageNurse.ts` (when `useIntelligenceProvider: false`)
- **Functional purpose:** Same as A.4 but bypassing the IntelligenceProvider abstraction
- **Note:** redundant now that A.4 routes through IntelligenceProvider by default; the direct path can probably collapse into A.4 under the new abstraction.

---

### Category D — Auxiliary Integration Points

These touch Claude but don't invoke it — they observe, manage credentials, or read state.

#### D.1 — Claude CLI prerequisite check
- **Call site:** `src/core/Prerequisites.ts:79` — `claude --version`
- **Functional purpose:** Verify Claude CLI is installed before agent start
- **Primitive:** *provider availability check* — generic: "is this provider reachable / configured?"

#### D.2 — Claude CLI path resolution
- **Call site:** `src/core/Config.ts:133` — `which claude`
- **Functional purpose:** Find the binary
- **Primitive:** part of provider availability check

#### D.3 — Quota collector
- **Call site:** `src/monitoring/QuotaCollector.ts`
- **Functional purpose:** Read `~/.claude` usage data, surface to dashboard
- **Primitive:** *provider usage / cost telemetry* — generic: "what has this provider consumed and what is left?"
- **Note:** this becomes critical with the June 15 Agent SDK credit pot; same hook will need to read the credit balance.

#### D.4 — Orphan process reaper / presence proxy
- **Call sites:** `src/monitoring/OrphanProcessReaper.ts`, `src/monitoring/PresenceProxy.ts`
- **Functional purpose:** Detect/clean up stale `claude` processes
- **Primitive:** *provider process lifecycle observability* — Anthropic-specific today; for portable providers this becomes "is the agent process for session X still alive?"

#### D.5 — Auth token routing
- **Call site:** `src/core/SessionManager.ts:684-686`
- **Functional purpose:** Route auth correctly: `sk-ant-oat...` (OAuth subscription) goes to `CLAUDE_CODE_OAUTH_TOKEN`; `sk-ant-api...` goes to `ANTHROPIC_API_KEY`. They are mutually exclusive.
- **Primitive:** *provider authentication injection* — each provider needs its own auth scheme; abstraction has to support "inject the right credentials per provider per session"

---

## Candidate Primitives (Synthesis)

Pulled from the inventory above. Names provisional.

### Transport Layer

| Primitive | Purpose | Current implementation | Notes |
|---|---|---|---|
| `oneShotCompletion` | Single prompt → single response, no tools | A.1, A.2, A.3 | Cheapest, simplest |
| `structuredCompletion` | Single prompt → schema-validated JSON | A.4 (informally) | Distinct from text — needs schema as input |
| `agenticSession` | Multi-turn session with tools, file access, persistent state | B.1, B.2 | THE big one |
| `interactiveSession` | Same as agenticSession but TTY-attached to a human | B.3 | Distinct billing/use class |

### Capability Layer

| Primitive | Purpose | Current implementation |
|---|---|---|
| `toolAccess` | Provider can call tools (MCP, builtin) | B.1, B.2 |
| `toolAllowlist` | Restrict which tools are callable | B.2 (read-only + threadline_send) |
| `fileSystemAccess` | Provider can read/write files | B.1, B.3 |
| `pathAllowlist` | Restrict file access to specific paths | B.2 |
| `bashExecution` | Provider can run shell commands | B.1, B.3 |
| `webAccess` | Provider can fetch URLs | B.1, B.3 |

### Observability Layer

| Primitive | Purpose | Current implementation |
|---|---|---|
| `outputStream` | Live capture of what the model is producing | B.1 via tmux capture-pane |
| `eventHooks` | Per-event callbacks (session start, tool use, completion) | B.1 via Claude Code hooks → HTTP |
| `sessionId` | Provider-side unique ID for session correlation | B.1 (Claude Code session UUID) |
| `usageMeter` | Tokens / cost consumed per session | D.3 |
| `processLifecycle` | Is the agent process alive? | D.4 |

### Control Layer

| Primitive | Purpose | Current implementation |
|---|---|---|
| `inputInjection` | Send input mid-session | B.1 via tmux send-keys |
| `hardKill` | Force-terminate session | B.1 via tmux kill-session; B.2 via process-group kill |
| `interrupt` | Interrupt model mid-generation (vs. hard kill) | Not currently implemented; useful for stall triage |
| `timeoutBound` | Max wall-clock duration | All categories |
| `idleBound` | Max time stuck at prompt before kill | B.1 |
| `authCredentialInjection` | Per-provider credential routing | D.5 |
| `contextScopeControl` | What context the session sees (CLAUDE.md, settings, sources) | A.1 uses `--setting-sources user` to exclude project CLAUDE.md |

---

## Provider-Equivalence Hypothesis

For the abstraction to be useful, each primitive must have a plausible implementation on each target provider. First-pass hypothesis (to be tested in phases 3-6):

| Primitive | Anthropic | OpenAI Codex | Gemini | Ollama/local |
|---|---|---|---|---|
| `oneShotCompletion` | `/v1/messages` | `/v1/chat/completions` | `generateContent` | OpenAI-compatible local API |
| `structuredCompletion` | `tools` param with JSON schema | `response_format: json_schema` | `responseSchema` | Varies — often JSON mode |
| `agenticSession` | Claude Code CLI | Codex CLI / `responses` API | Gemini Code Assist (?) | Open question — Aider? Custom? |
| `interactiveSession` | Claude Code REPL | Codex REPL | ? | TTY REPL via local CLI |
| `toolAccess` | MCP + builtin | MCP + builtin | Function calling | Limited; varies |
| `toolAllowlist` | `--allowed-tools` | `--allowed-tools` (?) | Per-call config | Varies |
| `pathAllowlist` | Claude Code `--add-dir` | Codex working-dir flag | ? | Varies |
| `outputStream` | tmux pane (for CLI), SSE (for API) | tmux pane / SSE | Streaming SSE | Streaming SSE |
| `eventHooks` | Claude Code hooks | Codex hooks (?) | Likely absent | Likely absent — implement via wrapper |
| `usageMeter` | `~/.claude` + Anthropic console API | OpenAI usage API | Gemini usage API | None (free) |
| `interrupt` | Not exposed today | OpenAI request-level cancel | Same | Process signal |

**Risk concentrated in `agenticSession`** — this is where providers diverge most. For Codex we have a vendor-blessed equivalent; for Gemini and local models we may need to build the agent loop ourselves on top of a `structuredCompletion + toolAccess` foundation.

---

## Open Questions

1. **Is `agenticSession` one primitive or two?** Headless (B.1) and interactive-with-human (B.3) have very different billing implications post-June 15. Splitting them is probably right.
2. **Does `structuredCompletion` deserve to be a top-level primitive, or is it a parameterization of `oneShotCompletion`?** Leaning toward top-level because the schema constraint affects which providers can satisfy it and how.
3. **Where does session *resume* live?** Today instar can re-attach to a tmux session but not actually re-prompt a finished Claude turn with new context unless we spawn fresh. Resume semantics differ wildly across providers.
4. **How do we model tool-allowlist + MCP server selection generically?** MCP is Anthropic's standard; Codex supports it; Gemini doesn't natively. May need a tool-shim layer.
5. **Cost telemetry granularity** — we want per-session attribution. Anthropic Console API supports it, OpenAI does, Gemini partially. Local models are free but compute-bound. Different telemetry sources need a unified attribution layer.

---

## Next Steps (Phase 2)

1. Formalize each primitive above into a TypeScript interface in `src/providers/primitives/`.
2. For each primitive, write a *conformance test suite* — provider-agnostic tests any adapter must pass.
3. Move the existing `IntelligenceProvider` interface into this hierarchy (it becomes `OneShotCompletionProvider`).
4. Define the `ProviderRegistry` — how Instar discovers and selects adapters at runtime.
5. Define the `RoutingPolicy` interface — how high-level Instar code expresses "I need an agentic session, cost-tier medium, must support tool X" without naming a provider.

Phase 2 produces no adapter code; just interfaces, tests, and registry plumbing. Phase 3 ports Anthropic onto it. Phase 4 ports Codex and finds out what we got wrong.

---

## Review Notes (to be filled by reviewers)

*Convergence pass not yet run. Intended reviewers: security, scalability, integration, adversarial, plus cross-model (GPT/Gemini/Grok via `/crossreview`).*
