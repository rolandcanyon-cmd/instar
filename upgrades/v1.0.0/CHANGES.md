# v1.0.0 — Provider Portability — Running Change Log

This log captures every behavior-affecting change in the provider-portability project as it's made (not retroactively). When v1.0.0 is cut, the released `NEXT.md` is condensed from this.

**Branch:** `spec/provider-portability`
**Status:** in progress (Phase 2 starting 2026-05-14)

---

## Pre-release foundation (no behavior changes yet — spec only)

### 2026-05-14 — Phase 1 foundation complete

- **Functional map produced.** Every file in `src/` (441 files) classified by functional cluster and Claude-coupling level (direct / indirect / none). Roughly 63 files direct, 108 indirect, 270 provider-agnostic. See `specs/provider-portability/00-functional-map.md`.
- **Primitives inventory converged.** Two-pass convergence (Pass 1a expanded inventory from 21 → 33 primitives; Pass 1b verification added 3 + 1 split). Final set: 36 universal primitives across 5 layers. See `specs/provider-portability/01-primitives-inventory.md` and `01b-convergence-report.md`.
- **Codex deep-dive done.** Codex CLI mapped against the 36 primitives; 35 cleanly map, 1 renamed, 5 capability-flagged as asymmetric, 15 new optional primitives surfaced. Final expanded set: 51 primitives. See `specs/provider-portability/02-codex-deep-dive.md`.
- **Interactive-pool feasibility prototype passed.** Shell-script prototype drove a long-lived `claude` REPL through 10 prompts via tmux send-keys + capture-pane; all 10 succeeded; subscription billing confirmed. See `specs/provider-portability/prototype/interactive-pool/findings.md`.

### Decisions locked

- Generic naming throughout. No `claude*` / `anthropic*` in shared interfaces. `claudeSessionId` → `providerSessionId`. `.claude/` → `.agent/<provider>/`. `CLAUDE.md` → `AGENT.md` (alias).
- Two Anthropic adapters in Phase 3: `anthropic-headless-sdk` and `anthropic-interactive-pool`. Routing policy decides.
- Routing default: drain Agent SDK credit first, fall back to interactive pool. (User decision 2026-05-14 — overrode my initial proposal.)
- 51 primitives, 36 universal + 15 optional capability-flagged.
- Canonical Instar event vocabulary at the abstraction boundary; adapters normalize.
- Migration is its own workstream (Phase 7) with local-agent testing before release.

---

## What's next

Phase 2 — TypeScript interface design + provider-agnostic conformance test suite. No adapter code yet.

(Entries will appear here as Phase 2 produces concrete artifacts.)
