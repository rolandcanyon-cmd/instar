# Phase 5b — Suggest-and-Confirm, in plain English

**Companion to:** `10-suggest-and-confirm-ux.md`
**Audience:** Justin (and any future reader who wants the shape before the details)
**Length target:** read in 5 minutes

---

## The one-line version

When Instar is about to run a task, it picks a tool (like Claude Code or Codex) and a brain (like Opus or Gemini) to use. Most of the time it just goes. For big decisions, it pings you on Telegram first, remembers what you said, and stops pinging.

---

## Why this exists

Phase 5a built two catalogs — one of brains (models like Opus 4.7, gpt-5.3-codex, DeepSeek V4, Kimi K2.6) and one of tools (frameworks like Claude Code, Codex CLI, Aider). Different tasks fit different brain+tool combinations. Coding fits Claude Code + Opus. Quick translation fits Codex + a cheap model. Summarizing a meeting fits something else again.

The naive answer is: "let the user pick every time." That's annoying. The other naive answer is: "always pick for them, silently." That's invisible — and when Instar quietly switches to a worse pick, you'd never know until results suffered.

Phase 5b is the middle ground: **silence by default, ask when it actually matters.**

---

## The four rules you set

These came from your Telegram answers on 2026-05-15:

### Rule 1 — Telegram, not dashboard

You'll see the "about to run with X, OK?" prompt on Telegram. Never on the dashboard. The dashboard might show a history of past picks for review, but the live ask is Telegram only — because that's where you are when you're AFK, and AFK is when this matters.

For background jobs (scheduled tasks, autonomous loops) there's no Telegram topic to ask in. Those just take the default pick and run. No prompts dropped into a void.

### Rule 2 — Once you say yes, it sticks

If you say "yes, use Claude Code + Opus for code refactors," Instar remembers it forever for tasks of that shape. It won't ask again. But every auto-pick comes with a tiny note in the response — "(auto-picked Claude Code + Opus for code-refactor-typescript)" — so you can intercept if it's drifting wrong.

You don't lose visibility just because you said yes once.

### Rule 3 — Three reasons to re-ask

Instar will re-ask even on a remembered pattern, but only if one of these is true:

1. **Brand-new task type.** Never seen this shape before. (First time, every time.)
2. **Money / quota changed in a real way.** SDK credit pot ran low, subscription hit a session limit, or a new tool / model entered the catalog. Things you'd want to know about.
3. **The catalog itself got less sure.** New evidence dropped the confidence rating on the old pick.

If none of those is true, it just runs the cached pick silently with the auto-pick note. **The default is no ask.** Asking is the exception.

### Rule 4 — Two ways to override

You can change a stuck pick mid-stream:

1. **Slash command** — `/route use Gemini` for one task. `/route prefer Gemini` to update the cache. `/route reset` to clear the cache for this pattern.
2. **Just say it** — "use Gemini for this one" or "switch to Codex" in natural conversation. A small classifier picks up the intent and applies it.

Per your earlier rule that string-matching is brittle, the natural-language detector is an LLM call, not a regex. It catches "go with the cheaper one" and "let's try DeepSeek" too.

---

## What the Telegram prompt looks like

When the gate fires, you'll get a message like this:

> ```
> About to run this task with Claude Code + Opus 4.7.
>
> Task: refactor the imessage adapter to use the new transport
> Pattern: code-refactor-typescript (confidence: HIGH)
> Reason for asking: new pattern, never seen this combination before
>
> Reply with:
>   ok / c / 👍       — go with this pick (cache for future)
>   no / try X        — pick X instead (free-text)
>   /route reset      — clear preferences for this pattern
>   one-shot / once   — use this pick but DON'T cache
> ```

Two-character replies cover the common case. Free-text replies work because of the natural-language detector. There's no "click a button" surface to maintain — Telegram is the operator interface.

---

## What changes for you in practice

Nothing changes until Phase 5b ships. When it does:

- **First time Instar sees a new task pattern**, you'll get a Telegram ping with the proposed pick and the reason. Reply once and forget it.
- **From then on**, that pattern auto-picks silently — with a brief "(auto-picked X)" note in the response.
- **When the cost / quota state shifts materially or the catalog confidence drops**, you'll get re-asked. Otherwise it's silent.
- **Background work never pings you** — those just take the catalog default.

The expected ping rate is **once or twice when a new domain starts, then near-zero**. If you're getting more than a couple of pings a week, the gate is too sensitive and we tune it down.

---

## What's NOT in Phase 5b

Phase 5b is just the user-facing ask-and-cache surface. It sits on top of:

- **Phase 5c** — the routing infrastructure that decides which adapter wins given the pick.
- **Phase 5d** — the benchmarking framework that keeps the catalog honest over time.

Phase 5b can be spec'd cleanly because the catalog and the constraints are now settled. Implementation lands after Phase 5c builds the routing it sits on top of.

---

## What I need from you to ship the implementation

Nothing. The four answers you gave on 2026-05-15 are enough to lock the design. Phase 5c builds next; Phase 5b implementation follows. The spec lives at `10-suggest-and-confirm-ux.md`.
