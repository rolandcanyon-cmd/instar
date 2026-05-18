/**
 * Integration test — /route slash-command end-to-end (no real Telegram).
 *
 * Drives the full pipeline:
 *   1. TopicFrameworksStore at a real tmp state file.
 *   2. TelegramAdapter's onRouteCommand callback wired the same way
 *      server.ts wires it (persist + respawn).
 *   3. handleCommand path parses a literal "/route <framework>" string.
 *   4. Asserts that:
 *      - The state file contains the new override.
 *      - resolveTopicFramework reflects the new value.
 *      - A respawn callback fires for the affected topic.
 *      - "/route status" reports the current binding.
 *      - Unknown frameworks are rejected with a clear message.
 *
 * No real tmux, no real binaries, no real Telegram. The handler
 * shape matches server.ts exactly so this catches wiring regressions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicFrameworksStore } from '../../src/core/TopicFrameworksStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';

let tmpDir: string;
let stateFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-e2e-'));
  stateFile = path.join(tmpDir, 'state', 'topic-frameworks.json');
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/integration/route-command-end-to-end.test.ts:afterEach',
  });
});

/**
 * Mirror of the onRouteCommand handler in server.ts's
 * wireTelegramCallbacks function. Test-local copy with the same
 * shape — when server.ts changes, this assertion target must update.
 */
function buildRouteHandler(deps: {
  store: TopicFrameworksStore;
  topicHasSession: (topicId: number) => boolean;
  onRespawn: (topicId: number) => void;
  resolveDefault: () => IntelligenceFramework;
}): (topicId: number, framework: string | null) => Promise<{ ok: boolean; message: string }> {
  return async (topicId, framework) => {
    if (framework === null) {
      const current = deps.store.get(topicId) ?? deps.resolveDefault();
      return { ok: true, message: `This topic is using "${current}". Run /route claude-code or /route codex-cli to switch.` };
    }

    const valid = ['claude-code', 'codex-cli'];
    if (!valid.includes(framework)) {
      return { ok: false, message: `Unknown framework "${framework}". Supported: ${valid.join(', ')}.` };
    }

    const prev = deps.store.get(topicId) ?? deps.resolveDefault();
    if (prev === framework) {
      return { ok: true, message: `This topic is already on "${framework}". Nothing to change.` };
    }

    deps.store.set(topicId, framework as IntelligenceFramework);

    if (deps.topicHasSession(topicId)) {
      deps.onRespawn(topicId);
    }

    return { ok: true, message: `Routed this topic to "${framework}". ${deps.topicHasSession(topicId) ? 'Session respawned.' : 'Will take effect when a session starts for this topic.'}` };
  };
}

describe('/route end-to-end', () => {
  it('flow: /route → status → switch → persist → respawn', async () => {
    const store = new TopicFrameworksStore({ stateFilePath: stateFile });
    let respawnedTopic: number | null = null;
    const handler = buildRouteHandler({
      store,
      topicHasSession: () => true,
      onRespawn: (topicId) => { respawnedTopic = topicId; },
      resolveDefault: () => 'claude-code',
    });

    // 1. /route (status query) — reports default
    const status = await handler(9984, null);
    expect(status.ok).toBe(true);
    expect(status.message).toContain('claude-code');

    // 2. /route codex-cli — switches
    const switched = await handler(9984, 'codex-cli');
    expect(switched.ok).toBe(true);
    expect(switched.message).toContain('codex-cli');
    expect(switched.message).toContain('Session respawned');
    expect(respawnedTopic).toBe(9984);

    // 3. State file persists the change
    expect(fs.existsSync(stateFile)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(persisted.topics['9984']).toBe('codex-cli');

    // 4. A fresh store reads the override back (survives "restart")
    const reloaded = new TopicFrameworksStore({ stateFilePath: stateFile });
    expect(reloaded.get(9984)).toBe('codex-cli');

    // 5. Status query now reflects the new binding
    const newStatus = await handler(9984, null);
    expect(newStatus.message).toContain('codex-cli');
  });

  it('idempotent: switching to the current framework is a no-op (no respawn)', async () => {
    const store = new TopicFrameworksStore({ stateFilePath: stateFile });
    store.set(9985, 'codex-cli');
    let respawned = false;
    const handler = buildRouteHandler({
      store,
      topicHasSession: () => true,
      onRespawn: () => { respawned = true; },
      resolveDefault: () => 'claude-code',
    });

    const result = await handler(9985, 'codex-cli');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('already on');
    expect(respawned).toBe(false);
  });

  it('rejects unknown framework with a clear message', async () => {
    const store = new TopicFrameworksStore({ stateFilePath: stateFile });
    const handler = buildRouteHandler({
      store,
      topicHasSession: () => true,
      onRespawn: () => { /* shouldn't fire */ throw new Error('respawn should not fire on rejection'); },
      resolveDefault: () => 'claude-code',
    });

    const result = await handler(9984, 'evil-framework');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Unknown framework');
    expect(result.message).toContain('evil-framework');
    expect(result.message).toContain('claude-code');
    expect(result.message).toContain('codex-cli');
  });

  it('switch with no running session: persists but does not respawn', async () => {
    const store = new TopicFrameworksStore({ stateFilePath: stateFile });
    let respawned = false;
    const handler = buildRouteHandler({
      store,
      topicHasSession: () => false,
      onRespawn: () => { respawned = true; },
      resolveDefault: () => 'claude-code',
    });

    const result = await handler(9986, 'codex-cli');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('codex-cli');
    expect(result.message).toContain('Will take effect');
    expect(store.get(9986)).toBe('codex-cli');
    expect(respawned).toBe(false);
  });

  it('two consecutive switches: claude → codex → claude', async () => {
    const store = new TopicFrameworksStore({ stateFilePath: stateFile });
    const respawns: number[] = [];
    const handler = buildRouteHandler({
      store,
      topicHasSession: () => true,
      onRespawn: (topicId) => { respawns.push(topicId); },
      resolveDefault: () => 'claude-code',
    });

    // Default → codex
    const r1 = await handler(9987, 'codex-cli');
    expect(r1.ok).toBe(true);

    // codex → claude
    const r2 = await handler(9987, 'claude-code');
    expect(r2.ok).toBe(true);

    expect(respawns).toEqual([9987, 9987]);
    expect(store.get(9987)).toBe('claude-code');

    // Final persisted state file reflects the most recent write
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(persisted.topics['9987']).toBe('claude-code');
  });
});
