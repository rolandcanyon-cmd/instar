import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { rateLimiter } from '../../src/server/middleware.js';

function createApp(windowMs: number, maxRequests: number) {
  const app = express();
  const limiter = rateLimiter(windowMs, maxRequests);
  app.get('/limited', limiter, (_req, res) => res.json({ ok: true }));
  return app;
}

describe('rateLimiter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('allows requests within the limit', async () => {
    vi.useRealTimers(); // supertest needs real timers
    const app = createApp(60_000, 5);

    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/limited');
      expect(res.status).toBe(200);
    }
  });

  it('blocks requests exceeding the limit', async () => {
    vi.useRealTimers();
    const app = createApp(60_000, 3);

    // Fill the window
    for (let i = 0; i < 3; i++) {
      await request(app).get('/limited');
    }

    // This one should be rate limited
    const res = await request(app).get('/limited');
    expect(res.status).toBe(429);
    expect(res.body.error).toContain('Rate limit exceeded');
    expect(res.body.retryAfterMs).toBeGreaterThan(0);
  });

  it('resets after the window expires', async () => {
    vi.useRealTimers();
    const app = createApp(100, 2); // 100ms window

    // Fill the window
    await request(app).get('/limited');
    await request(app).get('/limited');

    // Should be blocked
    let res = await request(app).get('/limited');
    expect(res.status).toBe(429);

    // Wait for window to expire
    await new Promise(r => setTimeout(r, 150));

    // Should work again
    res = await request(app).get('/limited');
    expect(res.status).toBe(200);
  });

  it('returns retryAfterMs in 429 response', async () => {
    vi.useRealTimers();
    const app = createApp(60_000, 1);

    await request(app).get('/limited');
    const res = await request(app).get('/limited');

    expect(res.status).toBe(429);
    expect(typeof res.body.retryAfterMs).toBe('number');
    expect(res.body.retryAfterMs).toBeGreaterThan(0);
    expect(res.body.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('uses default window and max when not specified', () => {
    // Just verify the factory doesn't throw
    const limiter = rateLimiter();
    expect(typeof limiter).toBe('function');
  });
});
