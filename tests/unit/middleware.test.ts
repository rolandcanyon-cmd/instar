import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { authMiddleware, corsMiddleware, errorHandler } from '../../src/server/middleware.js';

function createApp(authToken?: string) {
  const app = express();
  app.use(corsMiddleware);
  app.use(authMiddleware(authToken));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/status', (_req, res) => res.json({ sessions: 0 }));
  app.get('/error', () => { throw new Error('test error'); });
  app.use(errorHandler);

  return app;
}

describe('authMiddleware', () => {
  describe('when auth token is configured', () => {
    const app = createApp('test-secret-token');

    it('allows /health without auth', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('blocks requests without Authorization header', async () => {
      const res = await request(app).get('/status');
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Authorization');
    });

    it('blocks requests with wrong token', async () => {
      const res = await request(app)
        .get('/status')
        .set('Authorization', 'Bearer wrong-token');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Invalid');
    });

    it('allows requests with correct token', async () => {
      const res = await request(app)
        .get('/status')
        .set('Authorization', 'Bearer test-secret-token');
      expect(res.status).toBe(200);
      expect(res.body.sessions).toBe(0);
    });

    it('blocks non-Bearer auth schemes', async () => {
      const res = await request(app)
        .get('/status')
        .set('Authorization', 'Basic dGVzdDp0ZXN0');
      expect(res.status).toBe(401);
    });
  });

  describe('when auth token is not configured', () => {
    const app = createApp(undefined);

    it('allows all requests without auth', async () => {
      const res = await request(app).get('/status');
      expect(res.status).toBe(200);
    });
  });
});

describe('corsMiddleware', () => {
  const app = createApp();

  it('handles OPTIONS preflight', async () => {
    const res = await request(app).options('/status');
    expect(res.status).toBe(204);
  });

  it('sets CORS headers on regular requests', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
  });
});

describe('errorHandler', () => {
  const app = createApp();

  it('returns 500 with error message', async () => {
    const res = await request(app).get('/error');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('test error');
    expect(res.body).toHaveProperty('timestamp');
  });
});
