---
title: Process Health Dashboard Tab
slug: process-health-dashboard-tab
author: echo
created: 2026-05-27
owner: echo
status: draft
eli16-overview: PROCESS-HEALTH-DASHBOARD-TAB-SPEC.eli16.md
topic: 13201
---

# Process Health Dashboard Tab — visible, calm read surface for the Failure-Learning Loop

**Status:** DRAFT v2 (post-round-1). Author: echo · Created: 2026-05-27 · Topic: 13201
**Companion:** `PROCESS-HEALTH-DASHBOARD-TAB-SPEC.eli16.md`

> **Convergence changelog (v1 → v2).** Round 1 (5 internal reviewers: lessons-aware, security, scalability, adversarial, integration) all code-grounded — found 5 blockers + ~14 majors. All material findings folded in. Highlights:
> - **Glance test was untestable** (lessons F1) — "or LLM" let implementers skip the human gate; no defined LLM harness. → §6 makes it AND: human glance at PR review is required, *plus* a defined jsdom + Tier-1 LLM smoke with the exact rubric prompt, run against THREE fixtures (empty / one-flagged / high-volume).
> - **Detail drawer escape hatch** (lessons F2) — "allowed to be more data-dense" let an implementer slide a debug table in. → §4.5 rewritten: ALL three UX rules apply inside the drawer too; raw JSON forbidden; same LLM smoke runs against drawer-open state.
> - **No XSS/rendering-safety contract** (security B1 + adversarial B1) — every rendered field originates from untrusted sources (commits, agent-diagnosed POST bodies, classifier output). → New §4.6 "Rendering safety" mandates `sanitizeForDisplay()` + `textContent`/`escapeHtml`-only + a negative-test fixture (XSS payloads in `summary`/`recommendation`/`filedBy`).
> - **Length / Unicode layout-bomb DoS** (adversarial B2 + B3) — `summary`/`recommendation`/`filedBy` are unbounded TEXT; a 100k-char or zero-width-joiner-spam record breaks the calm-card layout; bidi-control + confusables enable fake-authority spoofing in the calm visual. → `sanitizeForDisplay()` enforces NFC + control-char strip + length caps (240/320/64) + bidi-control strip + mixed-script flag.
> - **Unbounded `listInsights()`** (scalability B1) — no LIMIT, polled every 60s forever. → §4.3 specifies `?limit=50` server-side default + ETag/304 + add an index on `failure_insights(discovered_at)`.
> - **No visibility-gating** (scalability M1 + security M3) — existing dashboard has zero `visibilitychange` listeners; spec's "while visible" would default to "forever." → §4.3 mandates Page Visibility API + active-tab gate + lifecycle contract (M3) with AbortController.
> - **3-endpoint race** (adversarial M1) — uncoordinated GETs render inconsistent state. → `Promise.all` + single coordinated render per tick; partial fail → skip render (keep prior) with subtle "last updated" stamp.
> - **Maturation source not pinned** (adversarial M3) — counts were a spoofable proxy. → Server adds `rollout: { stage }` to `/failures/analysis` from config (NOT inferred from counts).
> - **CLAUDE.md migration parity HALF-spec'd** (integration F1) — only `generateClaudeMd` (new agents). → §7 specifies a `migrateClaudeMd` content-sniff insertion (File Viewer precedent: a separate H3 section, not amending an inline bullet).
> - **Test infra mismatch** (integration F2) — spec said "Playwright/JSDOM" but neither is in deps. → §6 picks **jsdom** (lighter, per-file `@vitest-environment jsdom`; add to devDependencies); Playwright explicitly out of scope.
> - **Copy with config keys** (lessons F3 + security M2) — 503 copy quoted `monitoring.failureLearning.enabled`. → §4.3 pins user-facing copy in plain English; config-key hints behind a separate "for operators" affordance.
> - **Record rows in log-line voice** (lessons F5) — bullets + monospace paths + middle-dots read as a debug log. → §4.2(c) rewrites to sentence-shape ("A concurrency issue was captured in `src/core/Foo.ts` — attributed to the ledger spine, about two days ago.").
> - **Tunnel exposure of internal identifiers** (security M1) — `causeCommitOid`/`specPath`/`filedBy` over a PIN-shared tunnel. → §4.3.1 NEW: render only the operator-safe subset always; full identifiers gated behind the Detail drawer AND a server-detected loopback origin.
> - **Trust dependency on classifier sanitization** (adversarial M4) — calm cards amplify trust; if classifier ever lets untrusted text into recommendations, the whole calm surface lies. → §4.9 NEW: explicit upstream-trust documentation.
> - **Severity rendered as visual urgency** (adversarial M2) — gameable. → §4.2 specifies severity as plain inline text, not color/icon weight; headline-decision rule pinned to verified insights (NOT raw severity counts).
> - **Minors** (color palette bar, copy specifics, m5 lock surface-only, refresh visuals, post-ship verification) — all folded into §4 + §6 + §8.

---

## 1. Problem — live but invisible

The Failure-Learning Loop shipped + activated on Echo (2026-05-27, v1.3.27). It captures attributed failures, classifies them, and (once enough diverse evidence accumulates) the analyzer surfaces process-gap insights with their verify-it-worked status. All of that is reachable via `GET /failures`, `/failures/analysis`, `/failures/insights` — **but the human has nothing to look at.** Without a visible surface: data accumulates silently; promotion decisions are blind; the loop's whole pitch is invisible.

## 2. The non-negotiable UX constraint (drives every decision)

Justin's direction ([[feedback_dashboard_human_friendly_not_debug]], saved as durable preference applying to ALL future dashboard work): **simple, large fonts, easy to digest, NOT looking like some debug logs.**

1. **Large, readable type** — sized for a glance from across the room and from a phone. No 12-px developer-console text.
2. **Plain-English summaries front and center** — what's happening, what to look at, what to decide. Counts/tables/raw records go deeper, never at the top.
3. **No debug-log aesthetic** — no monospace walls, no terminal output, no JSON dumps as the primary surface. Calm, readable, designed for the human glance.

**Glance-test acceptance gate (mandatory, both halves required — AND not OR; spec §6 enforces):** a non-engineer reviewer opens the rendered page and within 5 s can answer "what's happening / what should I look at" in plain English. The LLM smoke is a pre-flight check, not a substitute.

## 3. What already exists (extend, not reinvent)

- **Dashboard frontend** (`dashboard/index.html`, single 8004-line SPA, served via `express.static`) with an established **tab framework**: `.tab-bar .tab` (`.active` class), `.tab-content` (`.hidden` class). Existing tabs: Sessions, Secrets, Threadline, Files (+ many more). We add one more.
- **Data sources** (live + verified on Echo): `GET /failures`, `/failures/:id`, `/failures/analysis`, `/failures/insights`. **NB (server-side prerequisites added in this spec):** `/failures/insights` gets a default `?limit=50` server clamp + an index on `failure_insights(discovered_at)`; `/failures/analysis` response gets a `rollout: { stage }` field populated from `config.monitoring.failureLearning.*` (NOT inferred from counts). All three GETs get ETag/304.
- **PIN-gated access** (the dashboard's existing 6-digit-PIN auth, exchanged for the bearer token). No new auth surface.
- **No browser test infra today.** No `playwright`, no `jsdom`, no `happy-dom` in deps; `vitest` is Node-environment by default. This spec adds `jsdom` as a devDependency + uses per-file `@vitest-environment jsdom`. Playwright is explicitly out of scope.

## 4. Design

### 4.1 Layout — top-to-bottom, large-to-small (the calm-read principle)

```
┌─────────────────────────────────────────────────────────────┐
│  Process Health                                              │  ← tab title, 22+px
│                                                              │
│   ★  Healthy — no patterns flagged this week                │  ← BIG headline ≥24px
│      4 issues recorded so far · all linked to a known cause  │  ← plain-English subline 17–18px
│                                                              │
│  Patterns to know about                                      │  ← section header 20–22px
│                                                              │
│     (Nothing flagged yet. The monitor needs to see a wider   │  ← warm empty-state
│      variety of issues before it's confident enough to       │
│      surface a pattern — that's expected this early.)        │
│                                                              │
│  What's been captured                                        │
│                                                              │
│     A concurrency issue was captured in `src/core/Foo.ts`    │  ← sentence-shape, not log line
│     — attributed to the ledger spine, about two days ago.    │
│                                                              │
│     A config-parse problem in `failure-analyzer.md`,         │
│     attributed to the analyzer job, five days ago.           │
│                                                              │
│   [Show more]                                                │  ← paginated, +50 at a time
│                                                              │
│  Maturation                                                  │
│                                                              │
│     ● Dark                       done                        │
│     ● Capture-only         ← you're here                     │  ← from /failures/analysis.rollout.stage
│     ○ Insight push         pending watch period              │
│     ○ Default for all agents                                 │
│                                                              │
│  [Detail ▾]    ← collapsed by default; UX rules apply inside │
└─────────────────────────────────────────────────────────────┘
```

**Visual rules — measurable bars (CSS-binding):**
- Body type **≥17 px**; section headers **≥20 px**; headline status line **≥24 px**.
- Line-height **1.5–1.6**.
- Sans-serif (existing dashboard font). **No monospace outside literal code/path tokens** — and even those tokens use `<code>`, never a `<pre>` block.
- Spacious padding; no compact tables; no `<table>` with row-banding anywhere in the tab (incl. Detail drawer).
- **Color palette bar (lessons F8):** body text uses ONLY the dashboard's existing default text color from the current `<style>` block. The ONLY new colors introduced are two status tokens (`--ph-status-healthy` = a calm green, `--ph-status-attention` = a calm amber). No alarming red anywhere in this tab — capture-only observations are never an emergency. No alternating-row coloring. No background fills on records.
- **No spinner / no skeleton / no flicker on refresh.** Data swaps in only if it actually changed (diff-aware render keyed on record id / insight id). A small unobtrusive "updated just now / 1m ago" stamp at the bottom corner reflects refresh; nothing else moves on a no-change tick.

### 4.2 Sections (top to bottom — most-important first)

**(a) Headline status (the glance answer).** One line: `★ Healthy — no patterns flagged this week` OR `▲ Attention — N pattern(s) ready for your decision`. Subline: one plain-English sentence ("N issues recorded so far · all linked to a known cause" or "N recorded · M still being traced").

**Headline-decision rule (pinned, adversarial M2 + m3):** the headline is `Attention` ONLY when `listInsights({status:'discovered'}).length > 0` — i.e., the loop has crossed its post-threshold + diversity-gated bar that vouches for the signal. **Severity counts are never used to drive the headline color or text.** No raw-`severity === 'high'` input. This makes the headline ungameable by an adversarial flood of high-severity-tagged records.

**(b) Patterns to know about (the insights board).** Each thresholded insight is a **plain-English card** with: the pattern summary (sanitized + capped per §4.6), the recommendation, the loop-status (discovered / acted-on via X / verified-effective / verified-ineffective / inconclusive), and the supporting-evidence as a sentence ("seen in N changes across M distinct sources"), not a table. A small "loop's recommendation" label sits above the recommendation text so the operator's calm-card pattern-match knows this is machine-generated text from a process under suspicion, not editorial copy (adversarial B3).

**(c) What's been captured (recent failures, redacted, sentence-shaped).** Up to ~10 most-recent records, each as **one full English sentence** — NOT a bullet, NOT a row in a table. Example: *"A concurrency issue was captured in `src/core/Foo.ts` — attributed to the ledger spine, about two days ago."* Filepath is the only monospaced token; everything else is prose. **`detail.full` NEVER served** (already structurally enforced server-side — loop spec §4.8). A `[Show more]` link **paginates in chunks of 50 records** via explicit `?limit=50&before=<ts>`; never an unbounded fetch (adversarial m2 / scalability M2). Severity, if shown at all, is plain inline text ("low/medium/high"), never a color or icon weight (adversarial M2).

**Aggregated `filedBy` panel (above the recent rows, adversarial B3 fix):** a tiny prose summary — "In the last 30 days, filers were: ledger spine (12), analyzer job (4), agent-diagnosed (3)." — so a flood from one author surfaces structurally instead of by reading rows.

**(d) Maturation track (where the rollout is).** The four stages (Dark / Capture-only / Insight push / Default-on) as a **vertical visual list** with checkmarks and an explicit "← you're here" marker. **The current stage is read from `/failures/analysis.rollout.stage`, which is computed server-side from `config.monitoring.failureLearning.*` (NOT inferred from counts).** Each stage has a one-line plain description. Promotion eligibility surfaces here when the loop's analyzer signals it; the actual flag-flip is **NOT done from this tab** (see §5 / locked).

**(e) `[Detail ▾]` — collapsed by default. Same UX rules apply inside (lessons F2):** ≥17px body, no monospace blocks for non-literal content, no JSON dumps, no `<table>` with row-banding. "More data-dense" means more *labeled list items per section*, not "we relax the typography." Raw JSON is forbidden. The Detail subtree renders ONCE on open from the most-recent analysis payload; subsequent ticks update it in place only if it's open. The Tier-1 LLM smoke (§6) runs against the drawer-open state with the same rubric.

### 4.3 Data wiring (visibility-gated, coordinated, abort-safe, diff-aware)

**Lifecycle contract (scalability M1 + M3, security M3):**
- One module-level state object: `{ intervalId: number | null, inFlightController: AbortController | null, lastSnapshot: Snapshot | null }`.
- **Start polling** when `switchTab('process-health')` activates the tab AND `document.visibilityState === 'visible'`. Both gates required (AND).
- **Stop polling** (`clearInterval`, null id, `abort()` any in-flight) on `switchTab(other)` OR `visibilitychange → hidden`.
- **Resume** on `visibilitychange → visible` while tab is active: one immediate refresh + re-arm interval.
- **Backoff to 5 minutes** after 5 consecutive identical (ETag-304) responses, reset to 60s on the next material change.

**Per tick (coordinated, abort-safe):**
- A new `AbortController` is created; the prior in-flight (if any) is `.abort()`-ed first.
- `Promise.all([fetch(/failures/analysis), fetch(/failures/insights?limit=50), fetch(/failures?limit=10)])` — single coordinated render. If ANY fetch fails (timeout, 5xx, abort), the WHOLE tick is dropped — the prior render stays + the corner stamp updates to "last updated Ns ago — refresh paused" (adversarial M1).
- All three GETs use `If-None-Match` against the ETag from the last successful fetch; a 304 short-circuits the render (no DOM mutation).
- **Diff-aware render:** changes detected by record-id / insight-id; the renderer mutates only changed nodes (no full `innerHTML` wipe). New data added by prepend; removed data by detach. No event-listener leaks (collapse handlers attached to DOM stay valid because their host nodes persist across ticks).

**Server-side prerequisites (this spec adds — they're small, additive, no breaking change):**
- `/failures/insights` gains a default `?limit=50` server clamp (max 200) + DB migration adding `CREATE INDEX IF NOT EXISTS idx_insights_discovered ON failure_insights(discovered_at)`.
- `/failures/analysis` response gains `rollout: { stage: 'dark' | 'capture-only' | 'insight-push' | 'default-on', enabled: boolean, insightTelegramEscalation: boolean }`, computed from `ctx.config.monitoring.failureLearning.*`.
- All three GETs gain ETag/`If-None-Match` support (`crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0,16)`).

### 4.3.1 Tunnel-aware field exposure (security M1)

The dashboard is reachable over a Cloudflare tunnel. A PIN-holder is anyone with the 6-digit PIN — not necessarily a repo operator. Some `FailureRecord` fields are operationally useful but expose repo internals:

- **Always visible** (operationally meaningful, low leak): `summary` (sanitized + capped), `category`, a **DERIVED human label** for attribution (e.g. "ledger spine" — derived from `initiativeId` via a friendly-name map; falls back to `initiativeId` if no map entry), relative time, status badge.
- **Hidden over tunnel, visible only on loopback** (Detail drawer ONLY, and only when the request reached the server from `127.0.0.1` with no `X-Forwarded-For`): `causeCommitOid`, `fixCommitOid`, `specPath`, `prNumber`, `toolchainRef`, `buildSkill`, raw `filedBy`. The Detail drawer shows: *"Hidden over tunnel — open the dashboard locally to see commit OIDs and internal paths."*
- The renderer queries a new lightweight `GET /failures/visibility-mode` once on mount that returns `{ mode: 'loopback' | 'tunnel' }` based on the server-side `req.socket.remoteAddress` + `X-Forwarded-For` check (mirrors the existing `/internal/*` guard pattern). Frontend uses the mode to gate which fields render. This is defense-in-depth (real protection is in the renderer not reading hidden fields when `mode === 'tunnel'`); server-side, the routes still return the fields for backward compat.

### 4.4 Integration into `dashboard/index.html`

- **Tab button** in `.tab-bar`, label "Process Health". Position: after "Threadline" or "Files" (consistent with existing ordering).
- **`.tab-content`** section, `id="process-health-tab"`, hidden by default.
- **CSS** appended to the existing `<style>` block under `/* process-health tab */`. Semantic class names (`.ph-headline`, `.ph-section-title`, `.ph-pattern-card`, `.ph-record-row`, `.ph-maturation`, `.ph-detail-collapse`).
- **JS** as a single `<script>` block. **Splitting `dashboard/index.html` is explicitly out of scope** (integration m4 foreclosure) — that's a separate spec touching `express.static` mounting + cache headers.

### 4.5 Empty / disabled / error copy (PINNED — no config keys in user copy, lessons F3 + security M2)

- **Empty state (loop on, no patterns yet):** *"Nothing flagged yet. The monitor needs to see a wider variety of issues before it's confident enough to surface a pattern — that's expected this early."* (Avoid "analyzer" — that's engineer voice.)
- **Empty state (no records yet):** *"No issues recorded yet — that just means nothing has come through since this was turned on."*
- **503 / feature disabled:** *"Process Health isn't turned on for this agent yet. Once it is, this page will show what it's noticing."* + a small `[for operators ▾]` collapse that, when opened, shows the operator-facing one-liner with the config key (still no `<code>` block — inline `<code>` only).
- **Refresh paused (any fetch failed this tick):** *"Couldn't refresh just now — showing the last good view. Will retry."* (small subtle text, no alarm color.)
- **Mixed-script flag on a row (adversarial B3):** a small `⚠` glyph + tooltip *"This row's text mixes scripts that can look alike — verify it."*

### 4.6 Rendering safety contract (security B1 + adversarial B1/B2/B3 — load-bearing)

**All dynamic field values flow through one helper, `sanitizeForDisplay(value, fieldKind)`, before reaching the DOM.** The helper:
1. **Type-check + null-coerce** (`null`/`undefined` → empty string).
2. **NFC-normalize** Unicode (`String.prototype.normalize('NFC')`).
3. **Strip C0/C1 control characters** except `\n` and `\t`.
4. **Strip Unicode bidi-control characters** (U+202A–U+202E, U+2066–U+2069) — prevents fake-authority spoofing via RTL override.
5. **Collapse** runs of `>1` consecutive `\n` to one; cap consecutive whitespace at 4.
6. **Length cap by field kind:** `summary` 240 chars; `recommendation` 320; `filedBy` 64; `detail.redacted` 2 KB (Detail drawer only). Truncation is **grapheme-safe** (`Intl.Segmenter`) — never slice mid-surrogate. Truncated values end with `…` and the full text is available via a per-record `[expand]` affordance inside the Detail drawer.
7. **Mixed-script detection:** if the sanitized string mixes Latin with confusable Cyrillic/Greek lowercase letters, the renderer adds the `mixed-script` marker (§4.5) — does NOT silently rewrite the text.

**DOM insertion rule (mandatory):**
- Use `element.textContent = sanitizedValue` for ALL dynamic field values. NO naked `innerHTML` interpolation of dynamic values. If `innerHTML` is needed for structural HTML (e.g., constructing a card template), wrap every interpolated value in the existing `escapeHtml()` helper (`dashboard/index.html` line 3989).
- CSS class names and ARIA attribute names are LITERALS — never computed from response data.
- No `javascript:` URLs, no `eval`, no `Function(...)` constructed from response data.

**Server-side hardening (separate, but flagged as the real fix):** the spec recommends a follow-up to apply equivalent caps + sanitization at `POST /failures` boundary in `FailureLedger` (currently no server-side length cap on `summary`). The dashboard cap is defense-in-depth.

### 4.7 — (reserved)

### 4.8 — (reserved)

### 4.9 Upstream trust dependencies (adversarial M4)

This tab's calm-card presentation **trusts** that:
- `InsightRecord.summary` and `.recommendation` are composed from a fixed template + structured fields (per loop spec §4.4 BL-3), never by concatenating raw `FailureRecord.summary` text into the recommendation. If that contract ever changes, this tab must also change (apply `sanitizeForDisplay()` to insight fields at strict caps).
- `FailureLedger.toApiView` strips `detail.full` (loop spec §4.8, structurally enforced today — verified at `src/monitoring/FailureLedger.ts:687`). If the API ever exposes `full`, the tab's E2E test (§6) catches it via the "never shows `detail.full` substring" assertion.
- The analyzer's source-diversity gate (≥K distinct sessions ∧ ≥J distinct cause-commits, loop spec §4.4) is the upstream guard that makes `status === 'discovered'` insights trustworthy enough to drive the headline `Attention` signal. If those gates weaken, the headline becomes gameable.

A change to any of the above MUST trigger a re-review of this spec.

## 5. Open questions (resolved + remaining)

1. ~~**Refresh cadence**~~ → **RESOLVED: 60 s** with visibility/active-tab gating + 5-min backoff after 5 consecutive 304s.
2. ~~**Empty-state copy**~~ → **RESOLVED in §4.5** (pinned).
3. ~~**Promotion action**~~ → **RESOLVED: surface-only, locked**. The Process Health tab is **strictly read-only**. NO `POST`/`PATCH`/`DELETE` against `/failures*` or `monitoring.failureLearning.*` is wired here. Promotion is the rollout board's twice-weekly driver's responsibility. If a future iteration ever adds a promote button, the flag-flip MUST be gated by a confirmation requiring the bearer token alone (not the PIN), since the PIN is often shared more broadly than repo-write authority.

**Remaining for convergence:** none material.

## 6. Testing (3-tier + glance test, NON-NEGOTIABLE)

**Test infra:** jsdom (added to devDependencies) + per-file `// @vitest-environment jsdom`. **Playwright is OUT OF SCOPE** (would add ~300 MB of browsers and a CI lane; not justified for a read-only data tab).

### 6.1 Unit (`tests/unit/process-health-renderers.test.ts`, jsdom)

Renderer functions are pure: `data → DOM nodes`. Test each section in three states (empty / one-flagged / high-volume) — both sides of every boundary, per Testing Integrity. Specifically:
- Empty state (zero failures, zero insights) → headline `Healthy`, the warm empty-state copy from §4.5 verbatim.
- One pattern flagged → headline `Attention`, exactly one card, sentence-shape "what's been captured" rows.
- High-volume (50+ failures, 3+ insights) → still readable (no overflow); `[Show more]` pagination visible.
- 503 disabled → the pinned 503 copy, no config-key string in the DOM.
- **`sanitizeForDisplay()` tests:** each rule (1–7) covered with both-side fixtures incl. `<script>`, 100k chars, U+202E RTL override, U+200D zero-width spam, mixed Cyrillic/Latin, mid-surrogate truncation guard.

### 6.2 Integration (`tests/integration/process-health-tab.test.ts`, jsdom + supertest)

Mount the dashboard's tab HTML/JS in jsdom, wire to fixture `/failures*` responses, drive the tab:
- All three fixtures (empty / one-flagged / high-volume) render without errors and without monospace blocks outside literal paths.
- **CSS bar checks:** body text computed `font-size ≥ 17px`; headline ≥ 24px; line-height between 1.5 and 1.6; no `font-family: monospace` outside `<code>`.
- **XSS negative test (security B1):** fixture record with `summary='<img src=x onerror=window.__xssCanary=1>'` + `recommendation='<script>window.__xssCanary=1</script>'` + `filedBy='<svg onload=window.__xssCanary=1>'`. Assert `document.querySelector('img,script,svg')` is null in the rendered tab DOM AND `window.__xssCanary === undefined`.
- **Layout-bomb test (adversarial B2):** fixture with `summary` = 100k ASCII chars; with 5k × U+200D; with 200 × `\n`. Assert the tab's bounding box height stays below 4× the empty-state height + the headline is in the initial viewport.
- **Race test (adversarial M1):** three mocked endpoints resolve out-of-order with conflicting state (analysis says 0 insights, insights endpoint returns 1). Assert renderer either renders both consistently (one paint) or skips the tick entirely — never a hybrid.
- **Visibility-gating test (scalability M1):** with the tab visible + active, interval fires; on `document.visibilityState='hidden'`, interval is cleared + `controller.aborted === true` for any in-flight; on visible-again, one immediate fetch + re-arm.
- **Diff-aware refresh (lessons F4):** three identical refresh cycles → ZERO DOM mutations after the first paint.
- **`detail.full` never leaks (loop spec §4.8):** assert the rendered DOM's `textContent` does not contain the substring `detail.full` from any fixture, even Detail-drawer-open.
- **Tunnel-mode field gating (security M1):** with `GET /failures/visibility-mode` mocked to return `{mode:'tunnel'}`, commit OIDs / specPaths / `filedBy` raw strings are NOT in the rendered DOM; with `loopback`, they appear in the Detail drawer only.

### 6.3 E2E (`tests/e2e/process-health-tab-lifecycle.test.ts`, jsdom-based against a real `createRoutes` server with the feature enabled)

The Phase-1 "feature alive" gate: boot the server in-memory with `monitoring.failureLearning.enabled = true`, mount the dashboard tab in jsdom, navigate, assert it loads + renders + soft-refreshes + never shows `detail.full`. With the feature OFF, assert the pinned 503 copy renders (no config-key string).

### 6.4 The glance-test gate (mandatory acceptance — AND, not OR — lessons F1 + F6)

**Both halves required to pass.** Neither alone is sufficient.

**(a) Human glance test (at PR review time).** A non-engineer reviewer — Justin or a delegate — opens the rendered tab against each of the three fixtures (empty / one-flagged / high-volume) on a phone-size viewport and answers in <5 seconds: "What's the state? What should I look at?" Plain English. The PR cannot merge until this is recorded as an ack on the PR (a checkbox in the PR description + reviewer comment confirming the three fixtures were glanced). **If the answer to "what should I look at" requires reading more than the headline + one section, the spec has failed regardless of test counts.**

**(b) LLM smoke (pre-flight, runs in CI).** A jsdom render of each of the three fixtures is screenshotted (via `dom-to-image` or a server-side render to PNG) and passed to a Tier-1 LLM (Haiku) with this EXACT rubric prompt:

> *You are a non-engineer glancing at this page. In ONE sentence, without reading carefully, tell me: what is this page telling me to do, and what state is it in?*

Assertions:
- The response MUST be a single sentence ≤30 words.
- The response MUST NOT contain any of: "log", "json", "table", "raw", "stack", "error trace", "console", "endpoint", "API".
- The response MUST mention a state word ("healthy", "fine", "attention", "flagged", "watching", "quiet", or similar non-technical state).
- The response MUST mention what action is implied ("nothing", "review the pattern", "look at the recent issues", or similar) or explicitly say no action is needed.

Each of the three fixtures must pass. Failure of either (a) or (b) blocks merge.

## 7. Migration parity (Migration Parity Standard)

- **`dashboard/index.html` ships with the server bundle** — verified: `package.json` `files` includes `"dashboard"`. AutoUpdater's apply lands the new file; no agent-side migration step needed for the HTML itself.
- **Server-side prerequisites in §4.3** (`/failures/insights` LIMIT + `failure_insights` index + `/failures/analysis.rollout` field + ETag) ship in the same `src/` change; the SQLite `CREATE INDEX IF NOT EXISTS` is idempotent; no PostUpdateMigrator entry needed for the index. The new `rollout` field on the analysis response is additive (existing consumers tolerate it).
- **CLAUDE.md awareness (Agent Awareness Standard + integration F1):**
  - `generateClaudeMd` (`src/scaffold/templates.ts`): add a new H3-level **"Process Health (Dashboard Tab)"** section right after the existing **"File Viewer (Dashboard Tab)"** section (follows that precedent — `src/scaffold/templates.ts:527`). Body: 4–5 lines describing what the tab shows, the proactive trigger ("when user asks 'is the failure-learning loop noticing anything?' / 'how's the rollout going?' → point to the dashboard's Process Health tab — DO NOT paraphrase from `/failures*` curl"), and the dashboard-link format.
  - `migrateClaudeMd` (`src/core/PostUpdateMigrator.ts`): add a `migrateProcessHealthTabSection()` block guarded by `!content.includes('**Process Health (Dashboard Tab)**')`, inserting after the File Viewer section using the same `content.indexOf('\n\n**', anchorIdx + N)` pattern (mirror of `:2935–2942`). This ensures EXISTING agents' CLAUDE.md gets the new section on their next update (per Migration Parity Standard — "a feature that only works for new agents is broken").
- **No `migrateConfig` change** — this tab adds no new config field.
- **CapabilityIndex (`src/server/CapabilityIndex.ts`):** append a `notes: 'Surfaced as the Process Health tab in the dashboard when failureLearning.enabled.'` field to the existing `failureLearning` capability entry — discoverability cross-reference (integration F3 minor).

## 8. Success criteria

A user opens the dashboard, taps **Process Health**, and within 5 s knows: is anything flagged for my attention? what's been captured? where are we in the rollout? — **without** feeling like they're reading a developer console. The visible surface makes promotion decisions informed instead of blind, and the feature is no longer "live but invisible."

**Post-ship verification (lessons F9):** within 7 days of ship, Justin (or a non-engineer delegate) opens the page on a phone, glances ≤5 s, and is asked the two glance-test questions. Result is recorded as either a `learn` (success — "this is what good looks like for future dashboard work") or a `feedback` (failure — spec is reopened, not patched in flight).

## 9. Findings ledger (round 1)

| ID | Sev | Reviewer | Resolution (v2) |
|----|-----|----------|-----------------|
| F1 | blocker | lessons | Glance test = AND (human at PR + LLM smoke), defined rubric, 3 fixtures (§6.4). |
| F2 | blocker | lessons | Detail drawer same UX rules; no raw JSON; LLM smoke runs drawer-open (§4.2 e). |
| B1-sec / B1-adv | blocker | security + adversarial | `sanitizeForDisplay()` + textContent/escapeHtml mandate + XSS negative-test fixture (§4.6, §6.2). |
| B2-adv | blocker | adversarial | Length caps (240/320/64/2KB) + Unicode NFC + control-char strip + grapheme-safe truncation (§4.6). |
| B3-adv | blocker | adversarial | Bidi-control strip + mixed-script flag + filedBy aggregation panel + "loop's recommendation" label (§4.2, §4.5, §4.6). |
| B1-scale | blocker | scalability | `/failures/insights` default `?limit=50` + index on `discovered_at` + ETag/304 (§4.3). |
| F3 / M2-sec | major | lessons + security | Empty/503/error copy PINNED in §4.5; no config-key strings in user copy. |
| F4 | major | lessons | No spinner/skeleton/flicker; diff-aware render; "updated Ns ago" stamp (§4.1). |
| F5 | major | lessons | Records as sentences, not bullets/log-lines (§4.2 c). |
| F6 | major | lessons | Glance test runs against 3 fixtures (§6.4). |
| M1-scale / M3-sec | major | scalability + security | Page Visibility API + active-tab gate + lifecycle contract (§4.3). |
| M2-scale | major | scalability | `[Show more]` paginates in 50s; never unbounded fetch (§4.2 c). |
| M3-scale | major | scalability | Lifecycle contract: one interval, AbortController, abort prior in-flight on new tick (§4.3). |
| M4-scale | major | scalability | ETag/304 on all three GETs (§4.3). |
| M1-sec | major | security | Tunnel-aware field gating: hide commit OIDs/paths/raw filedBy over tunnel (§4.3.1). |
| F1-integ | major | integration | `migrateClaudeMd` content-sniff for existing agents (§7). |
| F2-integ | major | integration | Test infra: jsdom (not Playwright); per-file `@vitest-environment jsdom` (§6, §3). |
| M1-adv | major | adversarial | `Promise.all` coordinated render; partial fail → skip tick (§4.3). |
| M2-adv | major | adversarial | Severity as plain inline text only; headline driven by `discovered` insights, not raw severity (§4.2 a + b). |
| M3-adv | major | adversarial | Maturation from `/failures/analysis.rollout.stage` (server-computed), NOT inferred from counts (§4.3, §4.2 d). |
| M4-adv | major | adversarial | §4.9 NEW upstream trust dependencies documented. |
| minors | minor | various | Color palette bar (only existing color + 2 status tokens, §4.1); F3-integ CapabilityIndex notes (§7); F8 color bar; F9 post-ship verification (§8); F10/m5 surface-only LOCKED (§5 Q3); m1 disabled copy (§4.5); m2 pagination (§4.2 c); m3 headline rule (§4.2 a); m4 empty-filedBy degrade (§6.1). |
