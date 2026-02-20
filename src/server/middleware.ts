/**
 * Express middleware — JSON parsing, CORS, auth, error handling.
 */

import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Restrict CORS to localhost origins only — this is a local management API
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

/**
 * Auth middleware — enforces Bearer token on API endpoints.
 * Health endpoint is exempt (used for external monitoring).
 */
export function authMiddleware(authToken?: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip auth if no token configured
    if (!authToken) {
      next();
      return;
    }

    // Health endpoint is always public
    if (req.path === '/health') {
      next();
      return;
    }

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = header.slice(7);
    // Timing-safe comparison to prevent timing attacks
    const a = Buffer.from(token);
    const b = Buffer.from(authToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(403).json({ error: 'Invalid auth token' });
      return;
    }

    next();
  };
}

/**
 * Simple in-memory rate limiter using a sliding window.
 * No external dependencies. Suitable for a local management API.
 */
export function rateLimiter(windowMs: number = 60_000, maxRequests: number = 10) {
  const requests: number[] = [];

  return (_req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    // Remove expired entries
    while (requests.length > 0 && requests[0] <= now - windowMs) {
      requests.shift();
    }

    if (requests.length >= maxRequests) {
      res.status(429).json({
        error: `Rate limit exceeded. Max ${maxRequests} requests per ${windowMs / 1000}s.`,
        retryAfterMs: requests[0] + windowMs - now,
      });
      return;
    }

    requests.push(now);
    next();
  };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[server] Error: ${message}`);
  res.status(500).json({
    error: message,
    timestamp: new Date().toISOString(),
  });
}
