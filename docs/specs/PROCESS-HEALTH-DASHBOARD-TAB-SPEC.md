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

# Process Health Dashboard Tab — a calm, visible read surface for the Failure-Learning Loop

**Status:** DRAFT v3 (post-round-2, SCOPE-REDUCED). Author: echo · Created: 2026-05-27 · Topic: 13201
**Companion:** `PROCESS-HEALTH-DASHBOARD-TAB-SPEC.eli16.md`

> **Convergence changelog (v2 → v3 — scope reduction).** Round 2 (5 reviewers) showed v2 over-reached: several ambitions each opened their own attack surface or rested on an unsupported dependency. The disciplined fix is to **do less, safely, in this first slice**, and defer the ambitious bits as tracked fast-follows. **Dropped from v1 slice (→ §10 deferred):**
> - **Tunnel-aware field-hiding (was §4.3.1)** — reused the localhost+XFF signal that the loop spec's round-3 (R3-sec-F12) already proved is a false boundary for cloudflared quick tunnels. → DROPPED. v3 simply **never renders commit OIDs / `specPath` / `prNumber` / `toolchainRef` / `buildSkill` / raw `filedBy` in this tab at all** (operator-safe subset only), so there is nothing to gate.
> - **Auto-"Attention" headline** (was §4.2 a) — drove a loud headline from `status==='discovered'` insights, which rest on a prose-only upstream diversity-gate guarantee (adversarial B3) and could be gamed by a direct status write. → v3 headline is **informational, not a verdict**: "Watching — N issues recorded." No automated alarm state in v1.
> - **In-product mixed-script warning glyph** (was §4.5) — the `⚠` glyph was itself spoofable (`filedBy="⚠ ledger-spine"`, adversarial B2). → DROPPED; v3 instead renders rows with mixed-script/reserved-glyph content inertly (the offending glyphs are stripped — see §4.6 rule 8).
> - **Screenshot-based LLM smoke** (was §6.4 b) — required a rasterizer (`dom-to-image`/PNG) not in deps; jsdom can't paint pixels (lessons N1, integration N4). → v3 LLM smoke reads the **text projection** of the rendered DOM (jsdom-deployable).
> - **Inline `<code>` of filepaths inside `summary` prose** — required HTML-tokenizing untrusted text (adversarial B5). → DROPPED; filepaths render as plain text.
>
> **Kept + sharpened:** the core rendering-safety contract (§4.6: `sanitizeForDisplay` + `textContent`/`escapeHtml`-only + caps + NFC/control/bidi/reserved-glyph strip + grapheme-safe truncation + `safeUrl` for URL-bearing attributes + no SVG/MathML/iframe/object/embed + static `id`/`name`); the visibility-gated, abort-safe, `Promise.all`-coordinated, diff-aware refresh + ETag/304 + clarified backoff (§4.3); a **staleness escalation** so the headline degrades to a neutral "Connection paused" instead of showing a stale state (§4.1, adversarial B4); explicit `before=<ts>` pagination prerequisite (scalability NEW-1); `/failures/insights` LIMIT+index; `rollout.stage` server-computed field for the maturation display; pinned plain-English copy with no config keys; corrected `migrateClaudeMd` precedent (File Viewer is a bold-paragraph, not H3; `PostUpdateMigrator.ts:3184-3222`); CapabilityIndex cross-ref via the `build()` return (not a nonexistent `notes` interface field). Full round-1+2 ledger: §9.

---

## 1. Problem — live but invisible

The Failure-Learning Loop shipped + activated on Echo (v1.3.27, capture-only). Its `/failures*` data is reachable only via the API — the human has nothing to look at, so the loop's work is invisible and promotion decisions are blind. This adds a calm, visible **Process Health** tab.

## 2. The non-negotiable UX constraint (drives every decision)

Justin's direction ([[feedback_dashboard_human_friendly_not_debug]], a durable preference for ALL future dashboard work): **simple, large fonts, easy to digest, NOT looking like debug logs.** (1) large readable type, (2) plain-English summaries front and center, (3) zero debug-log aesthetic. **Glance-test gate (both halves required, §6.4):** a non-engineer answers "what's happening / what to look at" in <5s.

## 3. What already exists (extend, not reinvent)

- **Dashboard** (`dashboard/index.html`, single SPA served via `express.static`) with a tab framework (`.tab-bar .tab` / `.tab-content`). We add one tab.
- **Data sources** (live on Echo): `GET /failures`, `/failures/analysis`, `/failures/insights`. Server-side prerequisites this spec adds (small, additive): `/failures` + `/failures/insights` gain a `?before=<ISO-ts>` upper-bound param (parsed via `Date.parse`, 400 on `NaN`; `list()`/`listInsights()` gain `beforeMs?` → `detected_at < @before` / `discovered_at < @before`); `/failures/insights` gains a `?limit=50` default clamp + `CREATE INDEX IF NOT EXISTS idx_insights_discovered ON failure_insights(discovered_at)`; `/failures/analysis` response gains `rollout: { stage, enabled, insightTelegramEscalation }` computed from `config.monitoring.failureLearning.*`; all three GETs gain ETag (`sha256(JSON.stringify(body)).slice(0,16)`, computed after the full body incl. `rollout` is assembled; cache keyed by URL+query; rely on V8 insertion-order, do NOT sort keys).
- **PIN-gated access** (existing). No new auth surface. **No browser test infra today** → this spec adds `jsdom` (devDep) + per-file `@vitest-environment jsdom`; Playwright/screenshot rasterizers explicitly OUT OF SCOPE.

## 4. Design

### 4.1 Layout — top-to-bottom, large-to-small

```
┌─────────────────────────────────────────────────────────────┐
│  Process Health                                              │  ← 22+px
│                                                              │
│   Watching — 4 issues recorded so far                       │  ← BIG headline ≥24px, INFORMATIONAL
│   all linked to a known cause · capture-only mode            │  ← plain-English subline 17-18px
│                                                              │
│  Patterns to know about                                      │  ← 20-22px
│     (Nothing flagged yet. The monitor needs to see a wider   │  ← warm empty state
│      variety of issues before it surfaces a pattern.)        │
│                                                              │
│  What's been captured                                        │
│     A concurrency issue in src/core/Foo.ts, attributed to    │  ← sentence, plain text path
│     the ledger spine, about two days ago.                    │
│     A config-parse problem in the analyzer job, five days    │
│     ago.                                                     │
│     [Show more]                                              │  ← paginates +50 via ?before=<ts>
│                                                              │
│  Maturation                                                  │
│     ● Dark              done                                 │
│     ● Capture-only   ← you're here                           │  ← from /analysis.rollout.stage
│     ○ Insight push                                           │
│     ○ Default for all agents                                 │
│                                                              │
│  [Detail ▾]   collapsed; same UX rules inside                │
│                                              updated 1m ago  │  ← subtle stamp
└─────────────────────────────────────────────────────────────┘
```

**Measurable visual bars:** body ≥17px; section headers ≥20px; headline ≥24px; line-height 1.5–1.6; sans-serif only (no monospace anywhere in this tab — paths render as plain prose text, not `<code>`); spacious padding; no `<table>`/row-banding anywhere (incl. Detail); color palette = the dashboard's existing default text color ONLY, plus at most one neutral accent token (`--ph-accent`) for the maturation "you're here" marker. **No status-alarm colors** (no red/amber headline) — v1 has no verdict state to color. **No spinner/skeleton/flicker**; diff-aware render keyed on id; subtle "updated Ns ago" stamp at the corner.

**Staleness escalation (adversarial B4):** the headline NEVER shows a stale data-claim loudly. If a refresh tick fails: after **2 consecutive failed ticks** the headline text becomes `Connection paused — showing the last view from Nm ago` (neutral, no count claim); a successful tick restores the normal "Watching — N recorded" headline. The corner stamp is a supplement, never the only staleness signal.

### 4.2 Sections (most-important first)

**(a) Headline (informational, NOT a verdict).** "Watching — N issues recorded so far" + a plain subline ("all linked to a known cause · capture-only mode" / "N still being traced"). **No automated Healthy/Attention alarm state in v1** — that (and the upstream provenance contract it needs) is deferred (§10). This removes the headline-gameability + "loud stale lie" classes entirely.

**(b) Patterns to know about.** When the loop has surfaced insights, each is a plain-English card: the pattern summary (sanitized + capped, §4.6), the recommendation (prefixed with a quiet "the monitor suggests:" label so it reads as machine-generated, not editorial), and a one-sentence evidence line ("seen across N changes"). Empty state: the warm copy in §4.5. The cards are informational; they do not change the headline in v1.

**(c) What's been captured (operator-safe subset only).** Up to 10 most-recent records, each as ONE plain-English sentence. **Rendered fields are limited to the operator-safe subset:** the sanitized `summary`, the `category` (as a friendly word), a DERIVED human attribution label (from an `initiativeId → label` map; falls back to a generic "a tracked feature" if unmapped — NEVER the raw `initiativeId`), and relative time. **NEVER rendered in this tab:** `causeCommitOid`, `fixCommitOid`, `specPath`, `prNumber`, `toolchainRef`, `buildSkill`, raw `filedBy`, `detail.full` (the last is already server-stripped). `[Show more]` paginates in chunks of 50 via `?limit=50&before=<oldest-ts-of-prior-page>`; never an unbounded fetch. Severity is NOT rendered (it's caller-set and gameable; omitting it removes the surface).

**(d) Maturation track.** Four stages (Dark / Capture-only / Insight push / Default-on) as a vertical visual list with a "← you're here" marker. Current stage read from `/failures/analysis.rollout.stage` (server-computed from config, NOT inferred from counts). Read-only; no promote action in this tab.

**(e) `[Detail ▾]` — collapsed; SAME UX rules apply inside.** ≥17px, no monospace blocks, no JSON dumps, no tables. Shows the analyzer's aggregate counts as labeled list items (category distribution, coverage fraction, `unknown`-toolchain bucket size). Renders once on open from the latest analysis payload; refreshes in place only while open.

### 4.3 Data wiring (visibility-gated, abort-safe, coordinated, diff-aware)

**Lifecycle:** one module-level state `{ intervalId, inFlightController, lastSnapshot, consecutiveFailedTicks, consecutive304Ticks }`.
- **Start** polling when `switchTab('process-health')` is active AND `document.visibilityState==='visible'` (both required).
- **Stop** (`clearInterval` + null + `abort()` in-flight) on tab-switch-away OR `visibilitychange→hidden`.
- **Resume** on `visibilitychange→visible` while active: one immediate refresh + re-arm.
- **Per tick:** new `AbortController` (abort the prior in-flight first); `Promise.all([analysis, insights?limit=50, failures?limit=10])` with `If-None-Match` from the last ETags; **single coordinated render**. A 304 on an endpoint → render that section from `lastSnapshot[endpoint]` (so first-paint-after-reactivation isn't blank; a mixed 200/304 tick renders 304 sections from snapshot + 200 sections fresh — always one consistent paint). If ANY endpoint hard-fails → drop the whole tick, keep prior render, increment `consecutiveFailedTicks` (drives §4.1 staleness escalation).
- **Backoff:** a single tick-level `consecutive304Ticks` increments only when ALL THREE return 304; ANY 200 (≡ material change, given deterministic SHA ETags) resets it to 0. At `≥5`, the next `setTimeout` is 300_000ms; a 200 resets to the 60_000ms cadence. The "updated Ns ago" stamp reflects time since the last 200 (`lastMaterialPaint`).
- **Diff-aware render:** changes detected by record-id / insight-id; mutate only changed nodes (no full `innerHTML` wipe); collapse handlers persist across ticks.

### 4.4 Integration

- Tab button in `.tab-bar` ("Process Health"); `.tab-content#process-health-tab` hidden by default; CSS appended under `/* process-health tab */` with `.ph-*` class names; one `<script>` block. Splitting `index.html` is explicitly out of scope.

### 4.5 Copy (PINNED — plain English, no config keys)

- **Empty (loop on, no patterns):** "Nothing flagged yet. The monitor needs to see a wider variety of issues before it surfaces a pattern — that's expected this early."
- **Empty (no records):** "No issues recorded yet — that just means nothing has come through since this was turned on."
- **Disabled (503):** "Process Health isn't turned on for this agent yet. Once it is, this page will show what it's noticing." + a `[for operators ▾]` collapse with the enable hint (inline `<code>` only, never a block).
- **Refresh paused:** the §4.1 staleness headline + subtle subline "Couldn't refresh just now — showing the last good view. Will retry."

### 4.6 Rendering safety contract (load-bearing — security + adversarial)

All dynamic values flow through `sanitizeForDisplay(value, fieldKind)` before the DOM:
1. null-coerce; 2. NFC-normalize; 3. strip C0/C1 controls (keep `\n`,`\t`); 4. strip bidi-control (U+202A–202E, U+2066–2069); 5. collapse `>1` `\n` → one, cap whitespace runs at 4; 6. length cap per kind (`summary` 240, `recommendation` 320, derived-label 64, Detail text 2KB), **grapheme-safe** (`Intl.Segmenter`), `…` suffix on truncation; 7. mixed-script (Latin + confusable Cyrillic/Greek) → render the row inertly (no special glyph); 8. **reserved-glyph strip:** strip any UI-reserved presentation glyph the tab itself uses (`⚠ ★ ☆ ● ○ ✓ ✗ ← → ▲ ▼ ◐ ℹ 🔒` …) from dynamic values so attacker text can't impersonate system chrome.

**DOM insertion (mandatory):**
- Dynamic values → `element.textContent` ONLY, or `escapeHtml()` if assembled into a structural `innerHTML` template. No naked `innerHTML` interpolation of dynamic values.
- Allowed DOM destinations for dynamic values: `textContent`, `setAttribute('class', LITERAL)`, `setAttribute('aria-*', LITERAL)`. URL-bearing attributes (`href`, `src`, `style`, `srcset`, `data-*`, `formaction`) are FORBIDDEN for dynamic values unless passed through `safeUrl()` (must start `http:`/`https:`/`/`/`#`; reject `javascript:`/`data:`/`vbscript:`/`file:`; reject off-allowlist hosts; empty string on reject). Inline `style=` interpolation of dynamic values is forbidden outright.
- `id`/`name` attributes are static literals (no DOM-clobbering).
- **No `<svg>`, `<math>`, `<iframe>`, `<object>`, `<embed>` elements appear in the tab DOM at any time.**

**Server-side hardening (flagged follow-up, §10):** apply equivalent caps + sanitization at the `POST /failures` boundary in `FailureLedger`. The dashboard caps are defense-in-depth.

### 4.9 Upstream trust dependencies

This tab trusts that `FailureLedger.toApiView` strips `detail.full` (loop spec §4.8; §6 asserts the rendered DOM never contains a `detail.full`-class field). Because v3 drops the auto-Attention headline, the tab no longer depends on the analyzer's diversity-gate for any *verdict* — insights are shown informationally only. If a future iteration re-introduces an alarm headline, it MUST first add a structural provenance field to `InsightRecord` (deferred, §10) — prose trust is insufficient for a verdict.

## 5. Open questions — none material (all resolved/deferred; §10).

## 6. Testing (3-tier + glance test, NON-NEGOTIABLE)

**Infra:** jsdom (devDep) + per-file `@vitest-environment jsdom`. No Playwright/screenshots.

- **6.1 Unit** (`tests/unit/process-health-renderers.test.ts`): pure `data→DOM` renderers in 3 states (empty / patterns-present / high-volume). `sanitizeForDisplay` rules 1–8 each with both-side fixtures (incl. `<script>`, 100k chars, U+202E, U+200D spam, mixed Cyrillic/Latin, reserved-glyph `⚠ ledger-spine`, mid-surrogate truncation guard). `safeUrl` accept/reject table. Operator-safe-subset assertion: rendering a full record produces NO commit OID / specPath / raw filedBy substring.
- **6.2 Integration** (jsdom): all 3 fixtures render; CSS bars (`getComputedStyle` font-size ≥17/≥24, line-height 1.5–1.6, no monospace); **XSS negative** (`summary`/`recommendation`/`filedBy` with `<img onerror>`, `<script>`, `<svg onload>`, `<math href=javascript:>`, `javascript:` URL, `<form id=document.body>` → assert `tabRoot.querySelectorAll('img,script,svg,math,iframe,object,embed').length===0`, `window.__xssCanary===undefined`, no `javascript:` in any attribute); **layout-bomb** (100k-char summary → serialized DOM byte-length < 8× empty baseline); **race** (out-of-order conflicting fetches → one consistent paint or skip, never hybrid); **visibility-gating** (hidden → interval cleared + in-flight aborted; visible → one fetch + re-arm); **staleness** (3 consecutive 5xx → headline contains "Connection paused", NOT a stale count claim); **backoff** (5 all-304 ticks → next `setTimeout` arg 300_000; then a 200 → 60_000); **diff-aware** (3 identical ticks → 0 DOM mutations after first paint); **detail.full** never in DOM.
- **6.3 E2E** (`tests/e2e/process-health-tab-lifecycle.test.ts`): boot in-memory `createRoutes` with the feature ON, mount tab in jsdom, assert loads/renders/refreshes/never-leaks; with feature OFF, assert the pinned 503 copy (no config-key string).
- **6.4 Glance test (mandatory, AND — both required):**
  - **(a) Human (PR review):** a non-engineer opens the rendered tab against all 3 fixtures on a phone-size viewport, answers "what's happening / what to look at" in <5s. Recorded as a PR-description checkbox + a reviewer comment by a GitHub login ≠ the PR author. (Soft gate, reviewer-attested — honestly labeled as such, not claimed as CI-enforced.)
  - **(b) LLM text-smoke (CI, pre-flight):** for each fixture, jsdom renders the tab; the **visible-text projection** (a `textContent` walker emitting block breaks) is passed to a Haiku call (via the existing `IntelligenceProvider.evaluate()` surface) with the EXACT rubric: *"You are a non-engineer glancing at this page. In ONE sentence, without reading carefully: what is this page telling me, and what state is it in?"* Assert: response ≤30 words; contains NO {log, json, table, raw, stack, console, endpoint, API}; mentions a plain state word; mentions implied action or explicitly none. All 3 fixtures must pass.

## 7. Migration parity

- `dashboard/index.html` ships with the server bundle (`package.json files` includes `dashboard`); AutoUpdater apply lands it; no migration for the HTML.
- Server prereqs (§3) ship in the same `src/` change; `CREATE INDEX IF NOT EXISTS` is idempotent (runs in `FailureLedger` constructor on boot — AutoUpdater restarts re-instantiate it); `rollout` field + `before=` param + ETag are additive.
- **CLAUDE.md awareness (Agent Awareness + Migration Parity):**
  - `generateClaudeMd` (`src/scaffold/templates.ts:546`): add a new **`**Process Health (Dashboard Tab)**` bold-paragraph section** (NOT H3 — matches the File Viewer precedent style) immediately after the File Viewer block, incl. the proactive trigger ("when user asks 'is the loop noticing anything? / how's the rollout going?' → point to the Process Health tab, don't paraphrase `/failures*` curl").
  - `migrateClaudeMd` (`src/core/PostUpdateMigrator.ts`): add `migrateProcessHealthTabSection()` modeled on the File Viewer migration at **lines 3184–3222** — anchor `content.indexOf('**File Viewer')`, next-break `content.indexOf('\n\n**', anchorIdx + 15)`, insert there; guard `!content.includes('**Process Health (Dashboard Tab)**')`.
- **CapabilityIndex** (`src/server/CapabilityIndex.ts:503-518`): extend the `failureLearning` entry's `build()` RETURN with `dashboardTab: 'Surfaced as the Process Health tab in the dashboard when enabled.'` (a new key in the response body — NOT a `CapabilityEntry` interface field, which nothing reads). The new `/failures/visibility-mode`... — N/A, dropped with §4.3.1. No new route prefix → no capabilities-lint entry needed (the `rollout` field + `before=` are response/param changes to existing routes).
- No `migrateConfig` change.

## 8. Success criteria

A user opens the dashboard, taps **Process Health**, and within 5s knows: what's the loop watching, what's been captured, where are we in the rollout — without a developer-console feel. **Post-ship verification (within 7 days):** Justin (or a non-engineer delegate) glances on a phone ≤5s, answers the two glance questions; recorded as a `learn` (this is the bar for future dashboard work) or a `feedback` (reopen, don't patch in flight).

## 9. Findings ledger (rounds 1 + 2)

**Round 2 (resolved by v3 scope reduction):** tunnel-mode false boundary (sec B1) → DROPPED §4.3.1, render operator-safe subset only. Mixed-script glyph spoof (adv B2) → DROPPED glyph + reserved-glyph strip (§4.6 r8). Auto-Attention headline gameable + no provenance (adv B3) → headline is informational only (§4.2 a); provenance deferred (§10). Stale-loud-headline (adv B4) → staleness escalation (§4.1). Screenshot smoke undeployable (lessons N1 / integ N4) → text-projection smoke (§6.4 b). Human-gate policy-not-structure (lessons N2) → honestly labeled soft/reviewer-attested (§6.4 a). `<code>` summary tokenizing (adv B5) → plain-text paths. URL/attribute/SVG/MathML/clobber gaps (sec M1/M2) → §4.6 safeUrl + destination allow-list + element ban + static ids. `before=` unsupported (scale NEW-1) → §3 prereq. ETag/304 + backoff edge cases (scale NEW-2/3/4) → §4.3 clarified. friendly-name map undefined (lessons N3) → §4.2 c + map seeded in same PR. migrateClaudeMd citation wrong (integ N1) → §7 corrected (bold not H3, lines 3184-3222). `notes` field nonexistent (integ N2) → §7 via `build()` return. trust-deps prose-only (adv M1) → moot for v1 (no verdict); §4.9 + deferred provenance.

**Round 1 (resolved in v2, carried):** glance test AND + 3 fixtures + rubric (lessons F1/F6 → §6.4); Detail-drawer same rules (F2 → §4.2e); XSS contract (sec/adv B1 → §4.6); length/Unicode caps (adv B2 → §4.6); copy pinned no config keys (F3/sec M2 → §4.5); refresh visuals (F4 → §4.1); sentence records (F5 → §4.2c); visibility-gating + lifecycle (scale M1/M3 → §4.3); pagination (scale M2 → §4.2c); listInsights LIMIT+index (scale B1 → §3); coordinated render (adv M1 → §4.3); severity not visual (adv M2 → omitted entirely §4.2c); jsdom not Playwright (integ F2 → §6).

## 10. Deferred (tracked fast-follows — own future specs when warranted)

- **Auto-"Attention" alarm headline** + the structural **`InsightRecord.provenance`** contract (diversity-gate proof) it requires — when the loop reaches insight-push maturity.
- **Tunnel-aware exposure of repo internals** (commit OIDs, paths) — needs a real second-factor (bearer-token route, not PIN), not a localhost+XFF guess.
- **Server-side `POST /failures` input caps + sanitization** — the real fix; this spec's caps are defense-in-depth.
- **`contract.version` enforcement** between this tab and the loop's API shape — when the loop API stabilizes post-1.0.
- **Real-browser visual smoke** (puppeteer) — if the text-projection smoke proves insufficient.
- **Dashboard SPA modularization** (split `index.html`) — separate spec.
