// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir.
/**
 * Unit tests for TopicLocalModelStore — per-topic Codex local-model
 * binding persisted as runtime state. Tests cover overrides-win-over-
 * defaults, persistence shape, validation on load, and the snapshot/
 * clear lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicLocalModelStore } from '../../src/core/TopicLocalModelStore.js';

describe('TopicLocalModelStore', () => {
  let tmp: string;
  let stateFile: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-local-model-'));
    stateFile = path.join(tmp, 'state', 'topic-local-models.json');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when no override or default exists', () => {
    const store = new TopicLocalModelStore({ stateFilePath: stateFile });
    expect(store.get(123)).toBeNull();
  });

  it('returns config default when override absent', () => {
    const store = new TopicLocalModelStore({
      stateFilePath: stateFile,
      configDefaults: { '99': { provider: 'ollama', model: 'llama3.2:latest' } },
    });
    expect(store.get(99)).toEqual({ provider: 'ollama', model: 'llama3.2:latest' });
  });

  it('overrides win over config defaults', () => {
    const store = new TopicLocalModelStore({
      stateFilePath: stateFile,
      configDefaults: { '99': { provider: 'ollama', model: 'llama3.2:latest' } },
    });
    store.set(99, { provider: 'lmstudio', model: 'mistral:latest' });
    expect(store.get(99)).toEqual({ provider: 'lmstudio', model: 'mistral:latest' });
  });

  it('persists writes to disk atomically', () => {
    const store = new TopicLocalModelStore({ stateFilePath: stateFile });
    store.set(7, { provider: 'ollama', model: 'qwen2.5-coder:7b' });
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(raw.topics['7']).toEqual({ provider: 'ollama', model: 'qwen2.5-coder:7b' });
    expect(typeof raw.updatedAt).toBe('string');
  });

  it('hydrates from disk on construction', () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      updatedAt: '2026-05-18T00:00:00Z',
      topics: { '42': { provider: 'ollama' } },
    }));
    const store = new TopicLocalModelStore({ stateFilePath: stateFile });
    expect(store.get(42)).toEqual({ provider: 'ollama' });
  });

  it('drops unknown providers when loading from disk (defensive)', () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      topics: {
        '1': { provider: 'ollama' },
        '2': { provider: 'malformed-backend' },
        '3': { provider: 'lmstudio', model: 'mistral' },
      },
    }));
    const store = new TopicLocalModelStore({ stateFilePath: stateFile });
    expect(store.get(1)).toEqual({ provider: 'ollama' });
    expect(store.get(2)).toBeNull();
    expect(store.get(3)).toEqual({ provider: 'lmstudio', model: 'mistral' });
  });

  it('clear() removes the override and falls back to config default', () => {
    const store = new TopicLocalModelStore({
      stateFilePath: stateFile,
      configDefaults: { '5': { provider: 'ollama' } },
    });
    store.set(5, { provider: 'lmstudio' });
    expect(store.get(5)?.provider).toBe('lmstudio');
    const cleared = store.clear(5);
    expect(cleared).toBe(true);
    expect(store.get(5)?.provider).toBe('ollama'); // config default
  });

  it('clear() returns false when the topic had no override', () => {
    const store = new TopicLocalModelStore({ stateFilePath: stateFile });
    expect(store.clear(99)).toBe(false);
  });

  it('snapshot includes both config defaults and overrides', () => {
    const store = new TopicLocalModelStore({
      stateFilePath: stateFile,
      configDefaults: { '1': { provider: 'ollama' } },
    });
    store.set(2, { provider: 'lmstudio', model: 'mistral' });
    expect(store.snapshot()).toEqual({
      '1': { provider: 'ollama' },
      '2': { provider: 'lmstudio', model: 'mistral' },
    });
  });

  it('does not crash on corrupt state file (logs warning, starts empty)', () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, '{ not valid json');
    const store = new TopicLocalModelStore({ stateFilePath: stateFile });
    expect(store.get(1)).toBeNull();
  });
});
