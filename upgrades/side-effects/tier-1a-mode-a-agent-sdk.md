# Side-effects review — Tier 1.A mode (a) Claude Agent SDK framework

**Version / slug:** `tier-1a-mode-a-agent-sdk`
**Date:** `2026-05-16`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (additive third framework; shares Claude binary + same launch shape with credential-pathway differentiator)
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md`

## Summary of the change

Justin asked for three Telegram-topic modes: (a) Claude with Agent SDK, (b) Claude subscription, (c) Codex. Modes (b) and (c) shipped earlier today in Tier 1.A and the Codex flag fix. Mode (a) was deferred pending clarification — the implementation path depended on interpretation:
  (i) Same `claude` binary with API-key billing (matches Justin's June 2026 Anthropic Max 20x credit notice)
  (ii) The `@anthropic-ai/claude-agent-sdk` npm package (new dep, custom driver)

Going with interpretation (i) — small, low-risk, and matches the most likely intent given Justin's billing-credit context. If wrong, easy revert; if right, mode (a) ships tonight.

Implementation: a third `IntelligenceFramework` value `claude-code-agent-sdk` shares the Claude Code binary and interactive launch flags with `claude-code`. The differentiator is the credential pathway — the launch builder forcibly clears `CLAUDE_CODE_OAUTH_TOKEN` and sets `ANTHROPIC_API_KEY` in the spawned session's env. This routes that session's usage through the Agent SDK $200/mo Max 20x credit bucket instead of the operator's subscription pool.

Credential sourcing (in priority order):
1. `config.sessions.credentials['anthropic-agent-sdk']` if it's an `api-key` kind.
2. Legacy `config.sessions.anthropicApiKey` if it doesn't look like an OAuth token (`sk-ant-oat...`).
3. Falls back to whatever `ANTHROPIC_API_KEY` is already in the spawning process env, with a console warning so operators see they should configure it explicitly.

The IntelligenceProvider factory treats `claude-code-agent-sdk` the same as `claude-code` (reviewer/sentinel/canary calls all run through the local `claude` binary via subscription — the Agent SDK differentiation only affects user-session billing). The `IntelligenceFramework` enum is extended with the new value; activity/process signals add an entry that reuses Claude's pattern data but tags the framework field explicitly so enumeration tools see three distinct frameworks.

Per-topic config can now declare `"topicFrameworks": { "9984": "claude-code-agent-sdk" }` to bill that topic's sessions against the Agent SDK pool.

Files touched:
- `src/core/intelligenceProviderFactory.ts` — enum extended; factory case shares Claude impl; `frameworkFromEnv` accepts `agent-sdk` / `claude-agent-sdk` aliases.
- `src/core/frameworkSessionLaunch.ts` — new `claudeCodeAgentSdkBuilder`; new `anthropicApiKey` option in `InteractiveLaunchOptions`.
- `src/core/SessionManager.ts` — agent-sdk credential lookup before calling the builder.
- `src/core/Config.ts` — `frameworkBinaryPaths` includes `claude-code-agent-sdk` (mapped to the Claude binary).
- `src/core/types.ts` — `frameworkBinaryPaths` and `topicFrameworks` union types extended.
- `src/commands/server.ts` — `_topicFrameworks` / `_defaultFramework` types extended.
- `src/monitoring/frameworkActivitySignals.ts` — agent-sdk shares Claude's activity signal.
- `src/monitoring/frameworkProcessSignals.ts` — agent-sdk gets a sibling signal that re-uses Claude's pattern data but tags `framework: 'claude-code-agent-sdk'` so enumeration sees it separately.
- `tests/unit/frameworkSessionLaunch.test.ts` — 4 new cases for the agent-sdk builder.
- `tests/unit/frameworkActivitySignals.test.ts` — enumeration test updated for 3 frameworks.
- `tests/unit/frameworkProcessSignals.test.ts` — enumeration test updated for 3 frameworks.

## Decision-point inventory

- **Interpretation (i) vs (ii)** — `add` (i). Without Justin's response on the clarifying question, (i) is the smaller, safer bet that ships tonight. If he meant (ii) the revert path is clean: delete the builder + framework value, no downstream consumers break.
- **Share Claude's IntelligenceProvider** — `add`. The Agent SDK distinction is about user-session billing, not reviewer-call billing. Reviewers/sentinels/canaries continue to run through `claude` via subscription (cheap, fast, already proven). No reason to double-bill them through the Agent SDK bucket.
- **Distinct framework value vs credential toggle** — `add` (distinct value). Justin asked for three modes, not "two frameworks with credential variants." The distinct value matches his mental model and the per-topic config UX is clean: `"topicFrameworks": { ... "claude-code-agent-sdk" ... }`. Trade-off: more enum surface to maintain; mitigated by sharing the underlying provider + activity signal.
- **`anthropic-agent-sdk` credential slot** — `add`. Separate slot avoids conflating the Agent-SDK API key with the OAuth subscription token. Operators can configure both side-by-side.
- **Warn on missing key vs throw** — `add` (warn). A failed credential lookup shouldn't crash the spawn; it should produce a session that the operator can debug. The warning is loud and specific.

## Signal vs authority

The launch builder remains recognition data: given a framework + binary + credential, produce the right launch shape. The credential SOURCE is decided upstream (config + per-topic override + env). No authority changes.

## Over-block / under-block analysis

**Over-block:** None. The new framework is purely opt-in. Operators who don't set `topicFrameworks` continue with `claude-code` (subscription) unchanged.

**Under-block:** An operator can configure `claude-code-agent-sdk` for a topic without setting any `ANTHROPIC_API_KEY` anywhere. The launch will warn but proceed — the spawned `claude` will fail to authenticate or fall back to subscription. The fail-mode is loud (warning), and the worst outcome is unexpected subscription billing for a few messages until the operator notices. This is acceptable; the alternative (refusing to spawn) would block testing.

## Level-of-abstraction fit

- Sits inside `frameworkSessionLaunch.ts` alongside the other two builders.
- The credential lookup (Agent SDK slot vs legacy field) lives in `SessionManager.spawnInteractiveSession` next to the existing OAuth-vs-API-key branch — colocated with the related logic.
- No new abstraction layers introduced.

## Interactions

- All Telegram-topic spawn paths now recognize the new value.
- Watchdog / OrphanReaper / StallTriageNurse: the agent-sdk session looks identical to a regular Claude session at the process level (same binary). Sentinels work without changes.
- Hooks (`.claude/hooks/*`): fire for agent-sdk sessions identically to claude-code sessions. The hook events are Claude-Code-specific, not credential-specific.
- Reviewer/sentinel/canary calls: unchanged. They continue through the local `claude` binary via subscription.

## External surfaces

- New supported framework value in `topicFrameworks`: `"claude-code-agent-sdk"`.
- New supported `INSTAR_FRAMEWORK` env values: `agent-sdk`, `claude-agent-sdk`, `claude-code-agent-sdk` (all normalize to `claude-code-agent-sdk`).
- New optional credential slot: `credentials.anthropic-agent-sdk` with `kind: 'api-key'`.
- No new endpoints.

## Rollback cost

Low. Revert the enum extension and the builder; the type errors that result are mechanical to fix (remove the new key from the per-framework records). No state-shape changes.

## Tests / verification

- `npx tsc --noEmit` clean.
- New tests: 4 cases for the agent-sdk builder — argv shape matches Claude's, ANTHROPIC_API_KEY emitted, CLAUDE_CODE_OAUTH_TOKEN cleared, warning fires when no key provided, --resume append works.
- Enumeration tests updated for 3-framework count (activity + process signals).
- 147 framework + integration tests pass across all touched-area suites.
- No real-API smoke test in this commit — that requires Justin's actual API key in his env, which I'm not going to set up autonomously. Manual smoke when he configures it.
