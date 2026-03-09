# Threadline Network Interop — Implementation Plan

> Strategy for taking Threadline from local-only to internet-capable with standard protocol support.
> Spec: [THREADLINE-NETWORK-INTEROP-SPEC.md](./specs/THREADLINE-NETWORK-INTEROP-SPEC.md) (v1.1.0-draft, post-review)

## Current State (Complete)

Threadline v1.0 is fully implemented and tested:
- 12 source modules in `src/threadline/`
- 446 tests (322 unit + 67 integration + 57 E2E), all passing
- Phases 1-5 complete: session coherence, autonomy gating, crypto handshake, discovery, trust & security
- Bound to localhost — agents on the same machine or paired machines only

## Strategy: MCP First, Then A2A

The business and marketing reviewers recommended leading with **distribution** before **infrastructure**. MCP tools give immediate reach to every Claude Code user and MCP-capable framework. A2A Gateway is the bigger lift but opens internet-wide interoperability.

```
Phase 6B (MCP)  →  Phase 6A (A2A)  →  Phase 6C (Trust Bootstrap)  →  Phase 6D (OpenClaw)
  3-5 days           2-3 weeks            1-2 weeks                    1 week (future)
```

## Phase 6B: MCP Tool Server (START HERE)

**Why first**: Smallest scope, instant distribution. Any Claude Code user can connect to Instar agents immediately.

**What we're building**:
- An MCP server that exposes Threadline as 5 tools
- `threadline_discover` — find agents on local machine or network
- `threadline_send` — send a message (with `timeoutSeconds` for reply wait)
- `threadline_history` — get conversation history (participant-only access)
- `threadline_agents` — list known agents and status
- `threadline_delete` — delete a thread permanently
- Transport: stdio (local, default) + SSE + HTTP streamable (network)
- Auth: Bearer tokens with scoped capabilities for network transports

**Files to create**:
- `src/threadline/ThreadlineMCPServer.ts` — MCP server implementation
- `src/threadline/MCPAuth.ts` — Token generation, validation, scoping
- `tests/unit/threadline/ThreadlineMCPServer.test.ts`
- `tests/integration/threadline/ThreadlineMCP.test.ts`

**Dependencies**: `@modelcontextprotocol/sdk`

**CLI**: `instar mcp-server start --threadline` and `instar mcp-server token create --scope <scope>`

**Done when**:
- [ ] All 5 MCP tools implemented and tested
- [ ] stdio transport works with Claude Code
- [ ] SSE transport works with bearer auth
- [ ] Thread history restricted to participants
- [ ] `threadline_agents` returns names + status only (not trust internals)
- [ ] Integration test: MCP client has multi-turn conversation via Threadline

**Estimated effort**: 3-5 days

---

## Phase 6A: A2A Gateway

**Why second**: Bigger scope, but opens internet-wide interoperability. Any A2A agent can discover and message Instar agents.

**What we're building**:
- A2A Gateway translating JSON-RPC ↔ Threadline messages
- Self-signed Agent Card at `/.well-known/agent-card.json`
- Identity-bound ContextThreadMap (contextId ↔ threadId, prevents session smuggling)
- Compute metering (per-agent budgets tied to trust level, global daily cap)
- Session lifecycle (active → parked → archived → evicted)
- Observability (Prometheus metrics, audit logging)
- A2A error responses (10 JSON-RPC error codes)
- Tunnel configuration (Cloudflare/ngrok)

**Files to create**:
- `src/threadline/A2AGateway.ts` — Translation layer
- `src/threadline/AgentCard.ts` — Card generation + self-signing
- `src/threadline/ContextThreadMap.ts` — Bidirectional map with persistence
- `src/threadline/ComputeMeter.ts` — Budget tracking
- `src/threadline/SessionLifecycle.ts` — State management
- `tests/unit/threadline/A2AGateway.test.ts`
- `tests/unit/threadline/AgentCard.test.ts`
- `tests/unit/threadline/ContextThreadMap.test.ts`
- `tests/unit/threadline/ComputeMeter.test.ts`
- `tests/unit/threadline/SessionLifecycle.test.ts`
- `tests/integration/threadline/A2AIntegration.test.ts`
- `tests/e2e/threadline/A2AE2E.test.ts`

**Dependencies**: `@a2a-js/sdk`

**Key design decisions (resolved during review)**:
- Each message exchange = one completing A2A task. contextId links tasks for session continuity.
- Autonomy-gated messages use A2A `input-required` state (not timeout)
- Nonce window: 2 minutes for network, persisted to disk
- CORS: explicit allowlist (no wildcards)
- Agent Card descriptions sanitized against prompt injection

**Done when**:
- [ ] Agent Card published and self-signed
- [ ] A2A `message/send` processes through Threadline and returns response
- [ ] Same contextId across multiple messages produces session-coherent responses
- [ ] Compute budgets enforced (untrusted agent hits limit, gets -32003)
- [ ] Session lifecycle works (idle sessions park automatically)
- [ ] Metrics endpoint returns Prometheus-format data
- [ ] Security: session smuggling blocked, rate limiting active, malformed requests rejected
- [ ] E2E: external A2A client has a multi-turn conversation via tunnel

**Estimated effort**: 2-3 weeks

---

## Phase 6C: Trust Bootstrap & Directory

**Why third**: Enables agents to find each other on the internet without manual configuration.

**What we're building**:
- Trust bootstrap strategies: directory-verified, domain-verified (DNS TXT), invitation-only, open
- Invitation token lifecycle (creation, validation, expiry, single-use, revocation)
- DNS TXT record verification
- Optional: simple directory service API

**Files to create**:
- `src/threadline/TrustBootstrap.ts`
- `src/threadline/InvitationManager.ts`
- `src/threadline/DNSVerifier.ts`
- Tests for each

**Done when**:
- [ ] All 4 bootstrap strategies implemented
- [ ] Invitation tokens work end-to-end (create → share → validate → consume)
- [ ] DNS TXT verification works for domain-based trust
- [ ] Default remains `invitation-only`
- [ ] Security: spoofing attempts rejected, expired tokens rejected

**Estimated effort**: 1-2 weeks

---

## Phase 6D: OpenClaw Skill (Future)

**Why last**: Largest single agent framework (282k stars), but requires Phases 6A-6C to be stable first.

**What we're building**:
- ClawHub skill package bridging OpenClaw's session model to Threadline
- Configuration in OpenClaw dashboard

**Estimated effort**: 1 week

---

## Review Score Trajectory

| Review | Score | Status |
|--------|-------|--------|
| Round 1 (internal, 8 reviewers) | 6.25/10 avg | NEEDS WORK |
| Round 1 (cross-model, GPT/Gemini/Grok) | 7.8/10 avg | CONDITIONAL |
| Round 1 revision | Addressed top 6 consensus issues + 7 bonus fixes | Pending re-review |

**Target for Round 2**: 7.5+ internal, 8.5+ cross-model. Run `/specreview --round 2` after Phase 6B implementation to validate.

---

## Key Principles (from spec)

1. **The agent is the interface** — users never see protocols. They talk to their agent.
2. **MCP first for distribution** — reach Claude Code users and MCP frameworks immediately
3. **A2A for interoperability** — speak the standard the ecosystem is converging on
4. **Session coherence is the differentiator** — "A2A lets agents talk. Threadline lets them remember."
5. **Security scales with exposure** — tighter controls as we move from localhost to internet
6. **Compute budgets from day one** — no open-ended API cost exposure

---

*Last updated: 2026-03-09*
