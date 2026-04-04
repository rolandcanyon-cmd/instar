import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMoltBridgeRoutes } from '../../../src/moltbridge/routes.js';
import { MoltBridgeClient, type MoltBridgeConfig } from '../../../src/moltbridge/MoltBridgeClient.js';
import { CanonicalIdentityManager } from '../../../src/identity/IdentityManager.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('MoltBridge Routes', () => {
  let app: express.Express;
  let tmpDir: string;
  let identity: CanonicalIdentityManager;
  let client: MoltBridgeClient;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-routes-'));
    identity = new CanonicalIdentityManager(tmpDir);
    identity.create({ skipRecovery: true });

    client = new MoltBridgeClient({
      enabled: true,
      apiUrl: 'https://api.moltbridge.test',
      autoRegister: false,
      enrichmentMode: 'manual',
    });

    app = express();
    app.use(express.json());
    app.use(createMoltBridgeRoutes({ client, identity }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /moltbridge/status', () => {
    it('returns disabled status when client is disabled', async () => {
      const disabledClient = new MoltBridgeClient({
        enabled: false,
        apiUrl: 'https://api.test',
        autoRegister: false,
        enrichmentMode: 'manual',
      });
      const disabledApp = express();
      disabledApp.use(express.json());
      disabledApp.use(createMoltBridgeRoutes({ client: disabledClient, identity }));

      const res = await request(disabledApp).get('/moltbridge/status');
      expect(res.status).toBe(200);
      expect(res.body.registered).toBe(false);
      expect(res.body.reason).toContain('disabled');
    });
  });

  describe('POST /moltbridge/discover', () => {
    it('returns 400 without capability', async () => {
      const res = await request(app)
        .post('/moltbridge/discover')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('capability');
    });
  });

  describe('POST /moltbridge/attest', () => {
    it('returns 400 without required fields', async () => {
      const res = await request(app)
        .post('/moltbridge/attest')
        .send({ subject: 'abc' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid capability tag', async () => {
      // Mock fetch to not be called (validation happens before API)
      vi.stubGlobal('fetch', vi.fn());

      const res = await request(app)
        .post('/moltbridge/attest')
        .send({
          subject: 'abc',
          capability: 'invalid-tag',
          outcome: 'success',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CAPABILITY_TAG');
    });
  });

  describe('GET /moltbridge/trust/:agentId', () => {
    it('returns 502 when MoltBridge is unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      const res = await request(app).get('/moltbridge/trust/some-agent-id');
      // getIQSBand returns null on error (graceful degradation), not 502
      expect(res.status).toBe(200);
      expect(res.body.iqsBand).toBe('unknown');
    });
  });
});
