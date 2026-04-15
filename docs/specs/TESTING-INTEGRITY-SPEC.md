# Testing Integrity Spec

> Unit tests prove components work in isolation. Integrity tests prove they're correctly assembled.

## The Problem

StallTriageNurse shipped with 55 passing unit tests and was broken in production due to 5 compounding bugs:

1. **No intelligence provider wired** — The constructor never received one. Unit tests mocked it, so the gap was invisible.
2. **Verification too weak** — Any tmux output change counted as "recovered," including a mere newline echo from nudge.
3. **clearStallForTopic was a no-op** — The function body was empty. Tests mocked it and never checked side effects.
4. **No force-restart safety net** — When all escalation steps failed, the nurse gave up without trying the nuclear option.
5. **Heuristic fallback always defaulted to weakest action** — When LLM diagnosis failed, it always fell back to nudge regardless of context.

Root cause: every individual piece worked perfectly. The constructor accepted deps correctly, the diagnosis parser was accurate, the escalation logic was sound, the verification check ran. But the **wiring** — how these pieces connected in production — was never tested.

This is the assembly gap. Unit tests verify components. Integration tests verify routes and APIs. But neither category covers: "Does the thing that constructs everything pass the right things to each constructor?"

## Three Test Categories

### Category 1: Wiring Integrity Tests

**What they test:** The dependency graph itself. When server.ts constructs StallTriageNurse, does the instance actually receive a working intelligence provider? When it receives a `clearStallForTopic` function, does that function actually clear stalls?

**Pattern:**

```typescript
describe('StallTriageNurse wiring', () => {
  it('receives a functional intelligence provider', () => {
    // Reconstruct the wiring logic from server.ts
    // Priority: Claude CLI subscription (default, zero extra cost) → Anthropic API (explicit opt-in or last-resort fallback)
    const intelligence = new ClaudeCliIntelligenceProvider(claudePath)
      ?? AnthropicIntelligenceProvider.fromEnv();

    expect(intelligence).toBeDefined();
    expect(typeof intelligence.evaluate).toBe('function');
  });

  it('clearStallForTopic actually clears stalls', () => {
    const telegram = createTestTelegramAdapter();
    telegram.pendingMessages.set('key-1', { topicId: 42, ... });

    // This is the actual function that gets wired in server.ts
    const clearStallForTopic = (topicId: number) => telegram.clearStallTracking(topicId);

    clearStallForTopic(42);
    expect(telegram.pendingMessages.size).toBe(0);
  });
});
```

**The invariant:** For every dependency-injected function, test that:
1. It is not null/undefined when the feature is enabled
2. It is not a no-op (calling it produces observable side effects)
3. It delegates to the real implementation (not a stub left from development)

### Category 2: Semantic Correctness Tests

**What they test:** Decision boundaries. Not "does the function run?" but "does it make the right decision for this specific input?"

The StallTriageNurse verification was the canonical failure here. The test checked "output changed = recovered" without questioning what kinds of changes actually indicate recovery.

**Pattern:**

```typescript
describe('verification boundaries', () => {
  it('rejects newline-only changes', () => {
    // Before: "session output"
    // After:  "session output\n"
    const result = nurse.verifyAction('nudge', contextWithOutput('session output'));
    expect(result).toBe(false);
  });

  it('rejects prompt echo', () => {
    // Before: "session output"
    // After:  "session output\n❯"
    const result = nurse.verifyAction('nudge', contextWithOutput('session output'));
    expect(result).toBe(false);
  });

  it('accepts tool call activity', () => {
    // Before: "session output"
    // After:  "session output\nRead tool completed"
    const result = nurse.verifyAction('nudge', contextWithOutput('session output'));
    expect(result).toBe(true);
  });
});
```

**The invariant:** For every boolean decision in the system, test both sides of the boundary with realistic inputs that distinguish true positives from false positives.

### Category 3: E2E Lifecycle Tests

**What they test:** Full user-facing paths from trigger to completion. A user sends a message. The session stalls. The nurse detects, diagnoses, treats, verifies, and either recovers or notifies the user.

**Pattern:**

```typescript
describe('stall recovery lifecycle', () => {
  it('detects stall, diagnoses, recovers session, notifies user', async () => {
    // 1. Set up: TelegramAdapter + SessionManager + StallTriageNurse
    //    with real (controlled) deps
    // 2. Inject a message that will stall
    // 3. Advance time past stall threshold
    // 4. Verify: nurse triggered, diagnosis made, action taken
    // 5. Verify: user received status messages
    // 6. Verify: session recovered or user notified of failure
  });
});
```

**The invariant:** The full path from user action to user-visible outcome works end-to-end, with controlled (but real) intermediate components.

## How This Generalizes

Every dependency-injected feature in Instar follows the same pattern:

1. **Constructor receives deps** — Functions, managers, adapters passed in
2. **Server.ts wires them** — Creates instances and passes real implementations
3. **Feature uses deps at runtime** — Calls the functions during operation

The assembly gap exists at step 2. Unit tests cover step 3 with mocks. Integration tests cover the HTTP layer on top. But step 2 — "are the right things passed to the right constructors?" — is untested.

### Components That Need Wiring Tests

| Component | Critical Deps | What Could Go Wrong |
|-----------|--------------|-------------------|
| StallTriageNurse | intelligence, clearStallForTopic, respawnSession | No LLM, no-op clear, missing respawn |
| AutoDispatcher | DispatchManager, DispatchExecutor, StateManager | Executor without sessionManager |
| SessionWatchdog | SessionManager, StateManager, config | Missing tmux path, wrong thresholds |
| AgentServer | All components via options object | Null fields when feature is enabled |
| JobScheduler | SessionManager, StateManager | Can't spawn sessions, can't persist |
| SessionActivitySentinel | intelligence, getActiveSessions, captureSessionOutput, getTelegramMessages, getTopicForSession | No LLM for digests, null session capture, missing telegram wiring, sessionComplete event unwired |

### The Wiring Test Template

For any new dependency-injected component:

```typescript
describe('[Component] wiring integrity', () => {
  it('receives all required deps when feature is enabled', () => {
    // Reconstruct the wiring from server.ts
    // Verify no dep is null/undefined
  });

  it('each dep function produces side effects (not a no-op)', () => {
    // Call each injected function
    // Verify observable change (state mutation, function called, etc.)
  });

  it('deps delegate to real implementations', () => {
    // Verify the injected function calls through to the actual method
    // Not just "is it a function?" but "does it do the right thing?"
  });
});
```

## Implementation Checklist

- [x] `tests/integration/server-wiring.test.ts` — Wiring integrity for all DI components
- [ ] `tests/integration/stall-recovery-e2e.test.ts` — Full lifecycle from stall to recovery
- [ ] `tests/unit/semantic-verification.test.ts` — Verification boundary conditions
- [x] `tests/integration/episodic-wiring.test.ts` — Wiring integrity for SessionActivitySentinel (16 tests)
- [x] `tests/integration/episodic-memory-routes.test.ts` — Integration tests for episode API routes (17 tests)
- [x] `tests/e2e/episodic-memory-lifecycle.test.ts` — E2E lifecycle for episodic memory (16 tests)
- [ ] Add wiring tests for every new dependency-injected feature going forward
- [ ] CI enforcement: wiring tests run on every PR that touches server.ts or any constructor

## Mock Branching Pitfall

When mocking intelligence providers that return different responses based on prompt content, never branch on generic keywords that could appear in embedded data. Session output, Telegram messages, and other content gets embedded in prompts — a mock checking `prompt.includes('session synthesis')` will false-match when session output contains a test name like "round-trips a session synthesis."

**Rule:** Branch mock responses on the unique preamble of each prompt type, not on keywords:
```typescript
// BAD: Generic keywords can appear in embedded content
if (prompt.includes('session synthesis')) { ... }

// GOOD: Unique preamble only appears in the actual synthesis prompt
if (prompt.includes('creating a coherent session synthesis')) { ... }
```

## The Meta-Lesson

Unit tests answer: "Does this component work?"
Integration tests answer: "Do the routes work?"
Wiring tests answer: "Is this component actually connected to reality?"

The StallTriageNurse had 55 tests answering the first question. Zero answering the third. Five bugs shipped because of that gap.

The fix is not "write more unit tests." The fix is a different category of test that specifically targets the assembly layer — where constructors meet their dependencies.
