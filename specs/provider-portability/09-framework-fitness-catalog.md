# Framework Fitness Catalog — v0.2

**Status:** Active, living document. Adopted 2026-05-15 as part of Phase 5a; **scope-refined 2026-05-15** per Justin's directive to focus only on Instar-compatible frameworks.

## What this is

A per-framework assessment of strengths, weaknesses, and best-fit task types for frameworks **that Instar can actually drive**. Frameworks are the wrappers we dispatch models through — Claude Code, Codex CLI, Aider, Goose, Cursor CLI, OpenCode, Plandex.

## Compatibility criteria — what gets a catalog entry

A framework is Instar-compatible if and only if ALL of the following hold:

1. **CLI binary** that accepts prompts via argv, stdin, or instruction file.
2. **Non-interactive / headless mode** — can run unattended (no required TTY interaction, no required GUI, no required browser).
3. **Parseable output** — text or structured (JSON / JSONL events) stdout we can consume.
4. **Self-hosted lifecycle** — Instar spawns and manages the process; not a managed cloud platform that hosts execution itself.

Frameworks that fail any of these criteria are explicitly listed in `## Out of scope (no CLI)` below — with the reason — so a future contributor doesn't waste cycles re-evaluating them. If a vendor ships a CLI later, the framework promotes from out-of-scope to a real entry.

## Why this scope

Two key insights from Phase 5a research drove this catalog being separate from `08-model-fitness-catalog.md`:

1. **The framework matters independently of the model.** Same model produces different ceilings depending on which framework dispatches it. Per `tJB_8mfRgCo`, Opus 4.7's max-effort levels are ONLY exposed inside Claude Code, not via the API — so the choice of framework determines whether you can reach the model's full capability.

2. **Tool friction is the binding constraint.** Per `XlfumXPPrLY` (relaying Jeff Dean's GTC quote), an infinite-speed model still yields only 2-3x gain due to tool friction. Choosing the right framework matters at least as much as choosing the right model.

And one insight from the v0.2 scope refinement:

3. **Instar's selection layer can only suggest frameworks Instar can actually drive.** Listing GUI/browser/IDE-only frameworks in the catalog would surface them as options the routing layer can't honor — a category error. Better to be explicit about scope than aspirational about coverage.

## How to read

Same confidence markers as `08-model-fitness-catalog.md`: HIGH / MEDIUM / LOW (single-analyst) / PROVISIONAL.

---

## Anthropic frameworks (CLI-compatible)

### Claude Code

**Provider.** Anthropic. `claude` CLI binary. Hooks, MCP, plan mode, ultra-review, scaffolding.

**Best fit.**
- `agentic-execution` involving code: only surface that exposes Opus 4.7's extra-high / max effort levels `[tJB_8mfRgCo confidence:LOW]`.
- `code-review` at depth: plan-mode + ultra-review subcommand recommended specifically for 4.7 `[tJB_8mfRgCo confidence:LOW]`.
- Long-running autonomous loops: what Instar's existing infrastructure is built on; empirically robust over 48+ hours of continuous operation `[Pavle Hurin test 3e7gmNPr5Vo confidence:LOW]`.
- The Karpathy loop (`edit→run→measure→keep/revert`): plan-mode + the ultra-review pattern map onto this primitive cleanly.

**Avoid for.**
- Token-tight budgets: plugin context tax — 50k tokens of plugin context loaded before the first message is reported as common `[5ztI_dbj6ek confidence:LOW]`. Paired with $42-burn anecdote `[tJB_8mfRgCo confidence:LOW]`.
- Workflows that depend on temperature / top_p / top_k / thinking_budget when running 4.7 — Claude Code can't bring those back; the model itself rejected them.

**Key characteristics.**
- Hook system with 10+ event kinds (SessionStart, PreToolUse, PostToolUse, Stop, SubagentStart, SubagentStop, PreCompact, etc.) — most developed hook surface among current frameworks.
- MCP tool registry with name-based matching.
- tmux-mediated REPL is what Instar's `anthropic-interactive-pool` adapter leverages for the subscription path.

**Confidence overall.** MEDIUM. Strong direct experience from Instar building against it.

---

### Anthropic Agent SDK

**Provider.** Anthropic. Programmatic SDK + `claude -p` headless CLI path.

**Compatibility note.** Meets the CLI criterion via `claude -p`. The programmatic SDK is also drivable from Instar (Node-to-Node) but the CLI path is what our `anthropic-headless` adapter actually uses today.

**Best fit.**
- Programmatic one-shot completions where structured output is part of the prompt design.
- The credit-pot economic path (Anthropic's $200/month Agent SDK credit pot, post 2026-06-15).

**Avoid for.**
- Workflows that need max effort levels (those are Claude Code-only per the Opus 4.7 entry).

**Research gap.** Nate B Jones transcripts emphasize Claude Code over the raw SDK. No fitness data on the SDK directly `[synthesis-nate-b-jones.md §5 confidence:LOW]`. Phase 5d benchmarking should profile the SDK explicitly.

**Confidence overall.** PROVISIONAL on fitness; HIGH on Instar-compatibility (already in production via `anthropic-headless` adapter).

---

## OpenAI frameworks (CLI-compatible)

### Codex CLI

**Provider.** OpenAI. `codex` CLI binary.

**Best fit.**
- `code-generation` with computer-use: April 16 revamp shipped "background computer use, mid-70s on OSWorld, parallel agents, in-app browser, image gen, 90+ plugins" `[2d9ZmA-4QzU confidence:LOW]`.
- Subscription-economics agentic work: "OpenAI Codex bundles subscription"; "Anthropic blocks subscription routing 10-50x cost" `[85Q9htV2CBE confidence:LOW]`. Codex is the easier path to subscription pricing for agentic loops.
- Tasks where computer-use beats Claude on reliability `[2d9ZmA-4QzU confidence:LOW]`.

**Key characteristics.**
- App-server JSON-RPC surface (`thread/start`, `turn/steer`, `turn/interrupt`, etc.) — richer programmatic surface than Claude Code's CLI flags.
- Sandbox modes: `read-only` / `workspace-write` / `danger-full-access` as first-class config.
- Sky-team computer-use lineage: ex-Workflow/Shortcuts and ex-Apple WebKit engineers `[2d9ZmA-4QzU confidence:LOW]`. Domain expertise visible in the desktop-control quality.

**Avoid for.**
- Workflows that depend on Anthropic's MCP hook system (Codex's hook surface is intentionally Claude-compatible but only has 6 events vs Claude's 10+).

**Empirical addenda from Phase 4 work.**
- Subscription-auth model availability constrained: `gpt-5.2-codex` (the CLI default) retired from ChatGPT accounts 2026-04-14; working models on subscription are `gpt-5.2`, `gpt-5.3-codex`, `gpt-5.4` `[Phase 4 probe 2026-05-15 confidence:HIGH]`.
- CLI 0.130.0 hangs reading stdin when prompt is passed as a positional argument unless caller explicitly closes stdin `[Phase 4 fix 2026-05-15 confidence:HIGH]`.
- `--ephemeral` flag silently hangs on ChatGPT-account auth `[Phase 4 probe 2026-05-15 confidence:HIGH]`.

**Confidence overall.** MEDIUM-HIGH. Strong direct experience from Instar building against it.

---

## Open-source / third-party frameworks (CLI-compatible)

### Aider

**Provider.** Aider-AI (open-source). `aider` CLI installed via pip.

**Best fit.**
- `code-maintenance` with strong git hygiene: Aider commits each AI change as its own commit with descriptive message — clean audit trail for autonomous work `[aider.chat confidence:HIGH (vendor docs)]`.
- Multi-provider workflows: works with Claude, GPT, DeepSeek R1/V3, o1/o3-mini, Gemini, local models via Ollama `[aider.chat / tembo.io confidence:HIGH]`.
- Watch-mode unattended editing: AI! markers in code comments — Aider detects, edits, commits, clears the marker. Hands-off pattern that fits Instar's "long-running job" shape well `[2026 Aider release confidence:HIGH]`.
- Architect mode with `--auto-accept-architect` for autonomous edits without per-step approval `[aider.chat confidence:HIGH]`.

**Avoid for.**
- Tasks needing a structured agentic loop with sub-agents — Aider is pair-programming oriented; less developed sub-agent and parallel-loop story than Claude Code or Codex.

**Key characteristics.**
- Atomic git commits per change — best git-discipline of any framework in this catalog.
- Auto-context: indexes the project to surface relevant files.
- Strongest "best with DeepSeek R1 & V3" alignment of any framework — Aider's open-source community has been the canonical surface for DeepSeek model usage `[aider.chat confidence:HIGH]`. Cross-references to model catalog: pair with DeepSeek V4 entries.

**Confidence overall.** HIGH for compatibility, MEDIUM for fitness. Strong vendor-documented integration story; Instar has not yet built an adapter.

---

### Goose

**Provider.** Originally Block, **moved to the Agentic AI Foundation at the Linux Foundation in 2026** `[knightli.com / docker.com 2026-05 confidence:HIGH]`. `goose` CLI installed via curl-pipe-bash.

**Best fit.**
- Scripted / cron-style automation: `goose run -t "instructions here"` for one-shots, `goose run -i instructions.md` for file-based. Direct crontab compatibility `[goose-docs.ai confidence:HIGH]`.
- Multi-task orchestration: explicit meta-agent / task-agent split with "model empathy" — the framework recognizes different sub-tasks suit different models `[xnG8h3UnNFI confidence:LOW]`. Conceptually adjacent to what Instar's selection layer does.
- Local-model + Docker Model Runner workflows: native Docker Model Runner integration `[docker.com 2026 confidence:HIGH]`.

**Avoid for.**
- Tasks needing the deepest model integration on a single provider — Goose is multi-provider-by-design; its strength is breadth, not provider-specific feature depth.

**Key characteristics.**
- Open-source, vendor-neutral by governance (Linux Foundation).
- Native CLI from day one (vs. Cursor's recently-added CLI).
- "Model empathy" pattern: the framework can route different sub-tasks to different models in a single session.

**Confidence overall.** MEDIUM. Single Nate B Jones reference plus official docs.

---

### Cursor CLI (`cursor-agent`)

**Provider.** Cursor (Anysphere). `cursor-agent` CLI — recently added on top of the long-standing IDE.

**Compatibility note.** Headless `-p` print mode designed for scripts and CI. Output formats include `json` (single result), `stream-json` (NDJSON events: system init, deltas, tool calls, result), and `text`. **This is a real CLI, not an IDE wrapper** — drivable from Instar exactly like Claude Code or Codex `[cursor.com/docs/cli/headless confidence:HIGH]`.

**Best fit.**
- Structured code review: `cursor-agent -p --output-format json "review these changes for security issues" | jq '.result'` — clean machine-readable output `[cursor.com confidence:HIGH]`.
- Batch operations: `find src -name "*.js" | while read f; do cursor-agent -p --force "add JSDoc comments to $f"; done` — Cursor explicitly documents this pattern `[cursor.com confidence:HIGH]`.
- CI/CD pipelines: non-interactive mode designed for it.

**Key characteristics.**
- NDJSON streaming events for progress UI / jq pipelines — closest to Codex CLI's `--json` format in this catalog.
- Multiple model support (`-m gpt-5` etc.).
- IDE coupling is optional — pure-CLI use is supported.

**Avoid for.**
- Long-running stateful agentic loops — Cursor CLI is positioned as "agent for terminal" but most documented usage is per-task, not long-horizon. Phase 5d benchmarking should profile its long-running behavior before routing autonomy-heavy work here.

**Confidence overall.** MEDIUM. Strong vendor docs, no Instar empirical yet.

---

### OpenCode

**Provider.** Open-source community. MIT licensed. 150K+ GitHub stars.

**Best fit.**
- Provider-flexibility paramount: 75+ provider support — every model in our catalog plus many more `[morphllm.com / bytebridge confidence:HIGH]`.
- Local-model workflows via Ollama integration: privacy-first design that stores no code or context data — fits regulated/air-gapped scenarios `[nimbalyst.com confidence:HIGH]`.
- LSP integration: stronger language-server awareness than most CLI agents.
- Vendor-neutral fallback: when no single provider's framework is the right answer, OpenCode is the multi-provider escape hatch.

**Key characteristics.**
- "ACP integration" (Agent Communication Protocol per nimbalyst.com) — may be a future portability lever.
- Privacy-first storage design.

**Research gap.** Unattended/autonomous operation capabilities not explicitly documented in our search. Phase 5d should probe headless behavior before depending on OpenCode for long-running jobs.

**Confidence overall.** MEDIUM. Strong community signal (star count + MIT license + provider breadth); thin on fitness numbers.

---

### Plandex

**Provider.** Plandex AI (open-source).

**Best fit.**
- Large multi-step projects with multi-file changes — Plandex was explicitly designed for "large projects and real world tasks" `[plandex GitHub confidence:HIGH]`.
- 2M token context directly (~100k per file), tree-sitter project maps for repos up to 20M tokens `[plandex-ai/plandex confidence:HIGH]`. Largest project-context capacity of any framework in this catalog.
- Full autonomy mode: "fully manual step-by-step review process to a full autonomous mode where Plandex plans, executes, debugs, and commits changes on its own" `[plandex confidence:HIGH]`. Direct fit for Instar-style long-running loops.
- Self-hosted server: Dockerized local mode for full data sovereignty.

**Key characteristics.**
- 30+ language support via tree-sitter.
- One-line zero-dependency CLI install.
- Choice of cloud-hosted vs self-hosted server.

**Research gap.** No fitness benchmark data in our research set. Plandex is well-documented for capability but not benchmarked against the other CLI agents in our catalog.

**Confidence overall.** MEDIUM. Strong vendor docs, no third-party benchmarks found yet.

---

## Patterns, not frameworks

### Karpathy's nanochat / Open Brain pattern

Not a framework you adopt directly — a PATTERN to evaluate other frameworks against. The durable agentic primitive: `edit→run→measure→keep/revert` `[xnG8h3UnNFI, dxq7WtWxi44 confidence:LOW]`. Empirical wins cited: Skypilot 910 experiments under $300; Tobi Lutke 19% gain; 700 experiments overnight with 11% speedup.

A framework's value is partly proportional to how cleanly it can express this loop. Claude Code's plan-mode + ultra-review, Plandex's full-autonomy mode, Aider's watch-mode, and Cursor CLI's batch pattern all map onto this primitive at varying levels of explicit support.

---

## Out of scope — no CLI Instar can drive

The following frameworks were considered and explicitly excluded. Listed here so future contributors don't re-evaluate.

| Framework | Why excluded | When to revisit |
|---|---|---|
| **Claude for Chrome** | Browser extension only. Permission model and recording UX are browser-bound. | If Anthropic ships a headless `claude-browser` CLI binary. |
| **Co-Work / Claude desktop computer-use** | GUI desktop agent. No headless mode. | If Anthropic ships a CLI surface for computer-use. |
| **Claude Design** | GUI design tool, SVG/JSX-first via web/desktop interface. | If a `claude design --headless` mode ships. |
| **Dispatch** | Anthropic-managed server-side `/loop` platform. Instar would be a CLIENT of Dispatch, not a driver of it. Different category — could integrate as a transport target, but not as a framework Instar dispatches models through. | Phase 7+ — evaluate whether Dispatch is worth integrating as a deployment target. |
| **Conway** | Unannounced enterprise product (per `ro5jpbi5uYc` leak). CNW.zip format and sidebar UI imply non-CLI shape. | When Conway ships publicly with documented CLI. |
| **Atlas / Chronicle (OpenAI browser)** | Browser-side agent runtime. No CLI documented. | If OpenAI ships a headless equivalent. |
| **OpenClaw** | Third-party general-purpose agent — browser/GUI shape per Nate B Jones references. Also flagged as "unsafe" by source `[kVPVmz0qJvY confidence:LOW]`. | If a hardened CLI variant ships. |
| **OpenAI Apps SDK** | Programmatic SDK; not a framework wrapping models for autonomous loops. Different category. | N/A — different abstraction layer. |
| **Continue.dev** | Primarily VSCode/JetBrains extension; CLI presence uncertain. | Re-evaluate if a headless mode emerges. |
| **Cline / Roo Code** | VSCode extension. | If a CLI variant ships. |
| **Sourcegraph Cody CLI** | Has a CLI but discontinued / sunset earlier in 2026 per public messaging. | If revived. |

If a framework not in this catalog or this exclusion list emerges, it should be evaluated against the four compatibility criteria and added to either the active catalog or this exclusion table in the SAME PR as its evaluation.

---

## Cross-framework routing heuristics

The routing intuitions for framework selection, expanded to reflect the v0.2 scope. The selection layer (Phase 5b) implements them; the benchmark layer (Phase 5d) validates them.

1. **Code work needing max-effort modes → Claude Code** with Opus 4.7. Other paths can't reach the same ceiling on the same model.
2. **Code work under subscription economics → Codex CLI** with `gpt-5.3-codex`. Anthropic's subscription routing has 10-50x cost penalty per `85Q9htV2CBE`.
3. **Programmatic one-shot completions → Anthropic Agent SDK (via `claude -p`)** OR **Codex CLI's exec mode**. Choice driven by which provider's credit pot has capacity.
4. **Long-horizon autonomous loops, Anthropic stack → Claude Code** (most validated for 48+ hour operation in Instar's experience).
5. **Long-horizon autonomous loops, multi-provider → Goose** (model-empathy split lets a single session route sub-tasks to different models) OR **Plandex** (large-project full-autonomy mode).
6. **Multi-file batch operations / CI/CD pipelines → Cursor CLI** (`cursor-agent -p` with `--output-format json` is the cleanest pipeline-friendly output in this catalog).
7. **DeepSeek-model workflows → Aider** (canonical community surface for DeepSeek). Pair with the DeepSeek V4 entries in the model catalog.
8. **Vendor-neutral / privacy-first → OpenCode** (75+ providers, no code/context retention).
9. **Air-gapped self-hosted → Plandex (self-hosted server)** or **OpenCode (with Ollama)**. Self-hosted Plandex has the largest project-context capacity (2M direct, 20M with tree-sitter maps).
10. **Tasks requiring structured approval events → Codex CLI** (app-server has structured requestApproval events natively; Claude Code scrapes terminal).
11. **Tasks requiring native subagent lifecycle hooks → Claude Code** (Codex has no native subagent hook events; adapter synthesizes from app-server thread notifications).

---

## Update discipline

Same as the model catalog. Frameworks evolve more slowly than models — most framework entries shift on a quarterly cadence rather than monthly — but the same Rule-3 enforcement applies: any change to a framework's fitness profile lands in the same PR as the consuming routing-rule change.

**Compatibility-criterion check** runs at every catalog update: any framework being added must pass all four criteria, and any framework dropping a criterion (e.g., a CLI getting deprecated) moves to the exclusion table in the same PR.

---

## Research sources

- `research/synthesis-nate-b-jones.md` — Nate B Jones transcripts (Anthropic / OpenAI Western frontier coverage). Confidence LOW (single-analyst).
- **Web research 2026-05-15** — official docs and 2026-current third-party analyses (aider.chat, plandex GitHub, goose-docs.ai, knightli.com, docker.com, cursor.com/docs/cli, morphllm.com, nimbalyst.com, bytebridge, dev.to). Confidence ranges MEDIUM to HIGH depending on source.
- **Phase 4 empirical probes** — direct observations from building the Codex adapter. Confidence HIGH.

Next research passes will add:
- Direct empirical profiling of Aider, Goose, Cursor CLI, OpenCode, Plandex under the same workload (Phase 5d benchmarking).
- Profile of Anthropic Agent SDK distinct from Claude Code.
- llm (Simon Willison) — lightweight one-shot CLI worth evaluating for the `OneShotCompletion` substrate primitive.
- Gemini CLI if/when Google ships a credible non-interactive surface.

The catalog graduates from `v0.2` to `v0.3` when at least three entries reach `HIGH` confidence via empirical verification.
