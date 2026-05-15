/**
 * Error hierarchy for the provider portability substrate.
 *
 * Adapters normalize provider-native errors to this small set so application
 * code can handle each category uniformly. The raw underlying error is always
 * preserved in `cause` for adapter-specific diagnosis when needed.
 *
 * Pattern: catch the broadest class you can act on; re-throw what you can't.
 *
 *   try { ... }
 *   catch (err) {
 *     if (err instanceof QuotaError) { ... back off ... }
 *     if (err instanceof TimeoutError) { ... retry with longer budget ... }
 *     throw err;
 *   }
 */

import type { ProviderId } from './types.js';

/**
 * Base class for all errors originating in the provider substrate.
 *
 * Wraps the raw provider error in `cause` and identifies which adapter
 * raised it via `providerId`.
 */
export class ProviderError extends Error {
  readonly providerId: ProviderId;
  readonly cause?: unknown;

  constructor(message: string, providerId: ProviderId, cause?: unknown) {
    super(message);
    this.name = 'ProviderError';
    this.providerId = providerId;
    if (cause !== undefined) {
      this.cause = cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Authentication failed — bad credentials, expired token, missing scope. */
export class AuthError extends ProviderError {
  constructor(message: string, providerId: ProviderId, cause?: unknown) {
    super(message, providerId, cause);
    this.name = 'AuthError';
    Object.setPrototypeOf(this, AuthError.prototype);
  }
}

/**
 * Quota exhausted — provider has refused based on usage limits.
 *
 * `retryAfterMs` indicates when retry MAY succeed (e.g., when the rate limit
 * window resets). Adapters report this when known; callers must tolerate null.
 */
export class QuotaError extends ProviderError {
  readonly retryAfterMs?: number;
  readonly limitKind?: 'rate' | 'daily' | 'weekly' | 'monthly' | 'credit-pot' | 'unknown';

  constructor(
    message: string,
    providerId: ProviderId,
    options: { retryAfterMs?: number; limitKind?: QuotaError['limitKind']; cause?: unknown } = {},
  ) {
    super(message, providerId, options.cause);
    this.name = 'QuotaError';
    this.retryAfterMs = options.retryAfterMs;
    this.limitKind = options.limitKind;
    Object.setPrototypeOf(this, QuotaError.prototype);
  }
}

/**
 * Rate limit hit (a subset of QuotaError where the limit window is short and
 * retry-after is typically known). Distinct class because callers often want
 * fast retry for rate limits vs. back-off-substantially for daily/weekly.
 */
export class RateLimitError extends QuotaError {
  constructor(
    message: string,
    providerId: ProviderId,
    options: { retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, providerId, { ...options, limitKind: 'rate' });
    this.name = 'RateLimitError';
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

/** Operation exceeded its time budget. */
export class TimeoutError extends ProviderError {
  readonly elapsedMs: number;
  readonly budgetMs?: number;

  constructor(
    message: string,
    providerId: ProviderId,
    elapsedMs: number,
    options: { budgetMs?: number; cause?: unknown } = {},
  ) {
    super(message, providerId, options.cause);
    this.name = 'TimeoutError';
    this.elapsedMs = elapsedMs;
    this.budgetMs = options.budgetMs;
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

/** Network-layer failure — transport refused, connection reset, DNS, TLS. */
export class NetworkError extends ProviderError {
  constructor(message: string, providerId: ProviderId, cause?: unknown) {
    super(message, providerId, cause);
    this.name = 'NetworkError';
    Object.setPrototypeOf(this, NetworkError.prototype);
  }
}

/**
 * Caller-initiated abort via AbortSignal. Distinct from TimeoutError —
 * AbortError means the consumer canceled, TimeoutError means the deadline
 * passed.
 */
export class AbortError extends ProviderError {
  constructor(message: string, providerId: ProviderId, cause?: unknown) {
    super(message, providerId, cause);
    this.name = 'AbortError';
    Object.setPrototypeOf(this, AbortError.prototype);
  }
}

/**
 * Requested capability not supported by this adapter. Thrown when an adapter
 * is asked to perform an operation outside its declared `capabilities` set,
 * or when an optional primitive method is called on an adapter that returns
 * null for it.
 */
export class UnsupportedCapabilityError extends ProviderError {
  readonly capability: string;

  constructor(capability: string, providerId: ProviderId) {
    super(
      `Provider ${providerId} does not support capability '${capability}'`,
      providerId,
    );
    this.name = 'UnsupportedCapabilityError';
    this.capability = capability;
    Object.setPrototypeOf(this, UnsupportedCapabilityError.prototype);
  }
}

/**
 * Catch-all for failures that don't fit the categories above. Adapters
 * should prefer the specific classes when possible; this is for genuinely
 * unexpected provider behavior.
 */
export class UnexpectedError extends ProviderError {
  constructor(message: string, providerId: ProviderId, cause?: unknown) {
    super(message, providerId, cause);
    this.name = 'UnexpectedError';
    Object.setPrototypeOf(this, UnexpectedError.prototype);
  }
}

// ── Type guards ───────────────────────────────────────────────────────

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

export function isTransientError(err: unknown): boolean {
  return err instanceof NetworkError || err instanceof RateLimitError || err instanceof TimeoutError;
}
