# Upgrade guide — parallel-dev isolation + per-agent messaging style

This release lands the composition-root wiring that turns on per-topic
worktree isolation when configured, script fixes discovered during the live
Day-2 rollout, and a generic per-agent messaging-style rule in the outbound
tone gate.

## Summary of New Capabilities

- **Parallel-dev isolation is now flippable via config.** Set
  `parallelDev: { phase: "shadow" }` in `.instar/config.json` and topic
  sessions spawn into per-topic worktrees with Ed25519-signed commit
  trailers. Default stays "off" — behavior unchanged for deployments that
  don't opt in.
- **Outbound messages now honor a per-agent style preference.** A new
  `messagingStyle` free-text config field describes how the agent should
  write for its user — e.g. `"ELI10, short sentences, plain words"` or
  `"Technical and terse"`. The `MessagingToneGate` blocks significant
  mismatches via a new `B11_STYLE_MISMATCH` rule. When `messagingStyle` is
  unset, the rule does not apply.
- **Two live-rollout script fixes** for parallel-dev ops tooling: the Day-2
  migration script scans stash labels instead of requiring the
  incident-snapshot at `@{0}`, and the GH ruleset installer now pipes JSON
  bodies correctly and supports non-Enterprise plans.

## What Changed

### `src/core/ParallelDevWiring.ts` (new)

Small composition helper `wireParallelDev()` that reads
`InstarConfig.parallelDev`, loads keys from the `WorktreeKeyVault`, and
returns a ready-to-use `WorktreeManager` plus the shim-root path for
`SessionManager`. Returns `null` when phase is `"off"` so the composition
root can skip wiring entirely.

### `src/commands/server.ts`

Calls `wireParallelDev(...)` before instantiating `AgentServer`. When a
manager comes back, the server is handed the manager + OIDC-enrolled repo
list, and `sessionManager.setWorktreeManager(manager, shimRoot)` flips
session spawn onto worktree isolation.

### `src/core/MessagingToneGate.ts`

Adds `B11_STYLE_MISMATCH` to `VALID_RULES` and a new
`ToneReviewContext.targetStyle?: string` plumbing field. A new
`renderTargetStyle()` method emits the style block into the LLM prompt
inside a `STYLE_BOUNDARY` so it's treated as configuration, not
instructions. The existing fail-open-on-LLM-error semantics are preserved.

### `src/core/types.ts`

Adds `InstarConfig.parallelDev?: ParallelDevConfig` and
`InstarConfig.messagingStyle?: string`.

### `src/server/routes.ts`

One-line change: the tone gate's `review()` call now receives
`targetStyle: ctx.config.messagingStyle` so the per-agent style reaches the
authority.

### `scripts/migrate-incident-2026-04-17.mjs`

Stash verification now scans the full list for the expected label instead
of requiring it at `@{0}`. Integrity invariant — the label must still be
present and unchanged — is preserved.

### `scripts/gh-ruleset-install.mjs`

Switches from `gh api --field` (stringifies nested JSON → 422) to
`gh api --input -` with a real JSON body. Adds `--mode disabled` and
`--skip-trust-root` for operators on Team/Pro plans where the
`file_path_restriction` rule and `evaluate` mode are not available.

## What to Tell Your User

Two new knobs are available in `.instar/config.json`. Both are optional and
default to "off" — existing deployments keep working unchanged.

- **`parallelDev`** — controls whether topic sessions spawn in isolated
  git worktrees. Phase `"off"` is the default. Phase `"shadow"` turns on
  the per-topic worktrees and signs commits locally. Phase `"enforce"`
  also turns on the GitHub-side push gate; don't flip to enforce until a
  working OIDC verifier is configured on the server.
- **`messagingStyle`** — a free-text description of how the agent should
  write for this user. The outbound tone gate uses this as the criterion
  for blocking significantly mismatched messages. Every agent sets its own
  string; there is no universal default.

If you're an instar agent whose user has just asked for a different
communication style ("write to me like I'm a 10-year-old" / "be terse and
technical" / "formal business tone"), you can set `messagingStyle`
accordingly and the outbound path will enforce it automatically — no code
changes required.

If you want the agent to start isolating parallel sessions so they can't
step on each other's uncommitted work, flip `parallelDev.phase` to
`"shadow"` and restart the server.

## Migration notes

None. All new behavior is opt-in via config. Existing deployments keep
working unchanged until an operator sets `parallelDev` or `messagingStyle`
explicitly.
