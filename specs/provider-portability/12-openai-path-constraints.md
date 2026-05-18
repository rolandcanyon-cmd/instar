---
review-convergence: "2026-05-17T19:30:00Z"
review-iterations: 3
review-completed-at: "2026-05-17T19:30:00Z"
review-report: "docs/specs/reports/openai-path-constraints-convergence.md"
approved: true
approved-by: "Justin (JKHeadley)"
approved-date: "2026-05-17"
---

# OpenAI / Codex Path Constraints — Foundational Rules

**Status:** Active, approved by Justin 2026-05-17.
**Branch:** `spec/provider-portability`
**Applies to:** Every OpenAI / Codex-touching code path in Instar, current and future. Drives every Codex-adjacent routing decision in Phase 5+. Drives every adapter design that targets Codex.
**Companion:** ELI16 overview at `12-openai-path-constraints.eli16.md`.
**Authority hierarchy:** When this document conflicts with `04-anthropic-path-constraints.md`, the rule that is MORE restrictive on raw-API usage wins. Inherited invariants from 04 (env-scrubbing pattern, signal-vs-authority enforcement layering, kill-switch ergonomics) apply here unchanged unless this document explicitly tightens them.

---

## ELI16 — what this document says

Instar talks to OpenAI's Codex CLI in two possible ways. One is safe; one is dangerous. This document says when each one is allowed, and how Instar structurally prevents the dangerous one from leaking in.

The two ways:
1. **Subscription path** — Instar drives the `codex` CLI authenticated against a ChatGPT subscription (the OAuth token sitting in `~/.codex/auth.json`). The same way a human runs `codex` after signing in. Bills against the ChatGPT subscription's usage envelope. No extra cost.
2. **Raw API key path** — Instar (or anything Instar spawns) bills against the OpenAI API account at full per-token rates by setting `OPENAI_API_KEY` in env, calling `api.openai.com` directly, or using a client SDK that does either.

The rule:
- **Rule 1:** The subscription path is the only allowed path. The raw API key path is forbidden as a routine path.
- **Rule 1a:** Env-scrubbing at spawn boundaries is mandatory. The Codex CLI prefers `OPENAI_API_KEY` over OAuth when both are present in its env, so refusing to *read* the env var in Instar config is not enough — Instar MUST strip it from every child process env.

The reason: a runaway loop on the raw API drains real money fast. A runaway loop on the subscription tops out at the subscription's session-limit envelope (work just stops). There is no OpenAI equivalent of Anthropic's "Agent SDK credit pot" — no prepaid middle tier — so unlike the Anthropic stack there is nothing to drain first. Either the subscription is sufficient or the work doesn't run.

---

## Rule 1 — Subscription-only on Codex

Every Codex code path in Instar MUST route through the `codex` CLI authenticated against a ChatGPT subscription. The CLI's stored OAuth token in `~/.codex/auth.json` is the credential of record; the CLI refreshes it internally.

Raw `OPENAI_API_KEY` direct-API mode — whether passed via `OPENAI_API_KEY` env var, `codex login --with-api-key`, or any client library hitting `api.openai.com` directly — is **forbidden as a routine path**. Treat any direct-API code path as a critical bug to be fixed before ship.

### Practical consequences

- The `OpenAiCodexConfig` interface MUST NOT carry an `apiKey?: string` field. The field is removed at the type level, not merely unread — leaving it in the interface invites callers to pass an API key via `createOpenAiCodexAdapter({ apiKey: '...' })` with zero grep hits on any banned literal. A type-level test asserts `OpenAiCodexConfig['apiKey']` is `never` (or that the property is absent).
- The Codex adapter's `AuthCredentialInjection.validate()` is the single declared authority on auth-mode acceptance. Every other layer (constructor, registry's `candidates(cap)`, cost-aware routing, pre-commit grep) is a signal that defers to it. Validate runs at adapter construction AND immediately before each `spawn()` — not cached past the credential file's mtime.
- Any new Codex code path that wants to bypass the subscription path is a critical bug. The escape hatch is to NOT add the path — escalate the design instead.
- Default model when running through subscription auth is `gpt-5.3-codex` (the historic CLI default `gpt-5.2-codex` was retired from subscription auth on 2026-04-14). Adapter config defaults to subscription-compatible models only.
- The published `openai` npm package, `@openai/*` packages, `litellm`-as-library, and any SDK that embeds `api.openai.com` are banned as dependencies outside an explicit allowlist. The ban is on CLIENTS, not just on endpoint literals — domain-string evasion via concatenation, template-split, or computed access is closed by attacking the import graph, not by grep alone.

### Rule 1a — Env-scrubbing at exec time (mandatory)

The Codex CLI silently prefers `OPENAI_API_KEY` over OAuth when both are present in its env. Refusing to *read* the env var in Instar config is insufficient — Echo and other agents commonly inherit `OPENAI_API_KEY` from a developer shell where another project sets it.

Every Codex spawn (`spawnCodexAndWait`, `spawnInteractiveSession` with framework `codex-cli`, any future helper that exec's `codex`) MUST:

1. **Allowlist, not blocklist.** Construct the child env from an explicit whitelist of variables the CLI needs (`HOME`, `PATH`, `CODEX_HOME`, `XDG_*`, locale, terminal sizing, user-supplied `OPENAI_BASE_URL` if present at process boot — see scope clarification below). Do NOT inherit `process.env` wholesale and then `delete` selected keys; new variables added by the OS or by user tooling would silently slip past a blocklist.
2. **Hard-delete the OpenAI-billing variables.** Even with allowlist construction, defensively set `OPENAI_API_KEY=undefined`, `OPENAI_ORG_ID=undefined`, `OPENAI_PROJECT_ID=undefined` on the child env. Belt-and-suspenders against future allowlist expansion regressions.
3. **Audit-log every spawn.** Each Codex spawn writes a line to `.instar/security.jsonl` recording: (a) the env-var **names** used (values never logged), (b) whether `OPENAI_BASE_URL` was inherited from boot env (hostname-only and sha256 of full URL, per the BASE_URL section), (c) the auth-mode reported by the credential validator (private-bucket code). Names-not-values prevents accidental secret leakage if the allowlist ever expands to a variable that carries credentials.
4. **Log rotation and snapshot exclusion.** `.instar/security.jsonl` rotates at 5 MB or daily (whichever first) to `.instar/security.jsonl.N`; retention 30 days. Dashboard reads only the head file. The default snapshot policy excludes rotated archives older than 7 days and excludes the security log entirely from sync (mirroring the exclusion of `~/.codex/auth.json`). Rotation uses atomic rename (`rename()` syscall) so a concurrent reader never observes a partial file.

**Audit-log schema and write-failure policy.** Each line is a single JSON object with these fields:

```
{ ts: '<ISO 8601>', event: 'codex.spawn' | 'codex.auth.reject' | 'codex.base_url.observe' | 'codex.escape_hatch.active', schema_version: 1, ... event-specific fields }
```

Every event carries `schema_version` for forward compatibility — readers MUST tolerate unknown fields and MUST refuse to consume lines with a higher schema version than they recognize. Schema bumps are spec amendments.

Writes are append-only via `open(O_APPEND | O_CREAT, 0600)` then `write()` of `JSON.stringify(line) + '\n'`. POSIX guarantees atomic append for writes ≤ PIPE_BUF (4096 bytes); spawn-log lines are bounded at 1 KB to stay safely under that limit. Lines longer than 4 KB (defensive ceiling) are truncated with a `_truncated: true` field rather than written partially.

**Write-failure policy.** If the audit log cannot be written (disk full, permission denied, parent directory missing) the adapter:
1. Emits a `codex.audit.write_failed` metric counter (public bucket).
2. Logs the failure via the standard process logger (stderr).
3. Refuses the spawn for `security_violation` and `user_config_error` classes (no audit = no accountability = no spawn).
4. Permits the spawn for `transient` classes after logging the audit failure separately (the spawn is non-state-changing; the audit gap is documented as a fail-open event for transients).

The audit log is required infrastructure; sustained write failures are treated as a Phase-5 alertable condition.
5. **Redaction canary.** A canary test asserts that no value-shape token (matches `/sk-[A-Za-z0-9]/`, OAuth refresh-token shape, JWT shape) ever appears in a `.instar/security.jsonl` line written by Codex spawn logging. Runs at adapter init alongside the env-leakage canary.

The `openaiKeyLeakageCanary` covers EVERY callsite enumerated in Rule 1a, not just `spawnCodexAndWait`. Specifically: `spawnCodexAndWait`, `spawnInteractiveSession` with framework `codex-cli`, and any future helper added to the spawn-path enumeration. A CI assertion enumerates spawn callsites by AST scan and fails if a new callsite is added without canary coverage.

### Credential-shape validation requirements

`AuthCredentialInjection.validate()` MUST do all of the following before declaring auth healthy. Every failure returns a **structured error code**, not a string-matched message — the routing layer and dashboard consume these codes directly. **Error codes are partitioned into public and private buckets to prevent credential-state reconnaissance via metrics**:

- **Public bucket** (emitted to `codex.auth.reject{code}` metric, visible to any dashboard / cost-router consumer): `AUTH_UNHEALTHY` (generic). The metric only carries the generic code, not the specific failure reason.
- **Private bucket** (emitted to `.instar/security.jsonl` and the security-notification path only): the specific codes below. Available to admin dashboards but not to general metric consumers.

Private-bucket codes are further grouped into **failure classes** so the routing layer, dashboard, and remediation logic can react appropriately without string-matching individual codes:

| Class | Semantics | Routing reaction | Operator action |
|---|---|---|---|
| `security_violation` | Rule 1 was violated (API-key shape detected). `CODEX_AUTH_APIKEY_DETECTED` falls here. | Adapter refuses; routing excludes Codex; security channel notified immediately. | Investigate credential source. Never auto-retry. |
| `user_config_error` | Setup is incomplete or wrong on this machine. `CODEX_AUTH_FILE_MISSING`, `CODEX_BASE_URL_UNAPPROVED_CHANGE`, `CODEX_BASE_URL_UNTRUSTED`, `CODEX_BASE_URL_HAS_USERINFO` fall here. | Adapter refuses; routing excludes Codex; dashboard shows remediation card. | User runs `codex login` or approves BASE_URL. Self-heal on user action. |
| `transient` | Temporary; expected to clear without operator action. `CODEX_AUTH_OAUTH_REFRESH_FAILED`, `CODEX_AUTH_CLI_PROBE_TIMEOUT`, `CODEX_AUTH_CLI_PROBE_UNAVAILABLE` (subcommand not found in this CLI version) fall here. | Adapter refuses; routing cool-down per the `cool-down per failure kind` table; auto-retry on cool-down expiry. | None for short windows; investigate if persistent. |
| `unknown` | Failure not yet classified (defensive default). `CODEX_AUTH_UNKNOWN_FAILURE` falls here. | Adapter refuses; routing cool-down (conservative, 300s default); security channel notified after second consecutive occurrence. | Diagnose via the structured error context in the audit log. |

The `codex.auth.reject{code, class}` metric labels the class on the public bucket; the specific code stays in the private bucket. Consumers who need to distinguish "retry sensible" from "operator required" use the class, not the code.

**CLI probe failure handling.** When `codex auth status --json` cannot be invoked (subcommand missing, subprocess timeout, parser error), `validate()` returns `transient` class — NOT `security_violation`. Reason: a probe failure cannot prove subscription mode, but it also cannot prove API-key mode. Conservative behavior is "treat as unhealthy with auto-retry," not "treat as Rule 1 violation." The probe has a 2-second timeout default (configurable via `INSTAR_CODEX_AUTH_PROBE_TIMEOUT_MS`); after timeout, the probe is treated as unavailable and the steps-1-4 file-shape check is authoritative for that spawn while emitting a `transient` `CODEX_AUTH_CLI_PROBE_TIMEOUT` event.



- `CODEX_AUTH_FILE_MISSING` — file at `~/.codex/auth.json` doesn't exist.
- `CODEX_AUTH_FILE_UNREADABLE` — file exists but can't be opened.
- `CODEX_AUTH_FILE_PARSE_FAILED` — file isn't valid JSON.
- `CODEX_AUTH_SHAPE_INCOMPLETE` — required OAuth tokens are missing.
- `CODEX_AUTH_APIKEY_DETECTED` — any API-key-shaped field appeared in the parsed object (Rule 1 violation).
- `CODEX_AUTH_CLI_REPORTS_NON_SUBSCRIPTION` — `codex auth status --json` reports mode != subscription.
- `CODEX_AUTH_OAUTH_REFRESH_FAILED` — token refresh attempt failed; CLI may silently fall back to API-key mode if available.



1. Confirm `~/.codex/auth.json` exists and is readable.
2. Parse the file as JSON. Reject on parse failure with a structured error pointing at `codex login`.
3. Confirm the file contains a refresh-token entry conforming to the subscription OAuth shape: `tokens.refresh_token` (string, non-empty) AND `tokens.id_token` (string, non-empty) AND `tokens.access_token` (string, non-empty). Schema may evolve; document the version this spec was written against (Codex CLI 0.130.0) and gate via the existing `codexSessionLayoutCanary` pattern when the shape drifts.
4. Confirm the file contains NO API-key-shaped fields at any depth: reject if `OPENAI_API_KEY`, `api_key`, `apiKey`, or any field whose value matches `/^sk-/` appears anywhere in the parsed object.
5. (Optional, recommended) Run `codex auth status --json` if the subcommand exists; reject if the CLI's own reported mode is anything other than `subscription`. This catches the upstream-drift scenario where the CLI silently falls back to API-key mode after an OAuth refresh failure — a class of bug Instar's adapter cannot detect from the auth file alone.

Caching policy is split by step to balance correctness against hot-path cost:

- **Steps 1–4 (file-shape checks).** Cache result for `min(file_mtime + 60s, next_call)`. Validation budget: p99 < 5ms (cheap fs.stat + small JSON parse on cache miss). This portion can safely cache because file mutation reliably bumps mtime.
- **Step 5 (`codex auth status --json` CLI probe).** Cache for at most 60 seconds OR until a file mtime change is detected, whichever comes first. Reuse for intervening spawns regardless of spawn rate. Validation budget: p99 < 500ms when the cache misses; never on the spawn hot path when warm. The CLI probe cannot be skipped because it catches "CLI silently fell back to API-key mode after OAuth refresh failed" — a class of bug the file-shape checks miss.
- **Bypass on signal.** Both caches are invalidated immediately on any `codex` auth-error response, on detection of file mtime change, or on receipt of `oauth_refresh_failed` saturation event. The cache is a hot-path optimization, not a correctness boundary — always-revalidate is acceptable when in doubt.

The cache window for file-shape MUST NOT exceed the CLI probe window. An attacker who mutates `~/.codex/auth.json` while preserving mtime (via explicit utimes) cannot prevent step 5 from re-running on the next probe interval; the worst-case detection window is bounded by the probe cache TTL, not by mtime stability.

### Exceptions

There is one defensible exception class, mirroring the Anthropic spec: lifecycle / observability operations that have no CLI equivalent and don't bill per-token.

**Default-deny applies.** A new exception requires:
1. A spec amendment landing in the SAME PR as the code that uses the exception.
2. Convergence through this spec's same review loop before the amendment merges.
3. Justification specifically addressing why the call cannot be served by `codex exec` or by local accounting.

**Inference paths never qualify** as exceptions, defined structurally as: any call whose request body contains a `model`, `messages`, `prompt`, `tools`, `temperature`, `max_tokens`, or `response_format` field, or that returns a streamed completion. Framing creativity (e.g., "structured observability of a model output") does not change the classification.

As of 2026-05-17, OpenAI does NOT publish a usage / quota endpoint equivalent to Anthropic's `/api/oauth/usage`, so there is no current concrete exception — local accounting in `usageMeterProvider.ts` carries the load instead.

### Why

The raw API key path bills against the user's OpenAI account at full per-token API rates. Two failure modes are catastrophic:

1. **Runaway cost.** A misbehaving loop on the raw API has no spending cap unless one is explicitly configured. The subscription path tops out at the ChatGPT subscription's session envelope (work just stops or rate-limits). The raw API path tops out at the API account's funded balance, which is the user's bank account.

2. **No subscription protection.** Subscription-driven calls share OpenAI's subscription-grade rate-limit policies and operational protections. Raw API calls are commercial-API-tier — a different envelope than Instar is designed for.

The economic logic mirrors the Anthropic constraint: Justin keeps Instar's compute inside subscription billing envelopes deliberately. Routing around that envelope defeats the entire architectural rationale.

### What's different from the Anthropic constraint

The Anthropic spec (`04-anthropic-path-constraints.md`) defines THREE paths: subscription, SDK credit, raw API. Anthropic has a prepaid middle tier (the Agent SDK $200/month pot) that the routing policy drains first. **OpenAI has no equivalent prepaid middle tier.** As of 2026-05-17 the choices are subscription-or-nothing — there is no Codex analog of "drain SDK credits first."

This shapes Phase 5 routing differently for the Codex stack:
- For Anthropic candidates: SDK-credit-first with subscription fallback (Phase 5c spec).
- For Codex candidates: subscription-only or refuse. No drain-first decision to make.

An earlier comment in `src/providers/adapters/openai-codex/config.ts` framed `OPENAI_API_KEY` mode as "the Agent SDK credit pot analog" for OpenAI. **That framing was incorrect.** API-key mode is not a budget-bounded prepaid tier; it is full-rate commercial billing. The analog of Anthropic's SDK credit path on the OpenAI stack is *nothing* — there is no prepaid pot to drain. The correct response is to refuse the raw-API path entirely, not to legitimize it under the "we have to drain SOMETHING first" frame.

### Future tiers clause

If OpenAI introduces a prepaid, capped, non-API-key middle tier (analog of Anthropic's Agent SDK credit pot), this spec is amended through the same convergence loop. The amendment defines the new tier's scope, billing semantics, and routing position.

Until that amendment merges, any "middle tier" proposal — including third-party budget proxies, ChatGPT API "deposit" balances, or other capped prepaid offerings — is treated as a Rule-1 violation. The default is deny, not "wait and see."

---

## Operational consequences

### Deployment shape — applies identically to desktop and headless

This rule applies the same way whether Instar runs in a desktop-interactive context (echo on a paired machine with a logged-in user) or in a headless / server context (a CI worker, a background job runner, a remote container). In both cases:

- The `~/.codex/auth.json` file is the credential of record. Headless deployments MUST pre-stage the file via deployment automation (e.g., a sealed secret mounted into the agent's HOME); the agent itself never runs `codex login` interactively.
- Adapter construction fails identically if the file is missing or malformed — the rule does not relax for headless because the runaway-cost risk is identical.
- The dashboard / Telegram remediation surfaces are skipped in headless contexts; the structured error code is logged and the job is marked as failed for the orchestrator to handle.

This explicitly removes the implicit assumption that Codex is a "desktop interactive" feature. Phase 5+ routing treats Codex adapters as routable from any deployment shape that has valid subscription credentials staged.

### Availability is binary by design

Codex has one path. When the ChatGPT subscription envelope saturates, or the OAuth refresh fails, or there's a regional outage, the entire Codex slice goes dark — there is no second safe path to fall back to. This is a designed-in single-point-of-failure for the Codex slice, not an oversight.

The Phase 5 routing chain MUST treat Codex as a lower-availability candidate:
- On 429 / session-limit / auth-error responses, the registry's `candidates(cap)` drops Codex for a cool-down window (default 60s, configurable).
- The routing policy falls through to sibling adapters (Anthropic-pool, Gemini when it lands, OSS) for capability-equivalent work rather than blocking.
- Phase 5d fitness benchmarking treats Codex's availability as a fitness signal — work that requires high availability deprioritizes Codex candidates.

### Pool concurrency

Every Codex pool session pulls from one ChatGPT subscription envelope. Unlike the Anthropic stack (where Justin runs five Max 20x subscriptions for envelope multiplexing), OpenAI offers no equivalent multi-account flat-rate pattern.

The Codex adapter defaults `maxConcurrentCodexSessions` to 2 (configurable via `INSTAR_CODEX_POOL_SIZE`). Beyond that, concurrent sessions serialize against the same envelope and one runaway session can starve the others. Raising the cap requires accepting either serialization or additional ChatGPT subscriptions.

### Local usage accounting

OpenAI has no public usage endpoint as of 2026-05-17. `usageMeterProvider.ts` accumulates a local approximation by counting `turn.completed.usage` fields from Codex's structured event stream. Over a billing period this drift can be 10-30% (tokenizer mismatches, retry double-counting, abandoned streams).

The Phase 5c `CostStateTracker.isMaterialShift` and any future cost-routing math MUST NOT use local Codex usage for decisions that require accuracy better than ±15%. If OpenAI ships an authoritative usage endpoint, a reconciliation hook is added through this spec's amendment process.

### Cost-aware routing interaction (Phase 5c+)

`CostAwareRoutingPolicy` (defined in `11-cost-aware-routing.md`) is Anthropic-only by construction: it throws "neither Anthropic adapter" and defers to `ChainPolicy` for non-Anthropic candidates. This spec does NOT extend that policy to Codex.

Instead, a new sibling policy `CodexAvailabilityPolicy` is introduced in Phase 5 implementation. It runs as a **global pre-filter** that strips ineligible Codex adapters from the candidate set BEFORE other policies run, rather than as a peer policy in the chain. This closes the failure mode where `CostAwareRoutingPolicy` might pick a Codex adapter that's registered with an Anthropic-equivalent capability (mistake, future multi-stack adapter, attacker-shaped config) before the structural Codex filter ever runs.

- **Pre-filter stage:** `CodexAvailabilityPolicy.filter(candidates)` removes any Codex adapter whose `validate()` returns non-healthy. Operates on the unfiltered candidate list passed by the registry.
- **Chain stage:** `CostAwareRoutingPolicy` (Anthropic) → `FirstAvailable` (everything else). Codex candidates that survive the pre-filter are selectable through `FirstAvailable` like any non-Anthropic provider.
- `CostAwareRoutingPolicy` ALSO invokes `validate()` defensively on any candidate it considers — never assume upstream filtering is sufficient.

### Cool-down windows per failure kind

The `60s cool-down on 429/session-limit/auth-error` from the prior version was too coarse — OAuth-refresh-failed needs minutes-to-recover, transient 429 needs seconds. Cool-downs are per-`codex.session.saturation{kind}`:

| Failure kind | Cool-down default | Recovery semantics |
|---|---|---|
| `rate_limit` (transient 429) | 30s | Time-based; retry after window |
| `session_envelope_exhausted` | 300s with jitter | Time-based; envelope refills gradually |
| `oauth_refresh_failed` | Until next `validate()` success | Event-based; no time reset |
| `regional_outage` (5xx burst) | 120s with jitter | Time-based; recheck after window |

The `CodexAvailabilityPolicy.shortcircuit{reason}` metric labels the active cool-down kind.

---

## Scope clarification — what "Codex traffic" means

The constraint governs OpenAI-stack inference traffic, NOT every model call from anywhere in the stack. Two configurations specifically:

| Path | Subject to Rule 1? | Notes |
|---|---|---|
| **ChatGPT subscription via `codex` CLI** (OAuth in `~/.codex/auth.json`) | YES — IS the subscription floor | Mandatory for all Codex-stack work. |
| **Raw OPENAI_API_KEY** (env var or `codex login --with-api-key`) | YES — explicitly forbidden | Banned. Not a routable destination. |
| **Custom OPENAI_BASE_URL** (Codex CLI pointed at a non-OpenAI backend — Ollama, LiteLLM proxy, OpenRouter, etc.) | n/a — not OpenAI traffic | Rule-exempt third route. Substrate must remain compatible (no errors, no special-casing) but Instar does NOT ship or recommend a base-URL override. Subject to additional Instar-side restrictions below. |

### Instar-side restrictions on OPENAI_BASE_URL

The exemption above is **user-installed, user-owned**. Instar's own code is further restricted:

1. **Instar code MUST NOT set `OPENAI_BASE_URL`** in any spawn env, config file, env-merge layer, or migration helper. The variable may flow through ONLY when present in the user's process-boot env. A grep test asserts no LHS assignment to `OPENAI_BASE_URL` exists anywhere in `src/`.
2. **Boot-time snapshot.** `OPENAI_BASE_URL` is captured ONCE at Instar process boot into a sealed module-level constant (`BOOT_OPENAI_BASE_URL`). Spawn-time env construction reads from that snapshot, never from the live `process.env`. Runtime mutation of `process.env.OPENAI_BASE_URL` (by a misbehaving plugin, hostile dispatch, or a future maintainer mistake) cannot affect already-running adapters. Runtime changes by the user require an agent restart — documented behavior.
3. **First-observation user confirmation.** On first observation of a non-empty `OPENAI_BASE_URL` per machine, the adapter refuses to spawn until the value is explicitly approved. Approval lives in a dedicated state file `.instar/codex-base-url.approved` (mode `0600`), NOT in `.instar/security.jsonl` (the security log is append-only audit, not authoritative state). The approval file contains: `{ url: '<full URL>', sha256: '<hash>', approved_at: '<ISO>', hmac: '<HMAC-SHA256 of payload using machine-local key>' }`. The HMAC binds the approval to this machine's sentinel-signing key (same key used elsewhere in Instar); on read, the adapter verifies the HMAC against the recomputed expected value. A forged approval line (e.g., an attacker with write access to `.instar/`) fails verification and is treated as no approval.

   Approval is granted by:
   - **Interactive deployments**: user confirmation via Telegram/dashboard. Approval write happens server-side after the user confirms — the user is never asked to hand-edit the file.
   - **Headless deployments**: pre-staged via deployment automation. Two acceptable mechanisms: (a) deployment system writes `.instar/codex-base-url.approved` with a valid HMAC at provisioning time (mirrors how `~/.codex/auth.json` is pre-staged); (b) operator sets `INSTAR_BASE_URL_PREAPPROVED_SHA256=<sha256 of OPENAI_BASE_URL>` in boot env, and Instar materializes an approval record at startup if the sha256 matches the boot value. Pre-staging is the headless analog of interactive confirmation; both produce the same approval record on disk.

   On subsequent boots, the adapter compares `BOOT_OPENAI_BASE_URL` against the approved record; mismatches refuse-and-alert with structured error `CODEX_BASE_URL_UNAPPROVED_CHANGE` until re-approved. Closes the "compromised shell rc silently redirects OAuth-bearer traffic to an attacker host" attack.

4. **Hostname allowlist for unconfirmed values (resolution-pinned).** As a belt-and-suspenders defense, until user approval is recorded, `OPENAI_BASE_URL` is only honored when ALL of the following match:
   - URL parses cleanly (no embedded userinfo, valid scheme).
   - For non-loopback hostnames, the URL scheme is `https://` (loopback may use `http://`).
   - The hostname's **resolved IP address** (DNS lookup at validation time) is in the loopback/RFC1918 set, OR the hostname is the literal `api.openai.com` resolved to an IP not in private ranges.
   - The resolved address is re-checked on every spawn (not just at first observation), so a DNS-rebind attack that flipped the address after approval is caught.
   - `*.local` mDNS names are excluded from the allowlist — they require explicit user approval.

   Hostname-string-only allowlist checks are forbidden (DNS / `/etc/hosts` manipulation could spoof `api.openai.com`). For `api.openai.com` specifically, Instar cannot enforce TLS cert pinning (the Codex CLI owns that path); the spec relies on the CLI's own pinning behavior, which is documented as a trusted-upstream assumption gated by the `codexSessionLayoutCanary` pattern for drift detection. Any other hostname refuses with `CODEX_BASE_URL_UNTRUSTED` until explicitly approved.

5. **Audit logging with values, not just names.** When `OPENAI_BASE_URL` is honored, the adapter logs `{ var: 'OPENAI_BASE_URL', hostname: '<host-only>', sha256: '<hash of full URL>' }` to `.instar/security.jsonl` — hostname only (no path, no userinfo, no query string), plus a sha256 of the full value for change-detection. Userinfo embedded in the URL (e.g., `https://user:pass@proxy/`) is structurally rejected at parse time with `CODEX_BASE_URL_HAS_USERINFO`.
6. **`OPENAI_BASE_URL` is added to the Rule 3 grep target set** in `scripts/check-rule3-coverage.cjs`. Any PR that adds an LHS assignment to it in `src/` is blocked.

**Compatibility, not endorsement.** A user who chooses `OPENAI_BASE_URL=http://localhost:11434/v1` for local Ollama, or who points at a corporate LiteLLM proxy, is fine — that's their tooling choice. Instar accommodates the configuration without breaking. Instar does not ship, recommend, default to, or programmatically set the override.

**Compliance boundary at the process edge.** Instar's compliance with Rule 1 ends at its own spawn boundary. If a user-installed proxy (LiteLLM, OpenRouter, a hand-rolled fanout service) requires an API key at its OWN backend to talk to `api.openai.com`, that's the proxy's billing, not Instar's. Instar's audit log records the `OPENAI_BASE_URL` override at every spawn, so post-hoc analysis can distinguish "Instar billed an API key" (forbidden, never happens) from "user's proxy may have billed an API key downstream" (possible, user-owned, out of Instar's compliance scope). Rule 1a env-scrubbing runs identically regardless of `OPENAI_BASE_URL` value — Instar never lets `OPENAI_API_KEY` reach a child process, whether the child is the real Codex CLI hitting OpenAI or the same CLI hitting a user's proxy.

This parallels the translation-proxy carve-out for `ANTHROPIC_BASE_URL` in the Anthropic spec. Phase 6 (open-source / local adapter) explicitly leans on this: the strategic shortcut is "Codex CLI + Ollama via OPENAI_BASE_URL" rather than building an Ollama adapter from scratch.

---

## How this document is enforced

### Authority hierarchy (load-bearing)

Multiple enforcement layers exist by design (defense in depth). When they disagree, this is the declared resolution order:

1. **`AuthCredentialInjection.validate()`** — single source of truth on auth-mode acceptance. Its refusal is binding.
2. **Adapter constructor** — calls `validate()` before completing construction; refuses on failure.
3. **Exec-time validation** — calls `validate()` again immediately before each `spawn()`; refuses on failure even if construction succeeded (auth file edited mid-session, env mutated, OAuth refresh failed since last call).
4. **Routing policy / `candidates(cap)`** — defers to `validate()` for adapter eligibility; never caches eligibility past the credential file's mtime.
5. **Pre-commit Rule 3 grep + LLM gate** — signal layer. Hits escalate to human review; the LLM-graded check is the authority on whether the code is a Rule 1 violation.

Disagreements resolve toward the more-restrictive ruling. The grep is allowed to false-positive; `validate()` is not allowed to false-negative.

### Structural enforcement (phase-scoped deliverables)

Enforcement gates land in waves matched to the migration phases — NOT all in the same PR, because the staged Phase A → Phase B sequencing requires the `apiKey` field to remain present (deprecated + internal-tagged) during Phase A. The "MUST NOT merge until in place" framing is per-phase, not single-PR. Each phase below names the gates that MUST land before that phase ships:

**Pre-Phase A (the rule-landing PR):**
- **`src/providers/adapters/openai-codex/credentials.ts`** — implements the credential-shape validation requirements above. Caches per the split-cache policy.
- **`src/providers/adapters/openai-codex/transport/codexSpawn.ts`** — env-allowlist construction. The function refuses to inherit `process.env` wholesale; takes an explicit `env` argument or constructs one via `buildCodexChildEnv()` helper.
- **`src/providers/adapters/openai-codex/canary/openaiKeyLeakageCanary.ts`** (new) — sets `OPENAI_API_KEY=sk-CANARY` in parent env and asserts child process never observes it. Critical-severity, runs at adapter init.
- **`scripts/check-rule3-coverage.cjs`** — adds detection patterns: `api.openai.com`, `OPENAI_API_KEY` (env var name as identifier), `new OpenAI(`, `openai.chat.completions.create`, `import.*['"]openai['"]`, `require.*['"]openai['"]`, LHS assignment to `OPENAI_BASE_URL`. Fixture updates for the test suite at `tests/unit/scripts/check-rule3-coverage.test.ts` cover true-positive and true-negative cases per pattern.
- **`specs/provider-portability/06-state-detector-registry.md`** — new rows for `openaiKeyLeakageCanary`, status ✅ Compliant.
- One-time exhaustive callsite audit (per migration section).
- Audit-log schema implementation per the section above.

**At Phase A landing:**
- **`src/providers/adapters/openai-codex/config.ts`** — `configFromEnv` no longer reads `OPENAI_API_KEY`. The "Agent SDK credit pot analog" comment block is replaced with a reference to this spec. The `apiKey` field remains in `OpenAiCodexConfig` but is paired with `@deprecated` + `@internal` JSDoc tags, and the field is enforced as warning-only via the `@typescript-eslint/no-deprecated` ESLint rule (escalated to error in the same release).
- Phase A telemetry / warning surfaces wired.

**At Phase B landing:**
- **`OpenAiCodexConfig.apiKey`** narrowed to `apiKey?: never` for one release to surface stragglers as type errors, then deleted entirely in the following release.
- Drift-detection CI gate activates: build fails if `config.ts` still contains the string "Agent SDK credit pot analog" or has a non-`never` `apiKey` field type. Closes the "spec approved, code still says the opposite" failure mode.
- Phase A telemetry / warning surfaces upgraded to hard refusal.

The phase-scoped framing replaces the prior "single-PR" framing because the staged migration is itself a load-bearing safety property — landing everything in one PR would break existing installs at the same instant the warning was supposed to give them notice.

- **`src/providers/adapters/openai-codex/config.ts`** — `apiKey` field deleted from `OpenAiCodexConfig`. `configFromEnv` no longer reads `OPENAI_API_KEY`. The "Agent SDK credit pot analog" comment block is replaced with a reference to this spec.
- **`src/providers/adapters/openai-codex/credentials.ts`** (or current location of `AuthCredentialInjection`) — implements the credential-shape validation requirements above. Caches with mtime invalidation.
- **`src/providers/adapters/openai-codex/transport/codexSpawn.ts`** — env-allowlist construction. The function refuses to inherit `process.env` wholesale; takes an explicit `env` argument or constructs one via `buildCodexChildEnv()` helper.
- **`src/providers/adapters/openai-codex/canary/openaiKeyLeakageCanary.ts`** (new) — sets `OPENAI_API_KEY=sk-CANARY` in parent env and asserts child process never observes it. Critical-severity, runs at adapter init.
- **`scripts/check-rule3-coverage.cjs`** — adds detection patterns: `api.openai.com`, `OPENAI_API_KEY` (env var name as identifier), `new OpenAI(`, `openai.chat.completions.create`, `import.*['"]openai['"]`, `require.*['"]openai['"]`, LHS assignment to `OPENAI_BASE_URL`. Fixture updates for the test suite at `tests/unit/scripts/check-rule3-coverage.test.ts` cover true-positive and true-negative cases per pattern.
- **`specs/provider-portability/06-state-detector-registry.md`** — new row for `openaiKeyLeakageCanary`, status ✅ Compliant.

### Runtime enforcement

- The cost-aware routing policy (via `CodexAvailabilityPolicy`, introduced in Phase 5 implementation) refuses to route to a Codex adapter that fails `validate()`. The adapter constructor refuses to start in that mode, so the policy short-circuits structurally rather than through eligibility checks alone.
- The audit-log in `.instar/security.jsonl` records every Codex spawn's env-whitelist, auth-mode, and `OPENAI_BASE_URL` presence. Post-hoc evidence of compliance.

### Observability requirements

Every adapter and every routing decision emits structured metrics consumable by the dashboard and by future cost-routing fitness signals:

- **`codex.auth.reject{code}`** — counter per error code (see code list in the credential-validation section). Drives the dashboard's "Codex: auth state" tile.
- **`codex.spawn.env_scrubbed{base_url_present}`** — counter per spawn confirming Rule 1a ran; labeled with whether `OPENAI_BASE_URL` was inherited from boot env.
- **`codex.session.saturation{kind}`** — counter on 429 / session-limit / OAuth-refresh-failed responses, by kind. Feeds the cool-down decision.
- **`codex.routing.shortcircuit{reason}`** — counter when `CodexAvailabilityPolicy` excludes Codex from the candidate set; labeled by reason (`apikey_only`, `oauth_unhealthy`, `cooldown_active`).

Reject metrics MUST distinguish "user misconfiguration" (`CODEX_AUTH_FILE_MISSING`, expected on first install) from "Rule 1 violation" (`CODEX_AUTH_APIKEY_DETECTED`, security-relevant) — the dashboard surfaces them differently and only the latter triggers a security-channel notification.

### Drift detection (`config.ts` ↔ this spec)

While `12-openai-path-constraints.md` is `approved: true`, a CI gate fails the build if `src/providers/adapters/openai-codex/config.ts` still contains the string `"Agent SDK credit pot analog"` or has a non-empty `apiKey` field on `OpenAiCodexConfig`. Closes the "spec approved, code still says the opposite" failure mode.

---

## Migration

### Existing installs

Some Instar installs today have `OPENAI_API_KEY` set in env and a Codex adapter that reads it into config. The rule landing is a breaking change for those installs. Migration runs in two phases:

**Phase A — Warning + telemetry (one release):**
- Adapter construction with API-key-configured `~/.codex/auth.json` OR with `OPENAI_API_KEY` in env emits a structured warning at startup pointing at this spec and the exact `codex login` command needed.
- A telemetry event records the violation for diagnostics. No behavior change yet.
- The Codex adapter still functions on the API-key path during this phase.

**Phase B — Hard refuse (next release):**
- Adapter construction refuses to complete when API-key-only auth is detected. The structured error names the offending source (file vs. env var), points to `codex login`, and links to the dashboard remediation card.
- Existing config files with `apiKey` field surface a schema-validation error at startup (NOT silent ignore — silent ignore masks the user's intent and they spend hours debugging).

**Escape hatch:** `INSTAR_DISABLE_RULE1_OPENAI=1` env var allows API-key mode for one additional release window after Phase B lands. Use is logged loudly every minute. Provides a runtime rollback if the rule breaks production for any user.

**Hard sunset enforcement.** The sunset is structural, not policy. A hardcoded ISO date constant `RULE1_KILLSWITCH_SUNSET_DATE` lives in the validator. After that date the env var is ignored entirely and `validate()` returns `CODEX_KILLSWITCH_EXPIRED`. A CI gate fails **release-cut workflows specifically** (not all PR CI) two weeks before the date, forcing a deliberate decision on whether to extend or remove. Scoping to release-cut avoids the chicken-and-egg failure mode where every PR (including the one extending the sunset) is blocked.

The extend-or-remove decision uses a documented emergency-extension PR template that touches only the constant and adds an updated rationale; this PR runs through the normal review path but is gated to a security-channel approval before merge. Closes the "documented date escape hatch survives for years" anti-pattern AND the "CI gate becomes its own deadlock" anti-pattern.

**Sequencing during the migration window.** Rule 1a (env-scrubbing + canary) ships in the SAME release as Phase A, BEFORE warning-only adapter behavior is enabled. Env-scrubbing is independent of the auth-acceptance policy and closes the credential-harvest window during Phase A. The release ordering is non-negotiable: (1) env-scrub + canary, THEN (2) Phase A warning telemetry, THEN (3) Phase B hard refuse — never interleave or reorder.

**One-time exhaustive callsite audit at Rule 1a landing.** The CI assertion that enumerates spawn callsites for canary coverage (mentioned in the credential-validation section) operates on additions going forward. At the Rule 1a landing PR, a one-time exhaustive audit lists EVERY existing `codex`-exec'ing callsite in the repo (including test harnesses, debug helpers, and `child_process.exec/spawn/spawnSync` wrappers) and asserts each routes through `buildCodexChildEnv()`. The audit's enumeration becomes the CI gate's "known callsites" set; additions must be appended explicitly. Closes the "Phase A ships with an un-migrated path still leaking OPENAI_API_KEY" failure mode.

**Escape-hatch interaction with Rule 1a.** When `INSTAR_DISABLE_RULE1_OPENAI=1` is set AND the sunset date has not passed:
- The env-allowlist passes `OPENAI_API_KEY` through to child processes (the one variable Rule 1a normally scrubs).
- All other allowlist behavior is unchanged.
- `openaiKeyLeakageCanary` downgrades to a warning rather than a critical failure.
- Audit log records `escape_hatch_active=true` on every spawn.
- Adapter construction permits API-key auth with a Phase-A-style warning, not a refusal.

When the sunset date has passed, the env var is ignored regardless and the adapter behaves as if the escape hatch were never set.

**Drift-detection sequencing.** The CI drift-detection gate (config.ts vs spec) fires when `12-openai-path-constraints.md` is `approved: true` AND release-channel is past Phase A. During Phase A the `apiKey?: string` field stays in the interface but is paired with BOTH `@deprecated` AND `@internal` JSDoc tags — the former triggers IDE warnings, the latter suppresses autocomplete in TypeScript-aware IDEs so new callers are not invited to fill in the field. A repo-level ESLint rule (`@typescript-eslint/no-deprecated`, or equivalent) enforced in the same release escalates any new usage to a build error.

In the Phase B release, the field is type-deleted entirely (replaced with `apiKey?: never` for one additional release to surface stragglers as type errors, then fully removed). Picks (b) of the round-2 integration finding: type-level deletion is staged, not same-PR as the spec approval — but the Phase A surface area is structurally narrowed to prevent new callers regardless.

**Coherence-gate semantics for Codex-dependent jobs.** A job is "Codex-dependent" only if its capability requirements cannot be satisfied by `CodexAvailabilityPolicy` falling through to `FirstAvailable`. Routing-flexible jobs are NOT skipped when Codex auth is unhealthy on this machine — they proceed via sibling adapters. The coherence-gate consults `registry.candidates(cap)` AFTER `CodexAvailabilityPolicy` has run to make this distinction. Only when every adapter that can serve the required capabilities is Codex-only does the job skip.

### Multi-machine pairing

`~/.codex/auth.json` is per-machine and not synced. When a new machine pairs into Instar:

1. The startup self-check distinguishes "Codex never configured" (the user hasn't logged in here) from "Codex configured but OAuth missing on this machine" (the user is paired in but hasn't run `codex login` yet).
2. The dashboard surfaces a Codex auth state: one of `oauth-ok`, `oauth-missing-this-machine`, `apikey-refused-rule1`, `not-configured`. Each state carries a one-line remediation string and the relevant CLI command.
3. The coherence-gate integration treats Codex-dependent jobs as "skip" when the local Codex auth is unhealthy — the job logs a structured skip rather than failing.
4. On first start after pairing, a Telegram message goes to the user with the remediation card if Codex is in an unhealthy state.

### Backup / restore

Instar snapshots cover config files but explicitly exclude `~/.codex/auth.json` (security: the OAuth refresh token is a long-lived high-value credential not appropriate for snapshot payloads). After a restore on a new machine:

1. A post-restore detector surfaces the gap as an attention-queue item.
2. The restore summary emits a one-liner action: "Codex requires `codex login` on this machine."
3. The Codex adapter declines to start until `codex login` completes, with a clear error pointing at this spec.

---

## Coherence with 04-anthropic-path-constraints

This spec inherits the following invariants from `04-anthropic-path-constraints.md` by reference. If those invariants change in 04 via a future revision, this spec is re-converged in the same PR:

- **Path designation** — subscription path is the floor; non-subscription paths are constrained.
- **Routing policy ownership** — cost-aware routing lives in Phase 5c spec, not in path-constraints docs.
- **Translation-proxy carve-out** — `*_BASE_URL` overrides are compatibility-without-endorsement; Instar code must not set them.
- **Enforcement layering** — design review + pre-commit grep + runtime validation; signal-vs-authority separation between layers.
- **Telemetry on violation** — every adapter-refusal writes a structured event for post-hoc diagnostics.

Shared-invariant deltas (where 12 is MORE restrictive than 04):

- 12 explicitly bans the CLIENT class (the `openai` npm package, etc.), not just endpoint literals. 04 should adopt the equivalent ban for the `anthropic` npm package in its next revision.
- 12 explicitly requires env-scrubbing at exec time (Rule 1a). 04 should adopt the equivalent (`ANTHROPIC_API_KEY` env-scrub) in its next revision.
- 12 explicitly forbids Instar code from setting `OPENAI_BASE_URL`. 04 should adopt the equivalent for `ANTHROPIC_BASE_URL`.

These deltas are queued as 04-revision follow-ups. Until 04 revises, 12 sets the higher bar and 04 inherits via the "more restrictive wins" authority rule.

---

These rules are foundational. They predate Phase 5 implementation and override any earlier adapter code that conflicts with them.
