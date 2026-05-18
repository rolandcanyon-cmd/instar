/**
 * Unit tests — Codex Rule 1 (spec 12) credential validation.
 *
 * Phase A behavior (default for v1.0.0):
 *   - configFromEnv stops reading OPENAI_API_KEY
 *   - credentials.checkAndWarn emits structured warning + telemetry
 *     when API-key auth is detected (env var OR auth.json shape)
 *   - returns ok=true otherwise
 *
 * Phase B opt-in behavior (INSTAR_RULE1_ENFORCE=hard):
 *   - adapter init throws AuthError instead of just warning
 *
 * Escape hatch (INSTAR_DISABLE_RULE1_OPENAI=1):
 *   - suppresses warning until RULE1_KILLSWITCH_SUNSET_DATE
 *   - after sunset, escape hatch is ignored
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RULE1_KILLSWITCH_SUNSET_DATE,
  authFileIsApiKeyShape,
  checkAndWarn,
  isKillswitchExpired,
  resolveEnforcementMode,
  validateRule1,
} from '../../../../../src/providers/adapters/openai-codex/credentials.js';
import { configFromEnv } from '../../../../../src/providers/adapters/openai-codex/config.js';
import { SafeFsExecutor } from '../../../../../src/core/SafeFsExecutor.js';

describe('configFromEnv (Phase A) — stops reading OPENAI_API_KEY', () => {
  it('does not populate apiKey even when OPENAI_API_KEY is set', () => {
    const cfg = configFromEnv({ OPENAI_API_KEY: 'sk-test-12345' });
    expect(cfg.apiKey).toBeUndefined();
  });
  it('still resolves codexPath and other fields normally', () => {
    const cfg = configFromEnv({ CODEX_PATH: '/usr/bin/codex' });
    expect(cfg.codexPath).toBe('/usr/bin/codex');
  });
});

describe('validateRule1 — env detection', () => {
  it('returns ok=true when no API-key auth present', () => {
    const r = validateRule1({}, undefined, new Date('2026-06-01'));
    expect(r.ok).toBe(true);
  });
  it('flags OPENAI_API_KEY as security_violation', () => {
    const r = validateRule1({ OPENAI_API_KEY: 'sk-test' }, undefined, new Date('2026-06-01'));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CODEX_AUTH_APIKEY_DETECTED');
    expect(r.errorClass).toBe('security_violation');
    expect(r.source).toBe('env');
  });
});

describe('authFileIsApiKeyShape', () => {
  let tmpDir: string;
  let authPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rule1-'));
    authPath = path.join(tmpDir, 'auth.json');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/providers/adapters/openai-codex/credentialsRule1.test.ts' });
  });

  it('returns false when file does not exist', () => {
    expect(authFileIsApiKeyShape(authPath)).toBe(false);
  });
  it('returns false when file is OAuth-shape', () => {
    fs.writeFileSync(authPath, JSON.stringify({ access_token: 'oauth-xyz', refresh_token: 'r-xyz' }));
    expect(authFileIsApiKeyShape(authPath)).toBe(false);
  });
  it('returns true when file has api_key field with sk- prefix', () => {
    fs.writeFileSync(authPath, JSON.stringify({ api_key: 'sk-abc123' }));
    expect(authFileIsApiKeyShape(authPath)).toBe(true);
  });
  it('returns true for the camelCase apiKey variant', () => {
    fs.writeFileSync(authPath, JSON.stringify({ apiKey: 'sk-abc' }));
    expect(authFileIsApiKeyShape(authPath)).toBe(true);
  });
  it('returns false for malformed JSON (caller surfaces FILE_MALFORMED separately)', () => {
    fs.writeFileSync(authPath, '{ not valid json');
    expect(authFileIsApiKeyShape(authPath)).toBe(false);
  });
});

describe('validateRule1 — auth file detection', () => {
  let tmpDir: string;
  let authPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rule1-af-'));
    authPath = path.join(tmpDir, 'auth.json');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/providers/adapters/openai-codex/credentialsRule1.test.ts:authfile' });
  });

  it('flags api-key-shape auth.json as security_violation', () => {
    fs.writeFileSync(authPath, JSON.stringify({ api_key: 'sk-bad' }));
    const r = validateRule1({}, authPath, new Date('2026-06-01'));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CODEX_AUTH_APIKEY_DETECTED');
    expect(r.source).toBe('auth-file');
  });
  it('passes for OAuth-shape auth.json', () => {
    fs.writeFileSync(authPath, JSON.stringify({ access_token: 'oauth' }));
    const r = validateRule1({}, authPath, new Date('2026-06-01'));
    expect(r.ok).toBe(true);
  });
});

describe('resolveEnforcementMode', () => {
  it('defaults to warn for v1.0.0 Phase A', () => {
    expect(resolveEnforcementMode({}, new Date('2026-06-01'))).toBe('warn');
  });
  it('honors INSTAR_RULE1_ENFORCE=hard', () => {
    expect(resolveEnforcementMode({ INSTAR_RULE1_ENFORCE: 'hard' }, new Date('2026-06-01'))).toBe('hard');
  });
  it('honors INSTAR_DISABLE_RULE1_OPENAI=1 before sunset', () => {
    expect(resolveEnforcementMode({ INSTAR_DISABLE_RULE1_OPENAI: '1' }, new Date('2026-06-01'))).toBe('disabled');
  });
  it('ignores INSTAR_DISABLE_RULE1_OPENAI after sunset', () => {
    // Sunset is 2026-12-01; after that the disable env is ignored
    expect(resolveEnforcementMode({ INSTAR_DISABLE_RULE1_OPENAI: '1' }, new Date('2027-01-01'))).toBe('warn');
  });
});

describe('isKillswitchExpired', () => {
  it('returns false before sunset', () => {
    expect(isKillswitchExpired(new Date('2026-06-01'))).toBe(false);
  });
  it('returns true on/after sunset', () => {
    expect(isKillswitchExpired(new Date(RULE1_KILLSWITCH_SUNSET_DATE))).toBe(true);
    expect(isKillswitchExpired(new Date('2027-06-01'))).toBe(true);
  });
});

describe('validateRule1 — killswitch sunset', () => {
  it('refuses INSTAR_DISABLE_RULE1_OPENAI escape hatch after sunset', () => {
    const r = validateRule1(
      { INSTAR_DISABLE_RULE1_OPENAI: '1' },
      undefined,
      new Date('2027-06-01'),
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CODEX_KILLSWITCH_EXPIRED');
    expect(r.source).toBe('killswitch');
  });
  it('honors escape hatch before sunset (escape hatch fires before env check)', () => {
    // When escape hatch is set BEFORE sunset, validateRule1 falls through
    // to env/auth-file checks — so if env also has OPENAI_API_KEY it
    // still trips. That's the right behavior: the escape hatch tells
    // checkAndWarn to skip the warning, not the validator to lie.
    const r = validateRule1(
      { INSTAR_DISABLE_RULE1_OPENAI: '1', OPENAI_API_KEY: 'sk-x' },
      undefined,
      new Date('2026-06-01'),
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CODEX_AUTH_APIKEY_DETECTED');
  });
});

describe('checkAndWarn — Phase A warning behavior', () => {
  it('warns and returns the result when API-key detected in warn mode', () => {
    const logs: string[] = [];
    const result = checkAndWarn({
      env: { OPENAI_API_KEY: 'sk-x' },
      now: new Date('2026-06-01'),
      logger: (m) => logs.push(m),
    });
    expect(result.ok).toBe(false);
    expect(logs.some(l => l.includes('Rule 1 violation'))).toBe(true);
    expect(logs.some(l => l.includes('CODEX_AUTH_APIKEY_DETECTED'))).toBe(true);
  });

  it('suppresses warning when escape hatch active (and pre-sunset)', () => {
    const logs: string[] = [];
    const result = checkAndWarn({
      env: { OPENAI_API_KEY: 'sk-x', INSTAR_DISABLE_RULE1_OPENAI: '1' },
      now: new Date('2026-06-01'),
      logger: (m) => logs.push(m),
    });
    expect(result.ok).toBe(true);
    expect(logs.some(l => l.includes('escape hatch'))).toBe(true);
    expect(logs.some(l => l.includes('sunsets'))).toBe(true);
  });

  it('returns ok=true silently when no violation present', () => {
    const logs: string[] = [];
    const result = checkAndWarn({
      env: {},
      now: new Date('2026-06-01'),
      logger: (m) => logs.push(m),
    });
    expect(result.ok).toBe(true);
    expect(logs).toEqual([]);
  });

  it('writes a telemetry line to security.jsonl when stateDir is provided', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rule1-tel-'));
    try {
      checkAndWarn({
        env: { OPENAI_API_KEY: 'sk-x' },
        stateDir: tmp,
        now: new Date('2026-06-01'),
        logger: () => {},
      });
      const log = fs.readFileSync(path.join(tmp, 'security.jsonl'), 'utf-8');
      expect(log).toContain('codex.rule1.violation');
      expect(log).toContain('CODEX_AUTH_APIKEY_DETECTED');
    } finally {
      SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/providers/adapters/openai-codex/credentialsRule1.test.ts:telemetry' });
    }
  });
});
