# Anthropic Path Constraints, in plain English

**Companion to:** `04-anthropic-path-constraints.md`
**Audience:** Justin (and any future reader who wants the shape before the details)
**Length target:** 4 minutes

---

## The one-line version

When Instar talks to Claude, it must do so through Justin's Max subscription (via the `claude` CLI) — never through a raw Anthropic API key. There's a middle path that uses prepaid Agent-SDK credits, but it's a drain-first bonus, not a routine route.

---

## Why this exists

In June 2026 Anthropic started billing `claude -p` headless calls and Agent-SDK calls against a separate $200/month pot, at API rates — not against the Max subscription. If Instar quietly fell back to direct `api.anthropic.com` calls with an `ANTHROPIC_API_KEY`, the user would get a surprise bill at full per-token rates — no cap, no warning.

The whole point of provider-portability is that Instar runs the way Justin already pays for it. Subscriptions cap spending by design. API keys don't.

---

## The three paths

1. **Subscription path (the floor — always works).** Instar drives the `claude` CLI exactly the way a human does, with the OAuth token in `~/.claude/credentials.json` which the CLI refreshes itself. Bills against Justin's Max subscription. If the subscription's session envelope hits its limit, the work just slows or stops. No surprise bill.

2. **Agent SDK credit pot (drain first while available).** A separate prepaid $200/month bucket for `claude -p` headless + Agent-SDK calls. Capped by design — when it's empty, calls fail loudly and Instar falls back to the subscription path. Worth draining first because it's already paid for.

3. **Raw API (forbidden).** Direct calls to `api.anthropic.com` with `ANTHROPIC_API_KEY`. Uncapped commercial billing. Banned as a routine path.

---

## What this means in code

- Every code path that wants to call Claude routes through an `IntelligenceProvider` interface. The `ClaudeCliIntelligenceProvider` implementation is the chokepoint; it speaks to the `claude` CLI, not to `api.anthropic.com`.
- The deleted `AnthropicIntelligenceProvider.ts` (Rule 2) is intentionally gone. A new chokepoint — the `anthropic-headless` adapter under `src/providers/adapters/anthropic-headless/` — handles the Agent-SDK-credit-pot path. The lint rule `lint-no-direct-llm-http.js` allowlists exactly those files.
- New raw-HTTP-to-Anthropic anywhere else fails the pre-push gate. The allowlist is small on purpose.

---

## What this DOESN'T change

A user who sets `ANTHROPIC_BASE_URL` and points the `claude` CLI at LiteLLM, a self-hosted proxy, or a Bedrock-style relay is fine. That traffic isn't Anthropic traffic — it's whatever provider sits behind the CLI-shaped wrapper. Instar doesn't ship those overrides or recommend them, but it doesn't block them either. Compatibility, not endorsement.

---

## How this connects to the rest of v1.0.0

- The OpenAI / Codex constraints spec (12) is the mirror of this one, with two paths instead of three (subscription only, no middle pot).
- The cost-aware routing spec (11) consumes both as policy inputs.
- The local-model adapter (Phase 6, via Codex CLI's `--oss --local-provider` flag) is a separate "no provider at all" path — relevant to spec 11's routing but orthogonal to this rule.

---

## What happens if this is wrong

Two failure modes the rule exists to prevent:

- **Silent runaway billing.** Instar in a self-heal loop, calling `api.anthropic.com` directly, eating $200+ before anyone notices. The single chokepoint + lint gate makes this structurally impossible, not just discouraged.
- **Provider-lock drift.** Code paths that quietly assume Anthropic-shaped responses. The `IntelligenceProvider` interface keeps the contract narrow so Codex, local-model, and future providers are routine swaps — not invasive forks.
