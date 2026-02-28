# Multi-Machine Verification Checklist

> All features requiring two actual machines for production verification. Automated tests cover logic, but these items require real cross-machine testing to confirm.

**Status**: ⬜ = Not tested, 🟡 = Partially tested, ✅ = Verified in production

---

## 1. Machine Pairing (`PairingProtocol`)

| # | Verification Item | How to Test | Status |
|---|-------------------|------------|--------|
| 1.1 | Pairing code generation and display on Machine A | Run `instar pair --initiate` on workstation | ⬜ |
| 1.2 | Pairing code entry on Machine B | Run `instar pair --join CODE` on MacBook | ⬜ |
| 1.3 | X25519 ECDH key exchange completes | Both machines show "Key exchange complete" | ⬜ |
| 1.4 | SAS verification (6 symbols match on both) | Compare SAS codes displayed on both screens | ⬜ |
| 1.5 | Encrypted secret transfer | Machine A's secrets appear on Machine B | ⬜ |
| 1.6 | Rate limiting (3 failed attempts blocks) | Enter wrong code 3 times → blocked | ⬜ |
| 1.7 | Expiry (2 minute timeout) | Wait >2 min after generating code → rejected | ⬜ |
| 1.8 | Machine registry updated on both | Both machines list each other in `machines/` | ⬜ |

---

## 2. Heartbeat & Failover (`HeartbeatManager`, `MultiMachineCoordinator`)

| # | Verification Item | How to Test | Status |
|---|-------------------|------------|--------|
| 2.1 | Awake machine writes heartbeat every 2 min | Check `heartbeat.json` updates on shared state | ⬜ |
| 2.2 | Standby machine reads heartbeat | MacBook (standby) shows "awake machine healthy" | ⬜ |
| 2.3 | Auto-failover after 15 min silence | Stop workstation → MacBook promotes after 15 min | ⬜ |
| 2.4 | Split-brain detection | Start both as awake → one should detect and demote | ⬜ |
| 2.5 | Failover cooldown (30 min between failovers) | Trigger failover → immediately stop again → no double failover | ⬜ |
| 2.6 | Max 3 failovers per 24 hours | Trigger 3 failovers → 4th is blocked | ⬜ |
| 2.7 | Graceful shutdown handoff | Stop workstation cleanly → MacBook sees handoff note | ⬜ |
| 2.8 | StateManager goes read-only on standby | Standby machine cannot write state files | ⬜ |
| 2.9 | Role change event emission | Both machines emit correct role change events | ⬜ |

---

## 3. Git Sync (`GitSync`)

| # | Verification Item | How to Test | Status |
|---|-------------------|------------|--------|
| 3.1 | Ed25519 commit signing | Commit on Machine A → verify signature on Machine B | ⬜ |
| 3.2 | Unsigned commit rejection | Create unsigned commit → Machine B rejects on pull | ⬜ |
| 3.3 | Revoked machine key rejection | Revoke Machine A's key → new commits rejected by B | ⬜ |
| 3.4 | Auto-commit + push on state change | Modify state file on A → appears on B after sync | ⬜ |
| 3.5 | Relationship field-level merge | Both machines update different fields on same relationship → merged | ⬜ |
| 3.6 | Conflict on same relationship field | Both machines update same field → last-write-wins or LLM resolve | ⬜ |
| 3.7 | Debounced commit timing | Rapid changes → single commit after debounce period | ⬜ |
| 3.8 | Pull with network interruption | Pull fails mid-transfer → clean recovery | ⬜ |

---

## 4. Work Ledger & Overlap Guard (`WorkLedger`, `OverlapGuard`)

| # | Verification Item | How to Test | Status |
|---|-------------------|------------|--------|
| 4.1 | Cross-machine ledger visibility | Machine A starts work → Machine B sees entry | ⬜ |
| 4.2 | Overlap detection across machines | Both machines claim same file → overlap alert | ⬜ |
| 4.3 | Overlap blocking (tier 2+) | Machine B blocked from starting conflicting task | ⬜ |
| 4.4 | Stale entry cleanup | Machine A crashes → Machine B detects stale entry | ⬜ |
| 4.5 | Ledger signature verification | Machine B verifies Machine A's signed ledger entries | ⬜ |

---

## 5. Branch Management (`BranchManager`)

| # | Verification Item | How to Test | Status |
|---|-------------------|------------|--------|
| 5.1 | Task branch creation visible to both | Machine A creates branch → Machine B sees it after fetch | ⬜ |
| 5.2 | Branch completion + merge on remote | Machine A completes branch → merged on remote for B | ⬜ |
| 5.3 | Branch name collision prevention | Both create task/xxx/same-slug → different branches | ⬜ |
| 5.4 | Orphaned branch detection | Machine A crashes mid-task → B detects orphaned branch | ⬜ |

---

## 6. Machine Handoff (`HandoffManager`)

| # | Verification Item | How to Test | Status |
|---|-------------------|------------|--------|
| 6.1 | Graceful handoff (clean transition) | Run `instar handoff` on workstation → MacBook resumes | ⬜ |
| 6.2 | WIP commit on handoff | Uncommitted changes → auto-committed before handoff | ⬜ |
| 6.3 | Handoff note content | MacBook reads handoff note with context + instructions | ⬜ |
| 6.4 | Crash recovery (ungraceful) | Kill workstation process → MacBook detects and resumes | ⬜ |
| 6.5 | Stale session resume (>48hr gap) | Wait 48+ hours → resume still works with warning | ⬜ |
| 6.6 | Ledger entries updated on handoff | Workstation's entries marked as handed off | ⬜ |

---

## 7. Agent Communication (`AgentBus`, `CoordinationProtocol`)

| # | Verification Item | How to Test | Status |
|---|-------------------|------------|--------|
| 7.1 | JSONL message delivery (git-based) | Machine A sends message → Machine B receives after sync | ⬜ |
| 7.2 | HTTP message delivery (real-time) | Machine A sends via HTTP → Machine B receives immediately | ⬜ |
| 7.3 | File avoidance request | Machine A requests avoidance of files → B honors it | ⬜ |
| 7.4 | Work announcement broadcast | Machine A announces task → B sees announcement | ⬜ |
| 7.5 | Leadership election | Both machines contend → only one wins | ⬜ |
| 7.6 | Leadership lease renewal | Leader renews before expiry → stays leader | ⬜ |
| 7.7 | Leadership failover on expiry | Leader stops renewing → challenger wins | ⬜ |
| 7.8 | Message TTL expiration | Old messages expire and aren't delivered | ⬜ |

---

## 8. Conflict Negotiation (`ConflictNegotiator`)

| # | Verification Item | How to Test | Status |
|---|-------------------|------------|--------|
| 8.1 | Pre-merge proposal exchange | Machine A proposes → Machine B sees proposal | ⬜ |
| 8.2 | Accept/reject flow | B accepts → A sees acceptance | ⬜ |
| 8.3 | Counter-proposal round | B counters → A receives counter-proposal | ⬜ |
| 8.4 | Multi-round negotiation | 3 rounds of counter-proposals → eventual agreement | ⬜ |
| 8.5 | Deadlock → LLM fallback | Both reject all → LLM resolves | ⬜ |
| 8.6 | Timeout handling | One machine goes silent → negotiation times out gracefully | ⬜ |

---

## 9. Security Pipeline (Cross-Machine)

| # | Verification Item | How to Test | Status |
|---|-------------------|------------|--------|
| 9.1 | Audit trail replication | Machine A's audit entries visible to Machine B | ⬜ |
| 9.2 | Cross-machine chain integrity | Combined audit chain from both machines verifies | ⬜ |
| 9.3 | RBAC enforcement across machines | Contributor on B can't override admin on A | ⬜ |
| 9.4 | Secret redaction before cross-machine LLM call | Conflict sent to LLM has no secrets from either machine | ⬜ |

---

## 10. SyncOrchestrator (Full Lifecycle)

| # | Verification Item | How to Test | Status |
|---|-------------------|------------|--------|
| 10.1 | Periodic sync between two machines | Both running periodic sync → state converges | ⬜ |
| 10.2 | Concurrent sync lock contention | Both sync at same time → one waits | ⬜ |
| 10.3 | Task completion with cross-machine merge | A completes task → B's main updated | ⬜ |
| 10.4 | Full cycle: edit → branch → overlap check → resolve → merge → sync | End-to-end workflow across two machines | ⬜ |
| 10.5 | Module degradation in production | Disable one module → orchestrator continues | ⬜ |

---

## Testing Protocol

### Prerequisites
1. Both machines paired (Section 1 complete)
2. Shared git remote configured (GitHub/private repo)
3. Instar running on both machines with multi-machine config
4. Network connectivity between machines (for HTTP transport)

### Execution Order
1. **Pairing** (Section 1) — Must be first
2. **Heartbeat** (Section 2) — Validates basic coordination
3. **Git Sync** (Section 3) — Validates state replication
4. **Ledger + Overlap** (Section 4) — Validates work tracking
5. **Branch** (Section 5) — Validates task isolation
6. **Handoff** (Section 6) — Validates machine transition
7. **Communication** (Section 7) — Validates real-time coordination
8. **Negotiation** (Section 8) — Validates conflict resolution
9. **Security** (Section 9) — Validates security pipeline
10. **Full Lifecycle** (Section 10) — Validates everything together

### Machines
- **Workstation**: MacBook Pro M4 Max (arm64, serial LGCXJLQXMN)
- **Dawn MacBook**: MacBook Pro 2017 (x86_64, serial C02VD05EHTDC)

### How to Mark Items
After testing each item:
1. Update status: ⬜ → ✅ (passed) or ❌ (failed)
2. Add date and any notes
3. If failed, create a GitHub issue with reproduction steps
4. Re-test after fix

---

**Total items**: 60 verification checks across 10 categories
**Automated coverage**: Logic tested via unit/integration/E2E tests
**This checklist**: Real cross-machine behavior requiring physical hardware

*Created 2026-02-28. Last updated: 2026-02-28.*
