# Instar Functional Map — Provider Coupling Audit

**Status:** Draft v0.1 (2026-05-14, post-convergence-pass-1)
**Branch:** `spec/provider-portability`
**Phase:** 1a (foundation, complete coverage)
**Method:** Four parallel Explore agents, each scoped to a disjoint slice of `src/`, independent lenses, union synthesized here.

---

## ELI16 Overview

Before we design the abstraction layer that lets Instar talk to any agent provider (Claude, Codex, Gemini, local models), we need to know exactly where Instar currently assumes Claude. Not just the obvious places where it runs `claude -p`, but every implicit assumption — every file that parses Claude's conversation log format, every place that reads `~/.claude/` directly, every hook payload field with a Claude-specific shape, every "session UUID" that's really a Claude Code session UUID.

This document is the result of mapping every file in instar's source tree (441 TypeScript files across 24 subdirectories) through four parallel scanning agents with different lenses on the codebase, then unioning their findings. It groups instar by functional area, flags every file's coupling level to Claude (direct, indirect, none), and identifies which functional clusters need provider abstraction and which can be left alone.

The headline number: of 441 source files, roughly **170 have some form of Claude coupling** (~38%). About 50 are *direct* coupling (call `claude -p`, hit `api.anthropic.com`, parse `~/.claude/projects/`, register into `~/.claude.json`). The rest are *indirect* — they assume Claude Code hook payload shapes, Claude session UUIDs, Claude-tier model names, or route through interfaces whose only implementation today is Claude.

The good news: most of the indirect coupling lives behind interfaces (`IntelligenceProvider`, `SessionManager`) that were *designed* for swapping. The bad news: those interfaces don't cover everything. The Phase 1 primitives inventory had four layers (transport / capability / observability / control), but this mapping exercise surfaced **twelve coupling categories** the inventory did not name. They're listed at the bottom of this document as Phase 1 gaps that need to fold into the Phase 2 interface design.

---

## Master Functional Map

Files organized by functional cluster, with coupling level: **D** (direct Claude), **I** (indirect), **N** (none).

### A. Intelligence & Provider Layer
| Cluster | Files | Direct | Indirect | None |
|---|---|---|---|---|
| IntelligenceProvider interface + implementations | `core/types.ts` (interface), `core/AnthropicIntelligenceProvider.ts`, `core/ClaudeCliIntelligenceProvider.ts`, `core/models.ts` | 3 | 1 | 0 |
| Coherence reviewers (15 reviewers, base class with API fallback) | `core/CoherenceReviewer.ts`, `core/reviewers/*` (10+ files) | 1 (base) | 14 | 0 |
| Stop-gate decision LLM call | `core/UnjustifiedStopGate.ts`, `server/stopGate.ts` | 2 | 0 | 0 |

**Coupling note:** This is the layer that *should* be the abstraction boundary. `IntelligenceProvider.evaluate()` already abstracts one-shot judgment calls; reviewers route through it. But the base class falls back to direct Anthropic API when no provider is configured, and the stop-gate has Claude-Code-specific rule IDs baked in.

### B. Session Spawning & Lifecycle
| Cluster | Files | Direct | Indirect | None |
|---|---|---|---|---|
| SessionManager core (tmux + `claude -p` spawning) | `core/SessionManager.ts` | 1 | 0 | 0 |
| Session types + config | `core/types.ts` (Session, SessionManagerConfig, claudeSessionId field) | 1 | 0 | 0 |
| Pipe-session spawner (threadline lightweight) | `threadline/PipeSessionSpawner.ts` | 1 | 0 | 0 |
| Listener session manager (warm Claude Code session w/ JSONL inbox) | `threadline/ListenerSessionManager.ts`, `threadline/listener-daemon.ts`, `threadline/WakeSocketServer.ts` | 2 | 1 | 0 |
| Setup wizard interactive REPL | `commands/setup.ts` | 1 | 0 | 0 |
| Dispatch executor (spawns sessions for agentic dispatches) | `core/DispatchExecutor.ts`, `core/DispatchManager.ts` | 0 | 2 | 0 |
| Job scheduler (drives spawning) | `scheduler/JobScheduler.ts`, `scheduler/JobLoader.ts`, `scheduler/JobClaimManager.ts`, `scheduler/JobRunHistory.ts`, `scheduler/SkipLedger.ts`, `scheduler/IntegrationGate.ts` | 0 | 6 | 0 |

**Coupling note:** Session spawning is the most critical and most coupled cluster. Three distinct transport patterns exist: headless `-p` in tmux (SessionManager), one-shot piped `-p` (PipeSessionSpawner), warm session with JSONL-inbox injection (ListenerSessionManager). All three assume Claude. Plus the interactive REPL with stdio inheritance (setup.ts). Four transports total.

### C. Claude Code Hook Reception & Telemetry
| Cluster | Files | Direct | Indirect | None |
|---|---|---|---|---|
| Hook event HTTP receiver | `monitoring/HookEventReceiver.ts`, `data/http-hook-templates.ts` (the install templates) | 2 | 0 | 0 |
| Hook event consumers (per-event handlers) | `monitoring/InstructionsVerifier.ts`, `monitoring/SubagentTracker.ts`, `monitoring/CompactionSentinel.ts`, `monitoring/HelperWatchdog.ts`, `monitoring/CommitmentSentinel.ts`, `monitoring/SessionActivitySentinel.ts`, `monitoring/CommitmentTracker.ts`, `monitoring/ReflectionMetrics.ts`, `monitoring/TelemetryCollector.ts`, `monitoring/TelemetryHeartbeat.ts` | 1 | 9 | 0 |
| Session UUID resume maps | `server/routes.ts` (TopicResumeMap), `threadline/ThreadResumeMap.ts`, `threadline/SessionLifecycle.ts`, `threadline/ContextThreadMap.ts` | 0 | 4 | 0 |

**Coupling note:** This is the **biggest blind spot in Phase 1**. Instar consumes 10+ distinct Claude Code hook event types (`PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`, `WorktreeCreate`, `WorktreeRemove`, `TaskCompleted`, `SessionEnd`, `PreCompact`, `InstructionsLoaded`) and a sprawl of monitoring code depends on the payload schema. Non-Claude providers don't have an equivalent event stream — for those we'd have to synthesize events ourselves from `outputStream` + heuristics.

### D. Session Health, Stall, Crash, Recovery
| Cluster | Files | Direct | Indirect | None |
|---|---|---|---|---|
| Stall/crash detectors (parse JSONL + tmux output) | `monitoring/stall-detector.ts`, `monitoring/crash-detector.ts`, `monitoring/SessionMonitor.ts`, `monitoring/SessionWatchdog.ts`, `monitoring/SessionRecovery.ts` | 0 | 5 | 0 |
| Stall triage (LLM-powered diagnosis) | `monitoring/StallTriageNurse.ts`, `monitoring/StallTriageNurse.types.ts`, `monitoring/TriageOrchestrator.ts`, `monitoring/CrashLoopPauser.ts` | 0 | 4 | 0 |
| Process reapers + worktree cleanup | `monitoring/OrphanProcessReaper.ts`, `monitoring/WorktreeMonitor.ts`, `monitoring/WorktreeReaper.ts`, `monitoring/jsonl-truncator.ts` | 0 | 4 | 0 |
| Presence proxy / delivery sentinel | `monitoring/PresenceProxy.ts`, `monitoring/ProxyCoordinator.ts`, `monitoring/delivery-failure-sentinel.ts`, `monitoring/delivery-failure-sentinel/recovery-policy.ts` | 0 | 4 | 0 |

**Coupling note:** Heavily dependent on Claude Code's JSONL conversation format (`~/.claude/projects/<path>/<uuid>.jsonl`) and tmux output patterns. Non-Claude providers expose different log shapes — JSONL parsing has to become a provider-specific reader.

### E. Quota & Credentials
| Cluster | Files | Direct | Indirect | None |
|---|---|---|---|---|
| Anthropic OAuth quota polling | `monitoring/QuotaCollector.ts` | 1 | 0 | 0 |
| Quota enforcement chain | `monitoring/QuotaTracker.ts`, `monitoring/QuotaExhaustionDetector.ts`, `monitoring/QuotaManager.ts`, `monitoring/QuotaNotifier.ts` | 0 | 4 | 0 |
| Credential storage (Keychain + ~/.claude config) | `monitoring/CredentialProvider.ts`, `monitoring/SessionCredentialManager.ts`, `monitoring/AccountSwitcher.ts` | 1 | 2 | 0 |

**Coupling note:** Becomes mission-critical with the June 15 Agent SDK credit change. QuotaCollector hits `/api/oauth/usage` and `/api/oauth/profile` on `api.anthropic.com`; CredentialProvider reads Keychain service `"Claude Code-credentials"`. This whole cluster needs a provider-generic abstraction with per-provider auth/usage adapters.

### F. Interactive Prompt Detection
| Cluster | Files | Direct | Indirect | None |
|---|---|---|---|---|
| Terminal UI prompt detection | `monitoring/PromptGate.ts`, `monitoring/InputClassifier.ts`, `monitoring/templates-drift-verifier.ts`, `monitoring/watchdog-notifications.ts` | 1 | 3 | 0 |

**Coupling note:** Parses Claude Code's terminal UI literally — "Do you want to create...?", "❯", "Esc to cancel · Tab to amend", ANSI escapes. Provider-specific because each agent CLI has its own prompt UI.

### G. Initialization, Scaffolding, Setup
| Cluster | Files | Direct | Indirect | None |
|---|---|---|---|---|
| Init / setup commands | `commands/init.ts`, `commands/setup.ts`, `cli.ts` | 2 | 1 | 0 |
| Scaffold templates | `scaffold/bootstrap.ts`, `scaffold/templates.ts` | 2 | 0 | 0 |
| Hook configuration installer | `data/http-hook-templates.ts` | 1 | 0 | 0 |

**Coupling note:** `init.ts` creates the entire `.claude/` directory tree: `CLAUDE.md`, `.claude/settings.json`, `.claude/scripts/*`, `.claude/skills/*`. Hard-codes the directory name and the hook event types. Setup wizard hard-requires Claude CLI and walks the user through a Claude Code conversational onboarding. Provider portability requires either generalizing this to a per-provider scaffolder OR keeping `.claude/` and adding parallel `.codex/`, `.gemini/` trees.

### H. Memory & Knowledge
| Cluster | Files | Direct | Indirect | None |
|---|---|---|---|---|
| Topic summarizer (LLM-powered) | `memory/TopicSummarizer.ts` | 0 | 1 | 0 |
| Activity partitioner / episodic memory (parses Claude logs) | `memory/ActivityPartitioner.ts`, `memory/EpisodicMemory.ts`, `memory/TopicMemory.ts`, `memory/WorkingMemoryAssembler.ts` | 0 | 4 | 0 |
| Generic memory infrastructure | `memory/SemanticMemory.ts`, `memory/MemoryIndex.ts`, `memory/VectorSearch.ts`, `memory/Chunker.ts`, `memory/EmbeddingProvider.ts`, `memory/MemoryExporter.ts`, `memory/MemoryMigrator.ts` | 0 | 0 | 7 |
| Self-Knowledge Tree | `knowledge/TreeTriage.ts`, `knowledge/SelfKnowledgeTree.ts`, `knowledge/TreeGenerator.ts`, `knowledge/TreeSynthesis.ts`, `knowledge/KnowledgeManager.ts`, `knowledge/CoverageAuditor.ts`, `knowledge/ProbeRegistry.ts`, `knowledge/types.ts` | 0 | 8 | 0 |
| Generic knowledge infrastructure | `knowledge/TreeTraversal.ts`, `knowledge/IntegrityManager.ts` | 0 | 0 | 2 |

**Coupling note:** TopicSummarizer and TreeTriage use IntelligenceProvider — portable via that interface. ActivityPartitioner and EpisodicMemory parse Claude's JSONL conversation log specifically. Vector search and embeddings layer is fully provider-neutral.

### I. Threadline (Agent-to-Agent Network)
| Cluster | Files | Direct | Indirect | None |
|---|---|---|---|---|
| Relay infrastructure (server, routing, presence, abuse) | `threadline/relay/*` (16 files) | 0 | 0 | 16 |
| Core protocol (crypto, trust, discovery, handshakes) | `threadline/ThreadlineCrypto.ts`, `threadline/HandshakeManager.ts`, `threadline/AgentDiscovery.ts`, `threadline/AgentTrustManager.ts`, `threadline/TrustBootstrap.ts`, `threadline/TrustEvaluator.ts`, `threadline/UnifiedTrustWiring.ts`, `threadline/TrustAuditLog.ts`, `threadline/ThreadlineRouter.ts`, `threadline/ThreadlineEndpoints.ts`, `threadline/InboundMessageGate.ts`, `threadline/A2AGateway.ts`, `threadline/MessageSecurity.ts`, `threadline/DiscoveryWaterfall.ts`, `threadline/CircuitBreaker.ts`, `threadline/InvitationManager.ts`, `threadline/SecureInvitation.ts`, `threadline/ApprovalQueue.ts`, `threadline/AutonomyGate.ts`, `threadline/AuthorizationPolicy.ts`, `threadline/RelayGroundingPreamble.ts`, `threadline/ComputeMeter.ts`, `threadline/RateLimiter.ts`, `threadline/types.ts`, `threadline/index.ts` | 0 | 0 | 25 |
| Bootstrap into `~/.claude.json` | `threadline/ThreadlineBootstrap.ts`, `threadline/ThreadlineMCPServer.ts`, `threadline/mcp-stdio-entry.ts` | 2 | 1 | 0 |
| Client + MCP auth | `threadline/client/*` (7 files), `threadline/MCPAuth.ts` | 0 | 0 | 7 |
| Cross-framework adapters | `threadline/adapters/*` (5 files), `threadline/OpenClawBridge.ts`, `threadline/OpenClawSkillManifest.ts` | 0 | 0 | 7 |
| Content classifier (optional LLM hook) | `threadline/ContentClassifier.ts` | 0 | 1 | 0 |

**Coupling note:** Threadline is overwhelmingly provider-agnostic — by design, it's a protocol layer. The Claude coupling is concentrated in (a) ThreadlineBootstrap registering into `~/.claude.json` as an MCP server, and (b) the pipe-session/listener spawning paths (counted under cluster B above).

### J. Messaging (Telegram / Slack / iMessage / WhatsApp)
| Cluster | Files | Direct | Indirect | None |
|---|---|---|---|---|
| Platform adapters | `messaging/TelegramAdapter.ts`, `messaging/slack/SlackAdapter.ts`, `messaging/imessage/IMessageAdapter.ts`, `messaging/WhatsAppAdapter.ts`, `messaging/AdapterRegistry.ts` | 0 | 2 | 3 |
| Core routing + delivery | `messaging/MessageRouter.ts`, `messaging/MessageStore.ts`, `messaging/MessageDelivery.ts`, `messaging/MessageFormatter.ts`, `messaging/DeliveryRetryManager.ts`, `messaging/NotificationBatcher.ts`, `messaging/DropPickup.ts`, `messaging/types.ts`, `messaging/system-templates.ts` | 0 | 0 | 9 |
| Session-summary sentinel (LLM-powered phase classification) | `messaging/SessionSummarySentinel.ts` | 0 | 1 | 0 |
| Spawn request manager | `messaging/SpawnRequestManager.ts` | 0 | 1 | 0 |
| Shared infrastructure (auth, logging, bridges, event bus, flags, etc.) | `messaging/shared/*` (16 files) | 0 | 0 | 16 |
| Slack / iMessage / WhatsApp utilities | `messaging/slack/*` (8 files), `messaging/imessage/*` (5 files), `messaging/backends/*` (3 files) | 0 | 0 | 16 |
| Telegram formatting | `messaging/TelegramMarkdownFormatter.ts`, `messaging/telegramFormatMetrics.ts` | 0 | 0 | 2 |
| Topic content validator (optional LLM hook) | `messaging/TopicContentValidator.ts` | 0 | 1 | 0 |
| Misc | `messaging/local-tone-check.ts`, `messaging/secret-patterns.ts`, `messaging/pending-relay-store.ts`, `messaging/whoami-cache.ts`, `messaging/GitSyncTransport.ts`, `messaging/AgentTokenManager.ts` | 0 | 0 | 6 |

**Coupling note:** Messaging is almost entirely provider-agnostic. Adapters use `IntelligenceProvider` *optionally* for content validation and session-phase summarization. Platform coupling is to Telegram/Slack/iMessage/WhatsApp, NOT to Claude.

### K. HTTP Server, Routes, MCP
| Cluster | Files | Direct | Indirect | None |
|---|---|---|---|---|
| Server core + route registration | `server/AgentServer.ts`, `server/routes.ts`, `server/middleware.ts`, `commands/server.ts` | 0 | 4 | 0 |
| Stop gate (Claude compaction marker) | `server/stopGate.ts` | 1 | 0 | 0 |
| Worktree routes | `server/worktreeRoutes.ts` | 0 | 1 | 0 |
| Generic server infra | `server/machineAuth.ts`, `server/fileRoutes.ts`, `server/boot-id.ts`, `server/WebSocketManager.ts`, `server/SecretDrop.ts` | 0 | 0 | 5 |

**Coupling note:** `routes.ts` (6500+ lines) is the central HTTP surface. Receives Claude Code hook events; stores `claudeSessionId` against Instar sessions; uses Claude session UUID as part of topic-session resume lookup. `stopGate.ts` checks `/tmp/claude-session-<id>/compacting` markers.

### L. CLI Commands
| Cluster | Files | Direct | Indirect | None |
|---|---|---|---|---|
| Provider-touching commands | `commands/reflect.ts`, `commands/server.ts` | 0 | 2 | 0 |
| Init / setup (covered in cluster G) | (see G) | — | — | — |
| Other operational commands | `commands/listener.ts`, `commands/job.ts`, `commands/memory.ts`, `commands/status.ts`, `commands/nuke.ts`, `commands/discovery.ts`, `commands/migrate.ts`, `commands/backup.ts`, `commands/knowledge.ts`, `commands/intent.ts`, `commands/git.ts`, `commands/relationship.ts`, `commands/semantic.ts`, `commands/review.ts`, `commands/relay.ts`, `commands/gate.ts` | 0 | 0 | 16 |

### M. Identity, Crypto, Auth, Security
| Cluster | Files | Direct | Indirect | None |
|---|---|---|---|---|
| Identity (Ed25519, key rotation, recovery phrase) | `identity/*` (8 files) | 0 | 0 | 8 |
| Security (LLM sanitizer, manifest integrity) | `security/LLMSanitizer.ts`, `security/ManifestIntegrity.ts` | 0 | 1 | 1 |
| User management | `users/*` (6 files) | 0 | 1 | 5 |
| Privacy | `privacy/OutputPrivacyRouter.ts` | 0 | 0 | 1 |

### N. Lifeline (Process Supervision)
| Cluster | Files | Direct | Indirect | None |
|---|---|---|---|---|
| TelegramLifeline + ServerSupervisor + helpers | `lifeline/*` (12 files) | 0 | 0 | 12 |

**Coupling note:** Lifeline supervises the Instar server process. It doesn't talk to Claude; it manages the supervisor-child relationship. Provider-agnostic.

### O. Coherence Tracking, Drift, Quality Gates
| Cluster | Files | Direct | Indirect | None |
|---|---|---|---|---|
| Scope/temporal/convergence coherence | `core/ScopeCoherenceTracker.ts`, `core/TemporalCoherenceChecker.ts`, `core/ConvergenceChecker.ts` | 0 | 1 | 2 |
| Project mapper | `core/ProjectMapper.ts` | 0 | 1 | 0 |
| Feature registry & surfacing | `core/FeatureRegistry.ts`, `core/FeatureDefinitions.ts`, `core/SurfacingTemplates.ts` | 0 | 0 | 3 |
| Supporting state/validation/guards | `core/StateManager.ts`, `core/CanonicalState.ts`, `core/SecurityLog.ts`, `core/InputGuard.ts`, `core/PromptGuard.ts`, `core/MessagingToneGate.ts`, `core/ResumeValidator.ts`, `core/PrerequisitesChecker.ts`, `core/OverlapGuard.ts`, `core/OutboundDedupGate.ts` | 0 | 2 | 8 |

### P. MoltBridge, Publishing, Tunnel, Utilities
| Cluster | Files | Direct | Indirect | None |
|---|---|---|---|---|
| MoltBridge (agent discovery/profiles) | `moltbridge/*` (5 files) | 0 | 0 | 5 |
| Publishing (Telegraph, PrivateViewer) | `publishing/*` (2 files) | 0 | 0 | 2 |
| Tunnel (Cloudflare) | `tunnel/TunnelManager.ts` | 0 | 0 | 1 |
| Utilities (jsonl-rotation, privacy, sanitize) | `utils/*` (3 files), `types/pipeline.ts` | 0 | 1 | 3 |
| Data / config | `data/builtin-manifest.json`, `data/pr-gate-artifacts.ts`, `config/ConfigDefaults.ts`, `config/LiveConfig.ts` | 0 | 0 | 4 |
| Scaffolding templates dir | `templates/hooks/*`, `templates/scripts/*` | (0 files in src — templates served from data/) | | |

---

## File Count Reconciliation

| Slice | Scope files | Direct Claude | Indirect Claude | None |
|---|---|---|---|---|
| 1 — Central nervous system | 167 | 37 | 28 | 102 |
| 2 — Communication layer | 129 | 11 | 13 | 105 |
| 3 — Observability + persistence | 81 | 5 | 47 | 29 |
| 4 — Entry points + utilities | 64 | ~10 | ~20 | ~34 |
| **TOTAL** | **441** | **~63** | **~108** | **~270** |

About 38% of instar's source has some form of Claude coupling. About 14% is direct coupling that must be touched in the provider-abstraction port. The remaining ~24% indirect coupling can in most cases be addressed by tightening the interfaces — i.e., the work is *interface design*, not file rewrites.

---

## Gap Analysis vs. Phase 1 Primitives Inventory

Phase 1 surfaced 21 primitive candidates across four layers. This mapping pass surfaced **twelve coupling categories the Phase 1 inventory did not name**. These are the *additions* required for Phase 2 interface design:

### Missing primitives

| # | New primitive (proposed name) | Why missed in Phase 1 | Files affected |
|---|---|---|---|
| 1 | `hookEventReceiver` (consume 10+ Claude Code hook event types: PostToolUse, SubagentStart, SubagentStop, Stop, WorktreeCreate, WorktreeRemove, TaskCompleted, SessionEnd, PreCompact, InstructionsLoaded) | Phase 1 had abstract `eventHooks` observability primitive but undercounted the surface | HookEventReceiver + 10 consumers |
| 2 | `credentialStorageProvider` (per-provider OAuth credential storage with platform-keychain abstraction) | Missing entirely; CredentialProvider treated as a one-off | CredentialProvider, SessionCredentialManager, AccountSwitcher |
| 3 | `usageMeterProvider` (per-provider quota/usage polling — Anthropic OAuth API today, OpenAI usage API tomorrow) | Phase 1 had `usageMeter` but only as observability concept, not provider-coupled to API endpoint | QuotaCollector, QuotaTracker, QuotaExhaustionDetector, QuotaManager, QuotaNotifier |
| 4 | `compactionLifecycle` (PreCompact hook → marker file → resume protocol) | Phase 1 didn't model context compaction at all | CompactionSentinel, SessionMigrator, stopGate, compactionResumePayload |
| 5 | `conversationLogProvider` (read & parse provider's session log format — JSONL today for Claude) | Phase 1 conflated this with `outputStream` (live) but logs are a separate post-hoc read | crash-detector, stall-detector, ActivityPartitioner, EpisodicMemory, jsonl-truncator |
| 6 | `interactivePromptObserver` (detect CLI's interactive prompts: confirmation, selection, plan-confirm) | Phase 1 missed the entire "agent CLI's terminal UI emits structured prompts we parse" category | PromptGate, InputClassifier, templates-drift-verifier |
| 7 | `mcpToolRegistry` (register Instar's MCP tools with provider's MCP host — `~/.claude.json` today) | Phase 1 referenced MCP under `toolAccess` but didn't model the *registration* side | ThreadlineBootstrap, ThreadlineMCPServer |
| 8 | `providerScaffolder` (install per-provider config: settings.json, hook scripts, skill dirs) | Phase 1 didn't model init-time scaffolding at all | init.ts, setup.ts, scaffold/templates.ts, data/http-hook-templates.ts |
| 9 | `stopGateInterceptor` (intercept provider's "I'm about to stop" signal, allow / block / continue) | Phase 1 named `interrupt` as control primitive but missed pre-stop intercept | UnjustifiedStopGate, server/stopGate.ts |
| 10 | `subagentLifecycleObserver` (track provider's sub-agent spawns: SubagentStart/SubagentStop) | Phase 1 didn't model sub-agents as a first-class concept | SubagentTracker, HelperWatchdog |
| 11 | `sessionResumeIndex` (provider-side index of resumable sessions — `~/.claude/projects/<path>/<uuid>.jsonl` today) | Phase 1 mentioned resume as open question but didn't carve a primitive | TopicResumeMap (in routes.ts), ThreadResumeMap, SessionLifecycle |
| 12 | `warmSessionInbox` (long-lived agent session with file-based message-injection inbox — distinct from tmux-send-keys and from `-p` one-shots) | Phase 1 named only three transport variants; this is a fourth | ListenerSessionManager, listener-daemon, WakeSocketServer |

### Refinements to existing Phase 1 primitives

- **`outputStream`** needs split into `liveOutputStream` (tmux capture-pane equivalent) and `archivedConversationLog` (the JSONL post-hoc reader — gap #5 above).
- **`eventHooks`** needs expansion into the explicit 10-event taxonomy (gap #1) plus subagent variant (gap #10).
- **`authCredentialInjection`** needs split: spawn-time injection (already in Phase 1) plus persistent storage/refresh (gap #2 — credentialStorageProvider).
- **`usageMeter`** observability primitive needs paired control primitive `usageMeterProvider` for API access (gap #3).
- **Transport layer** needs four entries instead of three: oneShot, structuredOneShot, agenticSession-headless, agenticSession-interactive-with-human, warmSessionInbox (was three: oneShot, agenticSession, interactiveSession).

---

## Convergence Status

**Coverage:** 441/441 files mapped (100%).
**Independent agents:** 4, scoped to disjoint slices, no double-counting.
**Sum check:** 167+129+81+64 = 441 ✓
**New primitive categories discovered:** 12 (above) — substantial expansion vs. Phase 1.
**Provider-agnostic files identified:** ~270 (61%) — confidence is high that these can be left alone in the port.

**Remaining convergence question:** This was one full pass. Justin's convergence definition is "iterate until no new territories found." Likely-final pass: re-run with the *updated* primitive list, asking each agent to verify every file's coupling category and flag any file whose coupling is still uncategorized. Expected to surface few-to-zero additional primitives but will catch any miscategorizations.

---

## Recommendation

Proceed to Phase 2 (interface design) with the **expanded primitive set** (Phase 1's 21 + 12 additions = 33 primitives, give or take consolidation). Run one more parallel verification pass *in parallel with* starting Phase 2 — the verification pass either confirms our coverage or finds rare edge cases, but it shouldn't block the interface design from starting.

If the verification pass surfaces a new primitive, fold it in before any adapter code lands (Phase 3).

---

## Methodology Notes

**Why four agents, not one:** Single-agent scans tend to skew toward the largest directory and underweight others. Partitioned scans force per-slice depth.

**Why disjoint slices, not overlapping:** Avoids triple-counting and keeps total cost proportional to source size.

**Why one synthesis pass before iterating:** Lets a human (or higher-level reasoning) judge whether new categories are real primitives or refinements of existing ones — agents alone tend to over-categorize.

**Verification pass design:** Hand each agent the *full* expanded primitive list and ask "for every file in your slice, which primitive (or set of primitives) does this file express, or is it provider-agnostic? Flag anything that doesn't fit."
