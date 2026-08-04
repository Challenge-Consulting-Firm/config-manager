/**
 * Process-local sliding-window rate limiter.
 *
 * Fine for a single fly.io machine. If the app scales to multiple machines,
 * replace the Map with a shared store (Redis etc.) — until then this is a
 * best-effort guard against accidental or abusive bursts on expensive routes.
 */

import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./api.js";

interface Bucket {
  /** Epoch-ms timestamps of recent hits within the window. */
  hits: number[];
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  /** Unique name for the limited surface (used in the bucket key). */
  name: string;
  /** Max requests per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

function prune(bucket: Bucket, windowStart: number): void {
  bucket.hits = bucket.hits.filter((t) => t >= windowStart);
}

/**
 * Reject with 429 when the caller exceeds `limit` requests in `windowMs`.
 * Must run AFTER the auth middleware so the user identity is available.
 */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.var.user;
    const id =
      user?.email || user?.objectId || c.req.header("x-forwarded-for") || "anon";
    const key = `${opts.name}:${id}`;
    const now = Date.now();
    const windowStart = now - opts.windowMs;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      buckets.set(key, bucket);
    }
    prune(bucket, windowStart);
    if (bucket.hits.length >= opts.limit) {
      const oldest = bucket.hits[0] ?? now;
      const retryAfterSec = Math.max(
        1,
        Math.ceil((oldest + opts.windowMs - now) / 1000),
      );
      c.header("Retry-After", String(retryAfterSec));
      console.warn(
        `[rate-limit] ${opts.name} exceeded for ${key} (${bucket.hits.length}/${opts.limit})`,
      );
      return c.json(
        {
          error: "rate limit exceeded",
          detail: `Too many requests to ${opts.name}. Retry after ${retryAfterSec}s.`,
          limit: opts.limit,
          windowMs: opts.windowMs,
        },
        429,
      );
    }
    bucket.hits.push(now);
    // Opportunistic GC so the map does not grow forever under unique keys.
    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) {
        prune(b, windowStart);
        if (b.hits.length === 0) buckets.delete(k);
      }
    }
    await next();
  };
}
