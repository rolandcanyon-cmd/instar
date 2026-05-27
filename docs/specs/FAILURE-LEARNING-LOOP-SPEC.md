---
title: Failure-Learning Loop
slug: failure-learning-loop
author: echo
created: 2026-05-26
owner: echo
status: draft
eli16-overview: FAILURE-LEARNING-LOOP-SPEC.eli16.md
topic: 13201
---

# Failure-Learning Loop — attributing downstream failures to the spec, project, and dev toolchain that produced them

**Status:** DRAFT, post-round-1 convergence (v2). Author: echo · Created: 2026-05-26 · Topic: 13201 (🧹 SessionReaper → Graduated Rollout → this)
**Companion:** `FAILURE-LEARNING-LOOP-SPEC.eli16.md`

> Third link in an arc. SessionReaper shipped a risky feature safely; Graduated Feature Rollout made "ship dark, then mature it without forgetting" a structural standard. This spec closes the loop on the *other* side: when something we built later **breaks**, capture it, trace it back to what produced it (the spec, initiative, project — and the dev tools/skills used), and learn from the accumulated record so the dev process itself gets better — and *verifies* whether each fix actually worked.

> **Convergence changelog (v1 → v2).** A 5-reviewer round (security, scalability, adversarial, integration, lessons-aware), all grounded in the real code, found the strategy right but several concrete claims wrong. All fixed below:
> - **BL-1 (blocker, 4 reviewers): the existing `regressed` transition is the WRONG signal.** `FeatureRolloutReconciler.isRegression` (`featureRollout.ts:81`) fires on *rollout-stage backslide* (`default-on → live`, a human flipping a flag back); `routes.ts:5919/5975` writes `regressed` for *merge-unreachability of a `building` item* (rebase/force-push). **Neither means "a shipped feature broke weeks later"** — the spec's entire premise. Also: the reconciler is **not an EventEmitter** (no hook to attach to), there are **two independent regression-writers**, and the transition is **not edge-triggered** (would re-fire every 6h → duplicate flood). → §2/§4.2 corrected; **first slice changed** to the deterministic agent-supplied sources (§4.2 #A/#B); regression demoted to a later, *new-detection* source with a single chokepoint emitted from `InitiativeTracker.update()`; §6 dogfood E2E rewritten to drive the real first-slice trigger.
> - **BL-2 (blocker): "never auto-implements" was contradicted by existing code.** `EvolutionManager.processProposalAutonomously` (`:807`) has an `auto-implement` branch when `evolutionApprovalMode === 'autonomous'`. The loop fed straight into that queue. → §4.6.1 makes the guard **structural**: FailureLoop-originated items carry an `origin` tag the autonomous evaluator **hard-excludes** from auto-implement, regardless of mode; plus the loop has *no* file-write capability (tested).
> - **BL-3 (blocker): provenance + failure text were trusted, not verified.** Trace toolchain fields are caller-asserted CLI args (`write-trace.mjs` verifies nothing); untrusted failure text flowed into the LLM classifier + auto-`addLearning` + auto-opened recommendation (injection → manufactured process change). → §4.1 treats toolchain as *claims* (verify what's verifiable, label `verified` vs `claimed`); §4.4 treats all failure text as untrusted data with enum-constrained classifier output and template-keyed (not free-LLM) recommendations.
> - **Majors (metric poisonability):** single-author gaming, flapping/flaky no-actor floods, zombie/reverted-feature attribution, forgeable/omittable trailers → dedupe key + occurrence-count, source-diversity gate, attribution-type weighting, liveness/decay, trailer cross-check, `filedBy` audit, server-side join validation, rate-limit + `X-Instar-Request` write, read-only-over-tunnel (§4.2/§4.3/§4.4).
> - **Majors (verify step):** no confounder control, no active driver, no reopen cap → exposure-normalized rate, active verification window with definite terminal evaluation, `reopenCount` cap → `inconclusive`, correlational labeling (§4.6.1 step 5).
> - **Majors (deploy):** analyzer job must ship as a template (else retired-swept); write-trace enrichment needs a named skill-script migration; new Telegram topic re-litigated the anti-spam standard → route to existing system topic, off by default, stable insight identity; multi-machine reconciliation; TaskFlow/JSON parity tests; dependency ordering; rollback semantics; SQLite-primary analytical store (§4.5/§4.7/§4.8/§7).
> - Full finding-by-finding table: §10.

---

## 1. Problem — failures teach one person once, then evaporate

Justin (2026-05-26, topic 13201):

> "We are often designing specs that are linked to initiatives and possibly projects, then building, testing, and deploying. However almost ALWAYS there is a failure down the road that is related to what was built. We need a way to track these failures and learn from them. This should be mandatory. Failures should be traced back to the spec/initiative/project/feature they were associated with AND the development tools/skills used to create them (including all review skills/etc) … we can start analyzing the failure properties and metrics to see what patterns emerge and start identifying gaps in our development process (bad spec? missed something in the review? bad build?). This should all be automatic … the end result should be a system that continues to improve and design and build with less failures. Finally, we recently decided that it might be beneficial to have different build skills for Instar development vs Other development … its critical to be able to trace failures back to the development skills/tools that were used."

**The gap:** instar tracks *forward progress* (specs → initiatives → rollout stages) but has **no backward failure forensics** — no failure record, no link from a failure to the feature/spec/initiative/project that caused it, no link to the **dev toolchain** that produced the faulty work, and no analysis. The value is the *process-level pattern* — a weak spec template, a review angle blind to concurrency, a build skill that skips a step — surfaced from accumulated, attributed data, then driven all the way to a deployed, *verified* improvement.

## 2. What already exists (extend, not reinvent) — corrected against the code

Grounding pass (2026-05-26), corrected after round 1:

- **`InitiativeTracker` (`src/core/InitiativeTracker.ts`) — the lineage spine.** Stores per-feature `specPath`, `prNumber`, `mergeCommitOid`, `ciCheckedAt`, `links[]`, OCC `version` (note: `ifMatch` is *opt-in* — see §4.2 concurrency), `pipelineStage` (incl. `regressed`), and `parentProjectId`/`rounds[].itemIds` for project rollup. Persists via **TaskFlow when wired** (single source of truth, better-sqlite3, sync reads / async writes, cache = read-side projection) else `<stateDir>/initiatives.json`. Carries a git-sync conflict handler (Phase 1.12).
- **What `regressed` actually means (corrected):** it is written by **two** independent paths, and *neither* is "a shipped feature functionally broke." `FeatureRolloutReconciler.reconcileOne` (`:162`) writes it on **rollout-stage backslide** via `isRegression` (`featureRollout.ts:81`, pure STAGE_ORDER downgrade). The lazy reconciler (`routes.ts:5919`) and the post-restore poller (`routes.ts:5975`) write it when a **`building`** child's `mergeCommitOid` is no longer an ancestor of `origin/main` (rebase/force-push). The reconciler is **not** an EventEmitter — it writes directly via `tracker.update()` and returns `ReconcileSummary.regressed[]`.
- **instar-dev trace files (`.instar/instar-dev-traces/*.json`, v2) — the provenance stamp (gitignored runtime state).** The commit gate **refuses any `src/` commit without a trace**. Records `sessionId`, `timestamp`, `specPath`, `coveredFiles`, `artifactSha256`, `secondPass`, `reviewerConcurred`, `phase`. Written by `skills/instar-dev/scripts/write-trace.mjs` at commit time. **All current fields are caller-asserted** (the script verifies nothing). The reader (`featureRolloutScan.ts:46`) reads by field-presence and never inspects `version` (so v3 is additive-safe).
- **`DegradationReporter`** — runtime fallback events, `{redacted, full}` reason split (`full` never crosses persistence/alert/LLM boundaries), disk cap `slice(-100)`, best-effort/fail-open writes.
- **Learning registry (`EvolutionManager`)** — `addLearning`; the natural **output sink**. ⚠ `EvolutionManager.processProposalAutonomously` (`:807`) **auto-implements** proposals when `evolutionApprovalMode === 'autonomous'` — a hazard the loop must structurally avoid (§4.6.1).
- **Builtin jobs** — `installBuiltinJobs()` *overwrites* shipped slugs AND **retires any slug in `.instar/jobs/instar/` not present in the templates dir** (deletes `.md`, disables). A non-template job self-destructs on update.
- **Spec frontmatter** — `approved-at`, `review-convergence`, `review-iterations`, `owner`, `slug`, `ships-staged`, `rollout:` block.

**Verified absent:** any failure record; attribution join; record of *which dev skills/tools/versions* built/reviewed a feature; analysis surface.

## 3. Verdict on Justin's question (own feature vs. extend)

**A net-new capture-and-analysis subsystem, NOT a parallel silo.** It hangs off two existing structures: attribution reuses the InitiativeTracker lineage; toolchain provenance reuses (by enriching) the already-mandatory instar-dev trace; "what we learned" reuses the learning registry. New pieces: a **FailureLedger** (records), an **attribution engine** (the join), an **analyzer** (the pattern layer), and the **closed loop** (§4.6.1). Same shape as Graduated Rollout's verdict: extend the spine, add the active layer.

## 4. Design

### 4.1 Provenance enrichment — the toolchain stamp (claims, not facts)

The commit gate already mandates a trace per `src/` commit, so capture is structurally mandatory; we enrich **what** it stamps. Trace **v2 → v3**, additive and **optional**:

```jsonc
"toolchain": {
  "buildSkill":   { "name": "instar-dev", "version": "<skill-dir git SHA / content hash>", "verified": true },
  "reviewSkills": [ { "name": "spec-converge", "outcome": "converged", "iterations": 3, "verified": true } ],
  "convergence":  { "reportPath": "docs/specs/reports/<slug>-convergence.md", "verified": true }
}
```

- **Integrity (BL-3):** toolchain fields are **claims** until corroborated. `write-trace.mjs` (and the analyzer) verify what they can — `convergence.reportPath` must exist and reference this slug; `iterations`/`reviewerConcurred` are **derived from the spec frontmatter + convergence report artifact** (`review-convergence`, `review-iterations` already exist), not trusted from a bare CLI flag. `buildSkill.version` is pinned to the skill-dir **git SHA / content hash**, not a self-declared frontmatter string. Each sub-field carries `verified: true|false`. The analyzer (§4.4) keeps `verified` and `claimed` provenance in **separate buckets**; toolchain-blame analytics built on `claimed` data are **advisory, low-authority** and never the sole basis of an auto-opened recommendation.
- **Hot path (M2):** `write-trace.mjs` stays **O(1)** — it accepts already-known literal strings from the caller (the build/converge skills hold them in context) and writes JSON. **Non-goal:** the script performs no skill-discovery, no `git` calls, no report parsing at commit time. Enrichment-gather failure ⇒ **omit the field, never block the commit** (the additive block is optional; a missing/failed toolchain never converts a passing commit into a blocked one).
- **Migration:** v3 is additive; readers ignore unknown fields. Missing `toolchain` → `unknown` bucket (a first-class analysis category, never an error). **Delivery to deployed agents (B3):** a named `PostUpdateMigrator.migrateWriteTraceEnrichment()` updates `skills/instar-dev/scripts/write-trace.mjs` with a stock-fingerprint guard (mirrors `migrateBuildSkillMethodology`); `instar-dev` is added to the skill-script migration allowlist. Prerequisite check: confirm skill `scripts/` dirs are migrated on update (not init-only) — close that gap first if needed.

### 4.2 FailureLedger — the records (multi-source, deduped, fail-open)

New `FailureLedger` class in `src/monitoring/`. **Storage (M3):** TaskFlow/SQLite is the **primary** durable store (this is an analytical workload), with indexes on `buildSkill`, `category`, `initiativeId`, `detectedAt`; the `<stateDir>/failures.json` path exists only for the disabled/degraded case and uses atomic `tmp+rename` writes. A startup `migrateExistingFailuresToTaskFlow()` mirrors InitiativeTracker (idempotent). `FailureRecord`:

```jsonc
{
  "id": "FAIL-<machineId>-001",                 // machine-scoped (M2) to avoid cross-machine ID collision
  "dedupeKey": "<source>:<causeCommitOid|null>:<category>",  // upsert key (M5) — collapses repeats
  "occurrenceCount": 1,                          // incremented on repeat instead of duplicating
  "detectedAt": "<ISO>", "filedBy": "<sessionId|X-Instar-AgentId>",  // audit (A2)
  "source": "bugfix-commit | agent-diagnosed | ci | revert | regression | degradation",
  "severity": "low | medium | high",
  "summary": "<short, redacted-safe>",
  "detail": { "redacted": "…", "full": "…" },    // full = internal-only (§4.8 redaction)
  "category": "concurrency | config-parse | wiring | logic | migration | test-gap | unknown",  // enum, LLM-classified §4.4

  // attribution
  "initiativeId": "…", "projectId": "…", "specPath": "…",
  "causeCommitOid": "…", "fixCommitOid": "…", "prNumber": 401, "toolchainRef": "<trace id>",
  "attribution": "automatic | one-tap | inferred",
  "attributionConfidence": 0.0,                  // default exclusion threshold < 0.6 (config, §4.4)

  "status": "open | attributed | analyzed | resolved | reopened",
  "learningId": "LRN-…", "createdAt": "…", "updatedAt": "…", "version": 1   // ifMatch MANDATORY (M4)
}
```

**Concurrency (M4):** `ifMatch` is **mandatory** for all FailureLedger mutations (no legacy exemption — new store); writes retry-on-409 in a bounded loop rather than read-then-write. The **open** path is a deterministic-id **upsert** on `dedupeKey`, so two sources/machines racing to create the same record converge to one (+`occurrenceCount`) instead of duplicating. Cross-machine records reconcile via the TaskFlow path + InitiativeTracker's git-sync conflict handler; machine-scoped IDs prevent collision.

**Ingestion sources** (ordered by trustworthiness; **fail-open everywhere** — a ledger write error logs and drops, never blocks the observed thing):

- **#A `bugfix-commit` (FIRST SLICE, deterministic).** Parse a commit trailer `Fixes-Feature: <initiativeId>` / `Fixes: <FAIL-id>`. **Cross-checked (B5/M7):** the cited initiative/FAIL must exist AND the fix commit's touched files must intersect the named initiative's `coveredFiles`; on mismatch → `inferred`/needs-attribution, never accepted as fact, never auto-resolves. Trailer **omission** is measured as a "fixes with no feature link" coverage bucket (visible under-capture, not silent). Not hard-gated (would punish unrelated fixes); the instar-dev gate *nudges* it when a commit touches previously-shipped feature code.
- **#B `agent-diagnosed` (FIRST SLICE, the one manual surface — one tap).** `POST /failures {summary, initiativeId|specPath, causeCommitOid?, severity}`. **Server-side validated (A2):** `initiativeId` must exist; a supplied `causeCommitOid` must be reachable. Stays `attribution: one-tap` (a caller-supplied `causeCommitOid` **never** upgrades to `automatic`, B6) and is **excluded from toolchain-blame aggregates** (§4.4). `filedBy` stamped. Requires `X-Instar-Request: 1` and is **not** writable via the read-only dashboard/tunnel surface (F12).
- **#C `revert` (later).** Detect `Revert "…"` at merge; reverse-lookup the reverted commit → PR → initiative. A revert **links to / closes** an existing record for that feature (does not double-count, M6).
- **#D `ci` (later).** A poller pinned to the reconciler's ≥6h cadence, bounded to *recently-active* branches, using a single batched `gh run list` (not per-branch), explicitly chosen over tighter polling for GH rate-budget safety; webhook is the preferred long-term option (§5 Q1). Attribution branch → PR → initiative (server-derived → `automatic`).
- **#E `regression` (later — NEW detection, single chokepoint).** Corrected per BL-1: the *existing* `regressed` writes are rollout-backslide / merge-unreachability, not functional failure. To capture genuine regressions we **emit a `pipelineStage→regressed` transition event from inside `InitiativeTracker.update()`** (the OCC single-writer), covering **both** existing writers, and open an **edge-triggered, idempotent** record keyed on `(initiativeId, mergeCommitOid)` so a stuck flag does not re-fire each pass. `causeCommitOid` = the now-unreachable `mergeCommitOid` (knowable). This is *new detection logic* — labeled as such, not "free."
- **#F `degradation` (later, opt-in per subsystem).** A DegradationReporter event may promote to a FailureRecord only for explicitly-mapped subsystems; off by default (avoids runtime-noise flooding the dev ledger).

### 4.3 Attribution engine — automatic where clean, one-tap where not (never silently wrong)

- **Clean chain → `automatic`, high confidence:** `commit → PR → mergeCommitOid → initiative`, **server-derived only**.
- **Ambiguous → `one-tap`:** agent-supplied explicit `initiativeId`/`specPath`.
- **`inferred` → low confidence:** stays `status: open` / "needs attribution" on the pull surface, **excluded from analysis aggregates** below `attributionConfidence` 0.6 (config knob; §6 tests both sides). A guess is *labeled*, never laundered into a fact.
- **Coverage honesty (m8):** every analyzer rate is reported **with its confirmed-coverage fraction** ("rate based on 6 of 19 failures attributed") so a low-coverage rate reads as low-confidence, not as the rate.

### 4.4 Analyzer — the pattern layer (Tier-1 supervised, poison-resistant, small-N-honest)

A **sibling builtin job** (weekly + threshold-triggered; *not* folded into the rollout driver — failures want larger-N). Shipped as `src/scaffold/templates/jobs/instar/failure-analyzer.md` (recognized slug, off by default — so it is **not** retired-swept, B2). Declares **`supervision: tier1`** (MA-4): deterministic metric computation + the `minSupport`/diversity gates are the Tier-0 core; a Haiku-class validator sanity-checks every emitted recommendation against its supporting evidence before it reaches any push surface.

Computes, over **`verified`-provenance, `automatic`-attribution, distinct (deduped) records of live features**:

- failure rate per **build skill** / per **review configuration** (convergence ran? iterations? second pass? crossreview?) — `claimed`-provenance and `one-tap`/`inferred` records are **excluded** from toolchain-blame aggregates.
- correlations with **spec properties** (skipped convergence, missing ELI16, short spec, dark-ship without `ships-staged`).
- **category** distribution and **mean-time-to-failure-after-merge**, exposure-normalized.
- the **`unknown`-toolchain** and **`no-feature-link`** bucket sizes (themselves signals of attributable coverage).

**Untrusted-text discipline (BL-3 / D8):** `summary`/`detail` originate from commit messages, CI logs, degradation reasons, and the one-tap body — **all untrusted**. The LLM classifier prompt treats them as data, never instructions (delimited, system-instruction to ignore embedded instructions), and is **enum-constrained** to the fixed `category` set. The analyzer's `recommendation` is **template-keyed on the detected pattern**, not free-LLM text piped verbatim into an auto-opened item; LLM-generated prose never auto-flows into a draft initiative body.

**Poison resistance (M4/M5):** an insight requires not just `minSupport` (default 4) raw count but **source diversity** — failures from **≥ K distinct sessions/authors AND ≥ J distinct cause-commits** (defaults K=3, J=3). Dedup means a crash-loop or flaky test (one cause commit) can never manufacture support. Toolchain-targeting insights carry a *higher* effective threshold (highest-stakes, most-gameable). Archived/reverted-feature failures are **decayed/excluded** from active rates (M6).

It emits **findings** → `addLearning` (redacted only) + the §4.5 channels, **only** when a trend crosses the support+diversity+effect threshold. Signal-only: it **detects and recommends**; it never blocks a merge, never grades a person, never auto-edits anything (`feedback_signal_vs_authority`, `feedback_notifications_near_silent`).

### 4.5 How it feeds back — three layered channels (Justin's explicit asks)

Strict near-silent: **detail on a pull surface; only thresholded, decision-bearing insights pushed; nothing routine buzzes the user.**

1. **Dashboard — "Process Health" tab (PULL, full detail, primary surface).** Ledger view (filter by feature/project/build-skill/review-config/category/attribution/window), analysis view (rate-by-toolchain with coverage fractions, category distribution, MTTF, `unknown`/`no-link` bucket sizes), and an **insights board** showing each insight's loop status (discovered → acted-on-via-X → verified-effective/ineffective, §4.6.1). **Read-only over the dashboard/tunnel** (F12); `POST /failures` requires `X-Instar-Request` and is not served to a PIN-unlocked browser session. Ships with the server bundle (no separate migration, MI-1).
2. **Insight push → the EXISTING system (lifeline) topic, coalesced, OFF by default (M1/MA-3).** Corrected: a *new* per-feature topic re-litigates the ratified silently-stopped-trio fix. Instead, insights route to the existing system topic like sentinel escalations, behind `failureLearning.insightTelegramEscalation: false`. **Stable identity:** an insight's identity is **content-derived/stable across analyzer runs**; it pushes **exactly once** on first threshold-crossing; subsequent re-confirmations update the dashboard only (this is the tunnel-spam stable-key lesson — never re-announce). (If a dedicated topic is ever wanted, it requires config `processInsightsTopicId` + lazy `ensureTopic` + forum-absent fallback + seed migration — deferred.)
3. **Attention Queue (PUSH, decision-bearing only).** When an insight becomes "recommend a change — approve?", it queues an Attention item **carrying the supporting `FAIL-id`s** (approve against visible evidence, not a bare string), capped so auto-opened drafts can't induce approval-fatigue (E11).

**Discoverability:** routes `GET /failures`, `GET /failures/:id`, `POST /failures`, `GET /failures/analysis`, `GET /failures/insights` — mounted **after `authMiddleware`**, Bearer + `X-Instar-AgentId`, never in the exemption list (A1; integration test asserts 401 without token). Surfaced in `/capabilities` + Registry-First so "why do features keep breaking?" / "failure rate by build skill?" / "are our process fixes working?" route me to the live ledger, never memory. CLAUDE.md template (`generateClaudeMd` Dashboard features + a Capabilities entry) + `migrateClaudeMd` content-sniff.

**Projects:** FailureRecords roll up via `initiative.parentProjectId`; a project's status view shows its failure history. Inside Projects, not beside.

### 4.6 Mandatory + automatic (Structure > Willpower) — stated honestly

- **Structural (no human step):** the toolchain stamp (rides the mandatory commit gate), and the `ci`/`revert`/`regression` server-derived sources.
- **Prompted-but-agent-dependent (named honestly, MA-2):** `bugfix-commit` (trailer) and `agent-diagnosed` (one tap). The most semantically-valuable "sideways" failures flow here. The instar-dev gate *nudges* the trailer when a commit touches shipped feature code; omission is *measured*, not assumed away. The spec does **not** claim "no remember-to-log anywhere" — it claims clean-chain capture is structural and the manual surfaces are minimized + prompted + coverage-tracked.

### 4.6.1 The closed self-improvement loop — track → discover → implement → deploy → verify

The heart of the feature. It rides existing rails at every step:

1. **Track** — FailureLedger auto-captures + attributes (§4.2/§4.3).
2. **Discover** — the analyzer surfaces an evidence-backed, support+diversity-thresholded gap (§4.4), recorded as an `InsightRecord`:
   ```jsonc
   { "id": "INS-001", "identityKey": "<content-stable hash>", "discoveredAt": "…",
     "summary": "…", "recommendation": "<template-keyed>",
     "supportingFailureIds": ["FAIL-…"], "distinctSessions": 3, "distinctCauseCommits": 3,
     "status": "discovered | acted-on | verified-effective | verified-ineffective | inconclusive | dismissed",
     "origin": "failure-learning-loop",          // §step 3 authority tag
     "actedOnVia": "<initiativeId | ACT-id>",
     "verifyWindowStart": "…", "verifyWindowEnd": "…", "targetCategory": "…",
     "baselineRate": 0.0, "reopenCount": 0, "verifiedOutcome": "pending|effective|ineffective|insufficient-exposure" }
   ```
3. **Implement (tracked, never forgotten — but never auto-applied).** A thresholded insight **auto-opens a tracked item**: an Evolution Action (`/commit-action`) and, for a code/skill change, a **draft Initiative** in `needs-user`, stamped `origin: failure-learning-loop`. **Structural authority guard (BL-2):**
   - The autonomous-evolution evaluator (`processProposalAutonomously`) **hard-excludes any `origin: failure-learning-loop` proposal from the `auto-implement` branch** regardless of `evolutionApprovalMode` — it is always `queue-for-approval`.
   - The loop's **only** write privilege is *creating tracked items via API*; it has **no** file-write capability to `skills/`, `src/`, or `docs/specs/` (asserted by test). Any resulting change MUST traverse the standard instar-dev gate (spec→`/spec-converge`→user-approval→trace) — the same wall as every other commit.
4. **Deploy** — an approved improvement rides the standard path: spec → `/spec-converge` → `/instar-dev` → merge → **Graduated Rollout** (matures dark→live→default-on). It auto-registers on the board and stamps a v3 toolchain trace, so it is a first-class tracked feature from the moment it ships.
5. **Verify (the closure — actively driven, confounder-aware).** On entering `acted-on`, the analyzer stamps an explicit **verification window** (`verifyWindowStart` = the fix's merge date, `verifyWindowEnd`, `targetCategory`, `baselineRate`). A **definite analyzer pass at/after `verifyWindowEnd` MUST terminally evaluate** — it never parks at `acted-on` indefinitely (MA-1, the active-follow-through + commitment-auto-resolve lesson). It compares the **exposure-normalized** rate (failures per N features-of-that-category shipped in the window), requires a **minimum post-change exposure** before concluding (else `insufficient-exposure` → extend once → then `inconclusive`):
   - **dropped** → `verified-effective` (labeled *correlational*, never "the fix worked");
   - **not dropped** → `verified-ineffective`, reopen — but **`reopenCount` capped at 2**, after which it goes terminal `inconclusive` requiring human disposition (no infinite respawn, M3-adversarial).
   - **Recursive closure:** if the improvement itself later regresses, it is captured like any feature — no special-casing.

### 4.7 Boundaries (what this is NOT)

- **vs DegradationReporter:** runtime fallback observability, not dev-process forensics (connects via opt-in source #F).
- **vs Evolution Action Queue:** the loop *feeds* it (a thresholded insight opens an Action); failures/insights are the evidence + diagnosis that justify an Action, not Actions themselves.
- **vs Commitments:** promises to the user; unrelated.
- **vs Learning registry:** the *output sink* (redacted), not the failure record.

### 4.8 Lifecycle / rollback / privacy / multi-machine

- **Reopen:** §4.6.1 step 5 governs (capped).
- **Rollback (M5):** disabling `failureLearning.enabled` stops capture/analysis/push; the ledger + already-opened initiatives/Attention items stay **intact and inert** (owned by their own subsystems, resolved normally by a human); already-written v3 traces remain valid (readers ignore `toolchain`); **no auto-opened initiative is auto-closed** (a human owns it).
- **Redaction (C7):** `detail.full` **never** enters (a) an LLM prompt, (b) an `addLearning` description, (c) a Telegram post, or (d) the default dashboard view; `full` is exposed only behind an explicit "show internal detail" affordance that is **not served over the tunnel** (reuse the internal-routes XFF/origin signal). §6 asserts this on the LLM + Telegram paths.
- **Multi-machine (M2):** machine-scoped IDs + TaskFlow-primary + inherited git-sync conflict handling; central `ci`-poller records reconcile with per-machine `regression`/`revert` records via the `dedupeKey` upsert.
- **Backfill bounding:** historical pre-v3 / pre-feature entries register as `unknown`-provenance, provenance-only, excluded from active analysis.

## 5. Open questions (for round 2 + user)

1. **CI ingestion:** batched `gh run list` poller at ≥6h (lean, lowest new surface) vs a webhook (preferred long-term for rate-budget). 
2. **Analyzer cadence:** weekly + threshold (lean) — confirm against rollout driver's twice-weekly so the two don't collide.
3. **First slice scope:** ship `bugfix-commit` + `agent-diagnosed` + toolchain stamp + ledger + `/failures` routes + dashboard tab + analyzer (capture+discover+the human-approved loop), defer `ci`/`revert`/`regression`/`degradation` as layered sources on the rollout board. The feature is itself a staged rollout (dogfood).

## 6. Testing (3-tier, NON-NEGOTIABLE)

- **Unit:** FailureLedger CRUD + **mandatory `ifMatch`** + retry-on-409 + deterministic-`dedupeKey` upsert (repeat → `occurrenceCount`, not duplicate); attribution engine on clean-chain AND ambiguous (both sides) + the `attributionConfidence` 0.6 boundary (both sides); trace v3 schema + v2→v3 read + the `write-trace.mjs` migration stock-fingerprint guard; analyzer metric math + `minSupport`/diversity gates (must refuse below threshold; must refuse single-session-manufactured support); exposure normalization; redaction split (assert `full` excluded from LLM-prompt + Telegram paths specifically); enum-constrained classifier rejects injected categories.
- **Integration:** all `/failures*` routes incl. `401` without token and `X-Instar-Request` required on `POST`; the **`InitiativeTracker.update()` regression-emission chokepoint** covers both existing writers (wiring-integrity: not a no-op); **TaskFlow ⇄ JSON parity** — CRUD + attribution + analyzer aggregates run under `taskFlow.enabled:true` AND `:false`, identical results.
- **E2E:** Phase-1 "feature is alive" (200, not 503, on the production init path); **corrected dogfood proof** — author a fix commit carrying a `Fixes-Feature:` trailer whose touched files intersect a real initiative's `coveredFiles`, and assert an attributed FailureRecord appears on its own with the correct initiative + (verified/claimed-labeled) toolchain join. **Closed-loop:** an insight crossing threshold auto-opens an Evolution Action + draft initiative with `actedOnVia` set, `origin: failure-learning-loop`, and is **provably excluded from auto-implement with `evolutionApprovalMode: autonomous` ON**; the loop has **no** file-write to `skills/`/`src/`/`docs/specs/`; a post-change exposure-normalized drop flips to `verified-effective`, no drop → `verified-ineffective` then `inconclusive` at `reopenCount` 2; the insight pushes to the system topic **once** (never re-announces on re-confirmation).

## 7. Migration parity (Migration Parity Standard)

- Trace v2→v3: additive read; **`write-trace.mjs` enrichment delivered via named `PostUpdateMigrator.migrateWriteTraceEnrichment()`** (stock-fingerprint guard) + `instar-dev` added to the skill-script allowlist; verify `scripts/` dirs are migrated (not init-only).
- FailureLedger: TaskFlow-primary + lazy JSON; `migrateExistingFailuresToTaskFlow()` startup backfill (idempotent).
- Analyzer job: shipped as `src/scaffold/templates/jobs/instar/failure-analyzer.md` (recognized slug, off by default; **not** migration-written — else retired-swept), `supervision: tier1`.
- Routes + dashboard tab: ship with server bundle; `/capabilities` + Registry-First + `generateClaudeMd` Dashboard features + `migrateClaudeMd` content-sniff.
- Config: `migrateConfig` existence-checks for every knob (§9), all defaulting safe/off.
- **Dependency ordering (M4):** at init, feature-detect InitiativeTracker-TaskFlow + Graduated-Rollout presence; if absent, degrade to **capture-only** (ledger + dashboard) and no-op the auto-open step gracefully (logged, not errored). State min instar version carrying both.

## 8. Success criteria

A fix commit that names the feature it repairs (or a one-tap diagnosis) produces — without ceremony — a deduped FailureRecord attributed to its initiative, spec, project, cause commit, and the (verified-or-labeled) dev toolchain that built it. After enough *diverse, verified* records accumulate, the analyzer surfaces a support-and-diversity-thresholded, evidence-backed insight; it shows on the Process Health tab, pushes once to the system topic (if enabled), and **auto-opens a human-approved** tracked improvement that deploys through the normal spec→build→rollout path. The analyzer then **actively verifies, exposure-normalized and confounder-aware, whether the targeted failure class dropped** — marking the insight effective (labeled correlational) or reopening it (capped) — and never silently parks or fabricates a result. The loop is unbroken and honest: tracking → discovery → approved implementation → deployment → verification.

## 9. Config (all default safe/off)

`failureLearning.enabled` (false), `minSupport` (4), `minDistinctSessions` (3), `minDistinctCauseCommits` (3), `attributionConfidenceFloor` (0.6), `analyzerSchedule` (cron, weekly), `ciPoller.{enabled:false,intervalMs}`, `revertSource.enabled` (false), `regressionSource.enabled` (false), `degradationPromotion.{enabled:false,subsystems:[]}`, `insightTelegramEscalation` (false). Each added via `migrateConfig` existence-check.

## 10. Round-1 finding ledger

| ID | Sev | Reviewer(s) | Resolution |
|----|-----|-------------|-----------|
| BL-1 | blocker | sec/scale/adv/integ/lessons | `regressed` is rollout-backslide/merge-unreachability, not functional failure; no event hook; two writers; not edge-triggered. → first slice = #A/#B; #E rewritten as new detection emitted from `InitiativeTracker.update()`, edge-triggered idempotent; §6 E2E driven by #A. |
| BL-2 | blocker | adversarial | Existing `processProposalAutonomously` auto-implements. → `origin: failure-learning-loop` hard-excluded from auto-implement; loop has no file-write (tested). |
| BL-3 | blocker | security | Forgeable toolchain + injectable failure text. → claims-vs-verified provenance; untrusted-text classifier (enum-constrained); template-keyed recommendations. |
| poisoning | major | sec/adv | dedupeKey+occurrenceCount, source-diversity gate, attribution-type weighting, liveness/decay, trailer cross-check, filedBy, server-side validation, rate-limit + X-Instar-Request, read-only-over-tunnel. |
| verify | major | adv/lessons | exposure-normalized rate, active verification window + definite terminal eval, reopenCount cap → inconclusive, correlational labeling. |
| hot-path | major | scalability | write-trace O(1), caller-literals, fail-open-omit. |
| store/concurrency | major | scale/integ | TaskFlow-primary analytical store + indexes + rollup; mandatory ifMatch + retry; machine-scoped IDs; git-sync inheritance. |
| job-retire | blocker(integ) | integration | analyzer ships as template slug, off by default. |
| trace-delivery | blocker(integ) | integration | named migrateWriteTraceEnrichment + allowlist + scripts-migrated check. |
| telegram-topic | major | integ/lessons | route to existing system topic, off by default, stable insight identity (push once). |
| multi-machine | major | scale/integ | machine-scoped IDs + TaskFlow + git-sync. |
| taskflow-parity | major | integration | §6 parity tests both storage paths. |
| dep-ordering | major | integration | feature-detect + degrade to capture-only. |
| rollback | major | integration | §4.8 rollback semantics. |
| redaction | major | security | bind full out of LLM/addLearning/Telegram/tunnel-dashboard; tested. |
| llm-supervision | major | lessons | analyzer `supervision: tier1` + Haiku validator. |
| minors | minor | all | auth-post-middleware, causeCommitOid-no-upgrade, config table, dashboard-bundle, confidence threshold + test, coverage-fraction, version-hash, attention carries FAIL-ids + cap. |
