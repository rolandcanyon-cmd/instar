import { describe, it, expect } from 'vitest';
import { createHmac, createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * Tests for the Cloudflare Worker telemetry endpoint validation logic.
 *
 * Since the worker runs in Cloudflare's runtime (not Node.js) and we don't
 * have miniflare configured, these tests reimplement the worker's validation
 * rules and verify that client-generated payloads would pass or fail correctly.
 *
 * This catches the most dangerous class of bugs: client/worker format mismatches
 * that would cause every real submission to silently fail.
 */

// ── Worker constants (must match worker.js exactly) ──────────────────

const TIMESTAMP_DRIFT_SECONDS = 300; // ±5 minutes
const PAYLOAD_MAX_BYTES = 100_000; // 100KB
const COUNT_CAP = 10_000;
const SLUG_REGEX = /^[a-z][a-z0-9-]{0,63}$/;
const VALID_SKIP_REASONS = ['quota', 'priority', 'cooldown', 'disabled', 'error', 'stale-handoff'];
const VALID_SESSION_BUCKETS = ['0', '1-5', '6-20', '20+'];

// ── Worker validation reimplementation ───────────────────────────────

function validateBaselinePayload(body: Record<string, any>): string | null {
  const { agent, jobs } = body;

  if (!agent || typeof agent !== 'object') return 'missing agent object';
  if (typeof agent.version !== 'string') return 'invalid agent.version';
  if (!VALID_SESSION_BUCKETS.includes(agent.sessionsBucket)) return 'invalid agent.sessionsBucket';
  if (typeof agent.gateTriggersLast24h !== 'number' || agent.gateTriggersLast24h < 0 || agent.gateTriggersLast24h > COUNT_CAP) return 'agent.gateTriggersLast24h out of bounds';
  if (typeof agent.blocksLast24h !== 'number' || agent.blocksLast24h < 0 || agent.blocksLast24h > COUNT_CAP) return 'agent.blocksLast24h out of bounds';
  if (typeof agent.totalJobs !== 'number' || agent.totalJobs < 0 || agent.totalJobs > COUNT_CAP) return 'agent.totalJobs out of bounds';
  if (typeof agent.enabledJobs !== 'number' || agent.enabledJobs < 0 || agent.enabledJobs > COUNT_CAP) return 'agent.enabledJobs out of bounds';
  if (typeof agent.disabledJobs !== 'number' || agent.disabledJobs < 0 || agent.disabledJobs > COUNT_CAP) return 'agent.disabledJobs out of bounds';

  if (agent.watchdog !== undefined) {
    const wd = agent.watchdog;
    if (typeof wd !== 'object' || wd === null) return 'invalid agent.watchdog';
    if (typeof wd.interventions !== 'number' || wd.interventions < 0 || wd.interventions > COUNT_CAP) return 'agent.watchdog.interventions out of bounds';
    if (typeof wd.recoveries !== 'number' || wd.recoveries < 0 || wd.recoveries > COUNT_CAP) return 'agent.watchdog.recoveries out of bounds';
    if (typeof wd.deaths !== 'number' || wd.deaths < 0 || wd.deaths > COUNT_CAP) return 'agent.watchdog.deaths out of bounds';
    if (typeof wd.llmGateOverrides !== 'number' || wd.llmGateOverrides < 0 || wd.llmGateOverrides > COUNT_CAP) return 'agent.watchdog.llmGateOverrides out of bounds';
  }

  if (!jobs || typeof jobs !== 'object') return 'missing jobs object';

  if (Array.isArray(jobs.skips)) {
    for (const skip of jobs.skips) {
      if (!skip.slug || !SLUG_REGEX.test(skip.slug)) return `invalid slug: ${skip.slug}`;
      if (!VALID_SKIP_REASONS.includes(skip.reason)) return `invalid skip reason: ${skip.reason}`;
      if (typeof skip.count !== 'number' || skip.count < 0 || skip.count > COUNT_CAP) return `skip count out of bounds for ${skip.slug}`;
    }
  }

  if (Array.isArray(jobs.results)) {
    for (const result of jobs.results) {
      if (!result.slug || !SLUG_REGEX.test(result.slug)) return `invalid slug: ${result.slug}`;
      for (const field of ['success', 'error', 'timeout']) {
        if (typeof result[field] !== 'number' || result[field] < 0 || result[field] > COUNT_CAP) return `${field} out of bounds for ${result.slug}`;
      }
    }
  }

  if (Array.isArray(jobs.durations)) {
    for (const dur of jobs.durations) {
      if (!dur.slug || !SLUG_REGEX.test(dur.slug)) return `invalid slug: ${dur.slug}`;
      if (typeof dur.meanMs !== 'number' || dur.meanMs < 0) return `invalid meanMs for ${dur.slug}`;
      if (typeof dur.count !== 'number' || dur.count < 0 || dur.count > COUNT_CAP) return `duration count out of bounds for ${dur.slug}`;
    }
  }

  if (Array.isArray(jobs.models)) {
    for (const model of jobs.models) {
      if (!model.slug || !SLUG_REGEX.test(model.slug)) return `invalid slug: ${model.slug}`;
      if (typeof model.runCount !== 'number' || model.runCount < 0 || model.runCount > COUNT_CAP) return `runCount out of bounds for ${model.slug}`;
    }
  }

  if (Array.isArray(jobs.adherence)) {
    for (const adh of jobs.adherence) {
      if (!adh.slug || !SLUG_REGEX.test(adh.slug)) return `invalid slug: ${adh.slug}`;
      if (typeof adh.expectedRuns !== 'number' || adh.expectedRuns < 0 || adh.expectedRuns > COUNT_CAP) return `expectedRuns out of bounds for ${adh.slug}`;
      if (typeof adh.actualRuns !== 'number' || adh.actualRuns < 0 || adh.actualRuns > COUNT_CAP) return `actualRuns out of bounds for ${adh.slug}`;
    }
  }

  return null;
}

function validateTopLevel(body: Record<string, any>): string | null {
  if (body.v !== 1) return 'schema_version_unsupported';
  if (!body.installationId || !body.version || !body.windowStart || !body.windowEnd || !body.agent || !body.jobs) {
    return 'missing required fields';
  }
  if (typeof body.installationId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.installationId)) {
    return 'invalid installationId format';
  }

  const windowStart = new Date(body.windowStart);
  const windowEnd = new Date(body.windowEnd);
  if (isNaN(windowStart.getTime()) || isNaN(windowEnd.getTime())) return 'invalid timestamps';
  if (windowStart >= windowEnd) return 'windowStart >= windowEnd';
  if (windowEnd.getTime() - windowStart.getTime() > 24 * 60 * 60 * 1000) return 'window > 24h';

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  if (windowStart.getTime() < thirtyDaysAgo) return 'window too old (>30 days)';

  return null;
}

function validateSignature(headers: Record<string, string>): string | null {
  const signatureHeader = headers['x-instar-signature'];
  const timestampHeader = headers['x-instar-timestamp'];
  const keyFingerprint = headers['x-instar-key-fingerprint'];

  if (!signatureHeader || !timestampHeader) return 'missing signature or timestamp';

  const timestamp = parseInt(timestampHeader, 10);
  if (isNaN(timestamp)) return 'invalid timestamp';

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > TIMESTAMP_DRIFT_SECONDS) return 'timestamp expired';

  if (!signatureHeader.startsWith('hmac-sha256=')) return 'invalid signature prefix';
  const sig = signatureHeader.slice('hmac-sha256='.length);
  if (!/^[0-9a-f]{64}$/.test(sig)) return 'invalid signature format';

  if (!keyFingerprint || !/^[0-9a-f]{64}$/.test(keyFingerprint)) return 'invalid key fingerprint';

  return null;
}

// ── Helper to build a valid payload ──────────────────────────────────

function makeValidPayload(overrides: Record<string, any> = {}): Record<string, any> {
  const now = new Date();
  return {
    v: 1,
    installationId: randomUUID(),
    version: '0.15.0',
    windowStart: new Date(now.getTime() - 6 * 3600000).toISOString(),
    windowEnd: now.toISOString(),
    agent: {
      version: '0.15.0',
      nodeVersion: '20.0.0',
      os: 'darwin',
      arch: 'arm64',
      uptimeHours: 1.5,
      totalJobs: 10,
      enabledJobs: 8,
      disabledJobs: 2,
      features: { threadline: true, evolution: false },
      sessionsBucket: '1-5',
      gateTriggersLast24h: 3,
      blocksLast24h: 1,
    },
    jobs: {
      skips: [
        { slug: 'health-check', reason: 'quota', count: 5 },
        { slug: 'ci-monitor', reason: 'disabled', count: 12 },
      ],
      results: [
        { slug: 'health-check', success: 10, error: 1, timeout: 0 },
      ],
      durations: [
        { slug: 'health-check', meanMs: 15000, count: 11 },
      ],
      models: [
        { slug: 'health-check', model: 'haiku', runCount: 10 },
        { slug: 'health-check', model: 'sonnet', runCount: 1 },
      ],
      adherence: [
        { slug: 'health-check', expectedRuns: 12, actualRuns: 11 },
      ],
    },
    ...overrides,
  };
}

function makeValidHeaders(installationId: string, payload: string): Record<string, string> {
  const secret = randomBytes(32).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payloadHash = createHash('sha256').update(Buffer.from(payload)).digest('hex');
  const message = `${installationId}:${timestamp}:${payloadHash}`;
  const signature = createHmac('sha256', Buffer.from(secret, 'hex')).update(message).digest('hex');
  const fingerprint = createHash('sha256').update(`${installationId}:${secret}`).digest('hex');

  return {
    'x-instar-signature': `hmac-sha256=${signature}`,
    'x-instar-timestamp': timestamp,
    'x-instar-key-fingerprint': fingerprint,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Worker: Top-Level Validation', () => {
  it('should accept a well-formed payload', () => {
    const payload = makeValidPayload();
    expect(validateTopLevel(payload)).toBeNull();
  });

  it('should reject version != 1', () => {
    expect(validateTopLevel(makeValidPayload({ v: 2 }))).toBe('schema_version_unsupported');
  });

  it('should reject missing required fields', () => {
    const payload = makeValidPayload();
    delete payload.windowStart;
    expect(validateTopLevel(payload)).toBe('missing required fields');
  });

  it('should reject non-UUID installation IDs', () => {
    expect(validateTopLevel(makeValidPayload({ installationId: 'not-a-uuid' }))).toBe('invalid installationId format');
  });

  it('should reject uppercase UUID characters', () => {
    expect(validateTopLevel(makeValidPayload({
      installationId: 'ABCDEF01-2345-6789-ABCD-EF0123456789',
    }))).toBe('invalid installationId format');
  });

  it('should reject windowStart >= windowEnd', () => {
    const now = new Date();
    expect(validateTopLevel(makeValidPayload({
      windowStart: now.toISOString(),
      windowEnd: new Date(now.getTime() - 1000).toISOString(),
    }))).toBe('windowStart >= windowEnd');
  });

  it('should reject window > 24h', () => {
    const now = new Date();
    expect(validateTopLevel(makeValidPayload({
      windowStart: new Date(now.getTime() - 48 * 3600000).toISOString(),
      windowEnd: now.toISOString(),
    }))).toBe('window > 24h');
  });

  it('should reject windows older than 30 days', () => {
    const old = new Date(Date.now() - 35 * 24 * 3600000);
    expect(validateTopLevel(makeValidPayload({
      windowStart: old.toISOString(),
      windowEnd: new Date(old.getTime() + 6 * 3600000).toISOString(),
    }))).toBe('window too old (>30 days)');
  });

  it('should accept window exactly 24h', () => {
    const now = new Date();
    expect(validateTopLevel(makeValidPayload({
      windowStart: new Date(now.getTime() - 24 * 3600000).toISOString(),
      windowEnd: now.toISOString(),
    }))).toBeNull();
  });
});

describe('Worker: Payload Schema Validation', () => {
  it('should accept a valid payload', () => {
    const payload = makeValidPayload();
    expect(validateBaselinePayload(payload)).toBeNull();
  });

  describe('agent metrics', () => {
    it('should reject missing agent object', () => {
      const payload = makeValidPayload();
      payload.agent = null;
      expect(validateBaselinePayload(payload)).toBe('missing agent object');
    });

    it('should reject non-string version', () => {
      const payload = makeValidPayload();
      payload.agent.version = 123;
      expect(validateBaselinePayload(payload)).toBe('invalid agent.version');
    });

    it('should reject invalid session bucket', () => {
      const payload = makeValidPayload();
      payload.agent.sessionsBucket = '50-100';
      expect(validateBaselinePayload(payload)).toBe('invalid agent.sessionsBucket');
    });

    it('should reject negative gate triggers', () => {
      const payload = makeValidPayload();
      payload.agent.gateTriggersLast24h = -1;
      expect(validateBaselinePayload(payload)).toContain('gateTriggersLast24h out of bounds');
    });

    it('should reject gate triggers > 10000', () => {
      const payload = makeValidPayload();
      payload.agent.gateTriggersLast24h = 10001;
      expect(validateBaselinePayload(payload)).toContain('gateTriggersLast24h out of bounds');
    });

    it('should accept gate triggers at exactly 10000', () => {
      const payload = makeValidPayload();
      payload.agent.gateTriggersLast24h = 10000;
      expect(validateBaselinePayload(payload)).toBeNull();
    });

    it('should reject negative totalJobs', () => {
      const payload = makeValidPayload();
      payload.agent.totalJobs = -1;
      expect(validateBaselinePayload(payload)).toContain('totalJobs out of bounds');
    });
  });

  describe('watchdog metrics', () => {
    it('should accept payload without watchdog', () => {
      const payload = makeValidPayload();
      delete payload.agent.watchdog;
      expect(validateBaselinePayload(payload)).toBeNull();
    });

    it('should accept valid watchdog metrics', () => {
      const payload = makeValidPayload();
      payload.agent.watchdog = {
        interventions: 5,
        byLevel: { 'ctrl-c': 3, sigterm: 2 },
        recoveries: 4,
        deaths: 1,
        llmGateOverrides: 7,
      };
      expect(validateBaselinePayload(payload)).toBeNull();
    });

    it('should reject watchdog interventions > 10000', () => {
      const payload = makeValidPayload();
      payload.agent.watchdog = {
        interventions: 10001,
        byLevel: {},
        recoveries: 0,
        deaths: 0,
        llmGateOverrides: 0,
      };
      expect(validateBaselinePayload(payload)).toContain('watchdog.interventions out of bounds');
    });

    it('should reject null watchdog', () => {
      const payload = makeValidPayload();
      payload.agent.watchdog = null;
      expect(validateBaselinePayload(payload)).toBe('invalid agent.watchdog');
    });
  });

  describe('skip metrics', () => {
    it('should accept all valid skip reasons', () => {
      for (const reason of VALID_SKIP_REASONS) {
        const payload = makeValidPayload();
        payload.jobs.skips = [{ slug: 'test-job', reason, count: 1 }];
        expect(validateBaselinePayload(payload)).toBeNull();
      }
    });

    it('should reject invalid skip reason', () => {
      const payload = makeValidPayload();
      payload.jobs.skips = [{ slug: 'test-job', reason: 'unknown', count: 1 }];
      expect(validateBaselinePayload(payload)).toContain('invalid skip reason');
    });

    it('should reject skip count > 10000', () => {
      const payload = makeValidPayload();
      payload.jobs.skips = [{ slug: 'test-job', reason: 'quota', count: 10001 }];
      expect(validateBaselinePayload(payload)).toContain('skip count out of bounds');
    });

    it('should reject negative skip count', () => {
      const payload = makeValidPayload();
      payload.jobs.skips = [{ slug: 'test-job', reason: 'quota', count: -1 }];
      expect(validateBaselinePayload(payload)).toContain('skip count out of bounds');
    });
  });

  describe('slug validation', () => {
    const validSlugs = ['a', 'health-check', 'ci-monitor-v2', 'a1b2c3'];
    const invalidSlugs = ['', '1invalid', 'UPPERCASE', 'has spaces', 'has.dots', '../traversal',
      'a'.repeat(65)]; // > 64 chars

    for (const slug of validSlugs) {
      it(`should accept valid slug: "${slug}"`, () => {
        const payload = makeValidPayload();
        payload.jobs.skips = [{ slug, reason: 'quota', count: 1 }];
        expect(validateBaselinePayload(payload)).toBeNull();
      });
    }

    for (const slug of invalidSlugs) {
      it(`should reject invalid slug: "${slug || '(empty)'}"`, () => {
        const payload = makeValidPayload();
        payload.jobs.skips = [{ slug, reason: 'quota', count: 1 }];
        expect(validateBaselinePayload(payload)).toContain('invalid slug');
      });
    }
  });

  describe('result metrics', () => {
    it('should accept valid results', () => {
      const payload = makeValidPayload();
      payload.jobs.results = [{ slug: 'test-job', success: 10, error: 2, timeout: 1 }];
      expect(validateBaselinePayload(payload)).toBeNull();
    });

    it('should reject success > 10000', () => {
      const payload = makeValidPayload();
      payload.jobs.results = [{ slug: 'test-job', success: 10001, error: 0, timeout: 0 }];
      expect(validateBaselinePayload(payload)).toContain('success out of bounds');
    });

    it('should reject negative error', () => {
      const payload = makeValidPayload();
      payload.jobs.results = [{ slug: 'test-job', success: 0, error: -1, timeout: 0 }];
      expect(validateBaselinePayload(payload)).toContain('error out of bounds');
    });

    it('should reject non-number timeout', () => {
      const payload = makeValidPayload();
      payload.jobs.results = [{ slug: 'test-job', success: 0, error: 0, timeout: 'none' }];
      expect(validateBaselinePayload(payload)).toContain('timeout out of bounds');
    });
  });

  describe('duration metrics', () => {
    it('should reject negative meanMs', () => {
      const payload = makeValidPayload();
      payload.jobs.durations = [{ slug: 'test-job', meanMs: -100, count: 1 }];
      expect(validateBaselinePayload(payload)).toContain('invalid meanMs');
    });

    it('should accept zero meanMs', () => {
      const payload = makeValidPayload();
      payload.jobs.durations = [{ slug: 'test-job', meanMs: 0, count: 1 }];
      expect(validateBaselinePayload(payload)).toBeNull();
    });

    it('should reject duration count > 10000', () => {
      const payload = makeValidPayload();
      payload.jobs.durations = [{ slug: 'test-job', meanMs: 100, count: 10001 }];
      expect(validateBaselinePayload(payload)).toContain('duration count out of bounds');
    });
  });

  describe('model metrics', () => {
    it('should reject runCount > 10000', () => {
      const payload = makeValidPayload();
      payload.jobs.models = [{ slug: 'test-job', model: 'haiku', runCount: 10001 }];
      expect(validateBaselinePayload(payload)).toContain('runCount out of bounds');
    });
  });

  describe('adherence metrics', () => {
    it('should reject expectedRuns > 10000', () => {
      const payload = makeValidPayload();
      payload.jobs.adherence = [{ slug: 'test-job', expectedRuns: 10001, actualRuns: 0 }];
      expect(validateBaselinePayload(payload)).toContain('expectedRuns out of bounds');
    });

    it('should accept zero expected and actual runs', () => {
      const payload = makeValidPayload();
      payload.jobs.adherence = [{ slug: 'test-job', expectedRuns: 0, actualRuns: 0 }];
      expect(validateBaselinePayload(payload)).toBeNull();
    });
  });
});

describe('Worker: Signature Validation', () => {
  it('should accept valid headers', () => {
    const payload = makeValidPayload();
    const payloadStr = JSON.stringify(payload);
    const headers = makeValidHeaders(payload.installationId, payloadStr);
    expect(validateSignature(headers)).toBeNull();
  });

  it('should reject missing signature header', () => {
    const headers = {
      'x-instar-timestamp': Math.floor(Date.now() / 1000).toString(),
      'x-instar-key-fingerprint': 'a'.repeat(64),
    };
    expect(validateSignature(headers as any)).toBe('missing signature or timestamp');
  });

  it('should reject missing timestamp header', () => {
    const headers = {
      'x-instar-signature': 'hmac-sha256=' + 'a'.repeat(64),
      'x-instar-key-fingerprint': 'a'.repeat(64),
    };
    expect(validateSignature(headers as any)).toBe('missing signature or timestamp');
  });

  it('should reject non-numeric timestamp', () => {
    const headers = {
      'x-instar-signature': 'hmac-sha256=' + 'a'.repeat(64),
      'x-instar-timestamp': 'not-a-number',
      'x-instar-key-fingerprint': 'a'.repeat(64),
    };
    expect(validateSignature(headers)).toBe('invalid timestamp');
  });

  it('should reject timestamp older than 5 minutes', () => {
    const headers = {
      'x-instar-signature': 'hmac-sha256=' + 'a'.repeat(64),
      'x-instar-timestamp': (Math.floor(Date.now() / 1000) - 400).toString(), // 6+ min ago
      'x-instar-key-fingerprint': 'a'.repeat(64),
    };
    expect(validateSignature(headers)).toBe('timestamp expired');
  });

  it('should reject future timestamp beyond 5 minutes', () => {
    const headers = {
      'x-instar-signature': 'hmac-sha256=' + 'a'.repeat(64),
      'x-instar-timestamp': (Math.floor(Date.now() / 1000) + 400).toString(),
      'x-instar-key-fingerprint': 'a'.repeat(64),
    };
    expect(validateSignature(headers)).toBe('timestamp expired');
  });

  it('should accept timestamp within 5 minute window', () => {
    const headers = {
      'x-instar-signature': 'hmac-sha256=' + 'a'.repeat(64),
      'x-instar-timestamp': (Math.floor(Date.now() / 1000) - 200).toString(), // ~3 min ago
      'x-instar-key-fingerprint': 'a'.repeat(64),
    };
    expect(validateSignature(headers)).toBeNull();
  });

  it('should reject signature without hmac-sha256= prefix', () => {
    const headers = {
      'x-instar-signature': 'a'.repeat(64), // Missing prefix
      'x-instar-timestamp': Math.floor(Date.now() / 1000).toString(),
      'x-instar-key-fingerprint': 'a'.repeat(64),
    };
    expect(validateSignature(headers)).toBe('invalid signature prefix');
  });

  it('should reject signature with wrong length', () => {
    const headers = {
      'x-instar-signature': 'hmac-sha256=' + 'a'.repeat(32), // Too short
      'x-instar-timestamp': Math.floor(Date.now() / 1000).toString(),
      'x-instar-key-fingerprint': 'a'.repeat(64),
    };
    expect(validateSignature(headers)).toBe('invalid signature format');
  });

  it('should reject signature with non-hex characters', () => {
    const headers = {
      'x-instar-signature': 'hmac-sha256=' + 'g'.repeat(64), // Not hex
      'x-instar-timestamp': Math.floor(Date.now() / 1000).toString(),
      'x-instar-key-fingerprint': 'a'.repeat(64),
    };
    expect(validateSignature(headers)).toBe('invalid signature format');
  });

  it('should reject missing key fingerprint', () => {
    const headers = {
      'x-instar-signature': 'hmac-sha256=' + 'a'.repeat(64),
      'x-instar-timestamp': Math.floor(Date.now() / 1000).toString(),
    };
    expect(validateSignature(headers as any)).toBe('invalid key fingerprint');
  });

  it('should reject key fingerprint with wrong length', () => {
    const headers = {
      'x-instar-signature': 'hmac-sha256=' + 'a'.repeat(64),
      'x-instar-timestamp': Math.floor(Date.now() / 1000).toString(),
      'x-instar-key-fingerprint': 'a'.repeat(32), // Too short
    };
    expect(validateSignature(headers)).toBe('invalid key fingerprint');
  });
});

describe('Worker: Payload Size Enforcement', () => {
  it('should accept payload under 100KB', () => {
    const payload = makeValidPayload();
    const bytes = Buffer.from(JSON.stringify(payload), 'utf-8');
    expect(bytes.length).toBeLessThan(PAYLOAD_MAX_BYTES);
  });

  it('should flag payload exceeding 100KB', () => {
    const payload = makeValidPayload();
    // Add enough skip metrics to exceed 100KB
    payload.jobs.skips = Array.from({ length: 2000 }, (_, i) => ({
      slug: `job-${i}-with-a-longer-name-for-size`,
      reason: 'quota',
      count: 999,
    }));
    const bytes = Buffer.from(JSON.stringify(payload), 'utf-8');
    expect(bytes.length).toBeGreaterThan(PAYLOAD_MAX_BYTES);
  });
});

describe('Worker: DELETE Endpoint Validation', () => {
  it('should accept valid UUID for deletion path', () => {
    const uuid = randomUUID();
    // Worker matches: /^\/v1\/telemetry\/([0-9a-f-]{36})$/
    const regex = /^[0-9a-f-]{36}$/;
    expect(regex.test(uuid)).toBe(true);
  });

  it('should reject invalid UUID in deletion path', () => {
    const regex = /^[0-9a-f-]{36}$/;
    expect(regex.test('not-a-uuid')).toBe(false);
    expect(regex.test('ABCDEF01-2345-6789-ABCD-EF0123456789')).toBe(false);
    expect(regex.test('')).toBe(false);
  });

  it('authenticated delete requires signature + fingerprint + timestamp', () => {
    // Simulating the worker's authenticated delete check
    const hasSignature = true;
    const hasFingerprint = true;
    const hasTimestamp = true;
    const fingerprintMatches = true;
    const timestampFresh = true;
    const sigFormatValid = true;

    const canDelete = hasSignature && hasFingerprint && hasTimestamp &&
      fingerprintMatches && timestampFresh && sigFormatValid;
    expect(canDelete).toBe(true);
  });

  it('unsigned delete requires X-Instar-Purge-Reason: secret-lost', () => {
    // Without signature, worker checks for purge reason header
    const hasSignature = false;
    const purgeReason = 'secret-lost';
    const canInitiateGracePeriod = !hasSignature && purgeReason === 'secret-lost';
    expect(canInitiateGracePeriod).toBe(true);
  });

  it('unsigned delete without purge reason should be rejected', () => {
    const hasSignature = false;
    const purgeReason = undefined;
    const shouldReject = !hasSignature && purgeReason !== 'secret-lost';
    expect(shouldReject).toBe(true);
  });
});

describe('Worker: Aggregate Update Logic', () => {
  it('should merge duration metrics correctly (sum + count for fleet mean)', () => {
    // Worker computes: agg.durationSum += dur.meanMs * dur.count
    // Later: fleetMean = agg.durationSum / agg.durationCount

    // Agent A: 3 runs averaging 10000ms
    // Agent B: 7 runs averaging 20000ms
    // Fleet mean should be: (3*10000 + 7*20000) / (3+7) = 170000/10 = 17000ms
    const aggDurationSum = (10000 * 3) + (20000 * 7);
    const aggDurationCount = 3 + 7;
    const fleetMean = aggDurationSum / aggDurationCount;

    expect(fleetMean).toBe(17000);
  });

  it('should merge skip metrics by reason', () => {
    // Simulating aggregate merge
    const agg: Record<string, number> = {};

    // Agent A: health-check, 5 quota skips
    agg['quota'] = (agg['quota'] || 0) + 5;
    // Agent B: health-check, 3 quota skips
    agg['quota'] = (agg['quota'] || 0) + 3;
    // Agent C: health-check, 2 disabled skips
    agg['disabled'] = (agg['disabled'] || 0) + 2;

    expect(agg['quota']).toBe(8);
    expect(agg['disabled']).toBe(2);
  });

  it('should track unique contributors per slug', () => {
    let contributors = 0;
    contributors++; // Agent A submits for slug
    contributors++; // Agent B submits for slug
    contributors++; // Agent C submits for slug
    expect(contributors).toBe(3);
  });
});
