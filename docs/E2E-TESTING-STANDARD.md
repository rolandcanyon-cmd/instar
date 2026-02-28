# E2E Testing Standard for Instar Features

> Every feature must prove it's alive in production, not just correct in isolation.

## The Problem This Solves

We have a history of deploying features that work perfectly in unit and integration tests but are **dead on arrival** in production. The root cause is always the same: the feature is never wired into the actual server startup path (`server.ts` -> `AgentServer`).

**Example**: SemanticMemory had 78 passing tests (unit + integration) but was never initialized in `server.ts`. Every `/semantic/*` route returned 503 in production. The integration tests didn't catch this because they manually injected SemanticMemory into AgentServer — bypassing the production wiring entirely.

## The Three-Tier Testing Pyramid

Every significant Instar feature requires all three tiers:

### Tier 1: Unit Tests (`tests/unit/`)
- Test the module in isolation with **real dependencies** (real SQLite, real filesystem)
- No HTTP, no Express, no AgentServer
- Focus: Does the logic work correctly?

### Tier 2: Integration Tests (`tests/integration/`)
- Test the full HTTP pipeline: `HTTP request -> Express route -> Module -> Storage -> Response`
- Manually construct and inject dependencies into AgentServer
- Focus: Do the API routes work when the feature is available?

### Tier 3: E2E Lifecycle Tests (`tests/e2e/`)
- Test the **production initialization path**
- Initialize the feature **the same way `server.ts` does** — same config, same path resolution, same error handling
- Pass it to AgentServer the same way production does
- Focus: **Is the feature actually alive?** Does it return 200, not 503?

## E2E Test Template

Every E2E test must follow this structure:

```typescript
/**
 * E2E test — [FeatureName] full lifecycle.
 *
 * Tests the complete PRODUCTION path:
 *   1. Server starts with [Feature] initialized (same as server.ts does)
 *   2. [Feature] API routes return 200 (not 503 — the "dead on arrival" check)
 *   3. [Core operations work through the full HTTP pipeline]
 *   ...
 *
 * WHY THIS TEST EXISTS:
 * Integration tests mock the wiring — they create [Feature] manually
 * and inject it into AgentServer. That proves the routes work IF the
 * feature is wired up. But it doesn't catch the case where server.ts
 * never creates [Feature], making every route return 503 in production.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('[FeatureName] E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-e2e-feature';

  beforeAll(async () => {
    // Create temp directories matching production layout
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });

    // Write minimal config
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'e2e-test', agentName: 'E2E Test' }),
    );

    // ━━━ CRITICAL: Initialize the feature THE SAME WAY server.ts does ━━━
    // Copy the initialization block from server.ts — same config, same paths,
    // same error handling. If server.ts changes how it initializes, this test
    // should break.

    const config: InstarConfig = {
      projectName: 'e2e-test',
      agentName: 'E2E Test Agent',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
    };

    const mockSM = createMockSessionManager();
    const state = new StateManager(stateDir);

    // Seed test data...

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state,
      // featureInstance, <-- pass it the same way production does
    });

    app = server.getApp();
  });

  afterAll(() => {
    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  // ━━━ Phase 1: Feature is alive (THE MOST IMPORTANT TEST) ━━━
  describe('Phase 1: Feature is alive', () => {
    it('returns 200, not 503 — feature is wired into production', async () => {
      const res = await request(app)
        .get('/feature/health-endpoint')
        .set(auth());

      // This is THE test that catches "dead on arrival" bugs.
      // If this returns 503, the feature was never initialized in server.ts.
      expect(res.status).toBe(200);
    });
  });

  // Phase 2+: Test the feature's full lifecycle through the API...
});
```

## Phase 1 Is Non-Negotiable

The single most important test in any E2E file is:

```typescript
it('returns 200, not 503 — feature is wired into production', ...)
```

This one assertion catches the entire class of "dead on arrival" bugs. Everything else is gravy. If you write only one E2E test for a feature, make it this one.

## What "Same as server.ts" Means

The E2E test must mirror how `server.ts` initializes the feature:

| Aspect | Integration Test (Tier 2) | E2E Test (Tier 3) |
|--------|--------------------------|-------------------|
| Feature initialization | Manual, in test setup | Mirrors `server.ts` code |
| Config resolution | Test-specific paths | Same `path.join(stateDir, ...)` pattern |
| Error handling | May skip | Must include try/catch like production |
| Dependency injection | Direct constructor arg | Same way `new AgentServer({...})` receives it |

If `server.ts` changes its initialization pattern and the E2E test doesn't break, the E2E test is wrong.

## When to Write E2E Tests

Required for any feature that:
- Adds new API routes
- Requires initialization in `server.ts`
- Has a dependency that could fail to load (optional deps, native modules)
- Involves data persistence (databases, file I/O)

Not required for:
- Pure utility functions
- CLI-only commands that don't touch the server
- Documentation or config changes

## Reference Implementations

- `tests/e2e/semantic-memory-lifecycle.test.ts` — 25 tests, 11 phases. The gold standard.
- `tests/e2e/episodic-memory-lifecycle.test.ts` — 16 tests, 5 phases. Mirrors server.ts sentinel wiring with Telegram dual-source testing. Demonstrates mock branching on prompt preamble (not keywords).
- `tests/e2e/topic-memory-lifecycle.test.ts` — Topic memory lifecycle.
- `tests/e2e/lifecycle.test.ts` — Core server lifecycle.

## Running E2E Tests

```bash
# Run all E2E tests
npx vitest run tests/e2e/

# Run a specific E2E test
npx vitest run tests/e2e/semantic-memory-lifecycle.test.ts

# Run all tests (unit + integration + e2e)
npx vitest run
```

## Checklist for New Features

Before a feature is considered complete:

- [ ] Unit tests pass (Tier 1)
- [ ] Integration tests pass (Tier 2)
- [ ] E2E lifecycle test exists and passes (Tier 3)
- [ ] Phase 1 "feature is alive" test explicitly checks for 200 vs 503
- [ ] Feature initialization in E2E mirrors `server.ts` exactly
- [ ] Feature is actually wired into `server.ts` and `new AgentServer({...})`
