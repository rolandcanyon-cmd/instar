# OpenAI / Codex Path Constraints, in plain English

**Companion to:** `12-openai-path-constraints.md`
**Audience:** Justin (and any future reader who wants the shape before the details)
**Length target:** 3 minutes

---

## The one-line version

Codex must run through a ChatGPT subscription, never through an OpenAI API key. There is no middle tier — the rule is simpler than the Anthropic one.

---

## Why this needed its own document

The Anthropic path-constraints spec was written in March 2026, before we had a real Codex adapter. When the Codex adapter landed, its config quietly accepted `OPENAI_API_KEY` as a valid auth mode, with a comment saying "this is the equivalent of Anthropic's Agent SDK credit pot — usage-priced but acceptable."

That framing was wrong. The Agent SDK credit pot is a prepaid bucket capped at $200/month. The OpenAI API key path is uncapped commercial billing at full per-token rates. The two are not analogous. By the time anyone noticed the runaway loop, the bill would already exist.

This spec corrects the drift before Phase 5 implementation locks the assumption in.

---

## The two paths

There are two ways Instar can drive Codex:

- **Subscription path.** Instar runs the `codex` CLI exactly the way a human does — signed in with the OAuth token in `~/.codex/auth.json`, which the CLI refreshes itself. Bills against your ChatGPT subscription. If the subscription's session envelope hits its limit, work just stops or rate-limits. No surprise bill.

- **API key path.** Instar exports `OPENAI_API_KEY` and lets the CLI (or any client library) talk to `api.openai.com` directly. Bills against your OpenAI API account at full per-token rates, with no subscription protection and no spending cap unless one is configured separately.

The rule: subscription only. API key path is forbidden.

---

## How this differs from the Anthropic rule

The Anthropic spec defines THREE paths and a routing policy that drains the middle one first:

1. Subscription (the floor — always works)
2. Agent SDK credit pot (prepaid $200/month — drain first while available)
3. Raw API (forbidden)

For OpenAI there are only two: subscription, or API-key. There is no prepaid middle pot to drain. So the routing decision is simpler — either the subscription path works, or the Codex adapter declines the work. No drain-first math.

The Anthropic constraint says "use SDK first, fall back to subscription, never use raw API." The OpenAI constraint says "use subscription, refuse otherwise."

---

## What this changes in code

Three small but load-bearing changes:

- The Codex adapter's config stops accepting `OPENAI_API_KEY`. Today the file reads the env var into a config field; that path goes away.
- The adapter's credential validation looks for the subscription OAuth shape in `~/.codex/auth.json`. An API-key-only auth file produces a clear error pointing at this spec.
- The Phase 5 routing policy, when it extends to Codex, refuses to route to an API-key-configured Codex adapter. (In practice the adapter will refuse to start in that mode, so this is belt-and-suspenders.)

The existing pre-commit Rule 3 coverage script gets the OpenAI patterns added to its scan list — same shape as the Anthropic check, just different domain and env var names.

---

## What this doesn't change

A user who chooses to set `OPENAI_BASE_URL` and point their `codex` CLI at a local Ollama instance, or at a translation-proxy like LiteLLM that fans out to other backends, is fine. That traffic isn't OpenAI traffic — it's some other provider behind a Codex-shaped wrapper. The substrate stays compatible with that setup the same way it stays compatible with `ANTHROPIC_BASE_URL` overrides on the Claude side. Instar doesn't ship those overrides or recommend them, but it doesn't block them either.

This is the same "compatibility, not endorsement" position the Anthropic spec takes for its proxy carve-out. Phase 6 (open-source / local adapter) actually leans on this: the strategic shortcut is "Codex CLI + Ollama via OPENAI_BASE_URL" rather than building an Ollama adapter from scratch.

---

## What happens next

1. This spec runs through the same review-convergence loop as the others — multi-angle internal review, cross-model review, then your approval stamp.
2. The Codex adapter config is tightened in the same commit batch, so the spec and the code agree from the moment it lands.
3. Phase 5 implementation begins against the already-approved cost-aware routing spec, with the Codex extension following this constraint from day one.
