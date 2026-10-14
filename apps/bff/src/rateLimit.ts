/**
 * Process-local sliding-window rate limiter.
 *
 * Fine for a single fly.io machine. If the app scales to multiple machines,
 * replace the Map with a shared store (Redis etc.) — until then this is a
 * best-effort guard against accidental or abusive bursts on expensive routes.
 */

import { BlockList, isIP } from "node:net";
import type { Context, MiddlewareHandler } from "hono";
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
  /**
   * Bucket key source. "user" (default) prefers the authenticated identity and
   * falls back to the client IP. "ip" always keys on the IP — the only option
   * for routes that run before/without auth.
   */
  keyBy?: "user" | "ip";
}

/**
 * Cloudflare の公開エッジ IP レンジ（https://www.cloudflare.com/ips/）。
 * Cloudflare プロキシ経由（config.ccf.work）では fly.io から見た接続元が
 * Cloudflare エッジになるため、そのままでは全利用者が同じバケットに入る。
 * 接続元がこのレンジのときだけ CF-Connecting-IP を信用し、fly.dev へ直接
 * 来たリクエストがヘッダを偽装してバケットを散らすことを防ぐ。
 * レンジが更新された場合は上記 URL に合わせて追随すること。
 */
const CLOUDFLARE_IPV4 = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];
const CLOUDFLARE_IPV6 = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

const cloudflareRanges = (() => {
  const list = new BlockList();
  for (const cidr of CLOUDFLARE_IPV4) {
    const [net, prefix] = cidr.split("/");
    list.addSubnet(net!, Number(prefix), "ipv4");
  }
  for (const cidr of CLOUDFLARE_IPV6) {
    const [net, prefix] = cidr.split("/");
    list.addSubnet(net!, Number(prefix), "ipv6");
  }
  return list;
})();

export function isCloudflareIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return cloudflareRanges.check(ip, "ipv4");
  if (family === 6) return cloudflareRanges.check(ip, "ipv6");
  return false;
}

/**
 * Best-effort client IP.
 *
 * `Fly-Client-IP` is written by the fly.io proxy and cannot be forged by the
 * client, so it wins — unless it is a Cloudflare edge, in which case the real
 * client is in `CF-Connecting-IP` (set by Cloudflare, trusted only then).
 * The `X-Forwarded-For` fallback takes the RIGHTMOST entry: a client can
 * prepend arbitrary values, but the closest trusted proxy appends the real
 * address last.
 */
export function clientIp(c: Context): string {
  const fly = c.req.header("fly-client-ip")?.trim();
  if (fly) {
    if (isCloudflareIp(fly)) {
      const cf = c.req.header("cf-connecting-ip")?.trim();
      if (cf && isIP(cf)) return cf;
    }
    return fly;
  }
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return "unknown";
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
    const user = opts.keyBy === "ip" ? undefined : c.var.user;
    const id = user?.email || user?.objectId || clientIp(c);
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

export interface ConcurrencyLimitOptions {
  /** Unique name for the guarded surface (used in logs). */
  name: string;
  /** Max requests allowed to run the handler at the same time. */
  max: number;
  /** Seconds advertised in Retry-After when the gate is full. Default 1. */
  retryAfterSec?: number;
}

/**
 * Cap how many requests may occupy a route's handler simultaneously.
 *
 * The rate limiter alone does not bound a burst that arrives inside a single
 * window, which is what exhausts the CPU/memory of the single fly machine.
 * Excess requests are shed immediately with 503 instead of queueing
 * (Issue #77).
 */
export function concurrencyLimit(
  opts: ConcurrencyLimitOptions,
): MiddlewareHandler<AppEnv> {
  let inFlight = 0;
  return async (c, next) => {
    if (inFlight >= opts.max) {
      const retryAfterSec = opts.retryAfterSec ?? 1;
      c.header("Retry-After", String(retryAfterSec));
      console.warn(
        `[concurrency-limit] ${opts.name} full (${inFlight}/${opts.max}); shedding request`,
      );
      return c.json(
        {
          error: "too many concurrent requests",
          detail: `${opts.name} is busy. Retry after ${retryAfterSec}s.`,
          max: opts.max,
        },
        503,
      );
    }
    inFlight += 1;
    try {
      await next();
    } finally {
      inFlight -= 1;
    }
  };
}

/**
 * 手動で解放する同時実行枠。concurrencyLimit はハンドラが返った時点で枠を
 * 解放するが、大きなバッファを返すルートではレスポンスの送信中もメモリを
 * 握り続けるため、送信完了・切断まで枠を保持したい場合に使う。
 *
 * tryAcquire() は枠が空いていれば解放関数（複数回呼んでも 1 回だけ効く）を、
 * 満杯なら null を返す。
 */
export function createConcurrencySlots(opts: { name: string; max: number }): {
  tryAcquire(): (() => void) | null;
} {
  let inFlight = 0;
  return {
    tryAcquire() {
      if (inFlight >= opts.max) {
        console.warn(
          `[concurrency-limit] ${opts.name} full (${inFlight}/${opts.max}); shedding request`,
        );
        return null;
      }
      inFlight += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight -= 1;
      };
    },
  };
}
