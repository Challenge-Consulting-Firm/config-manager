/**
 * Cross-cutting HTTP security helpers for the BFF:
 *   - CSRF protection via Origin/Referer checks on state-changing requests
 *   - Baseline security response headers
 *
 * Kept separate from index.ts so the rules stay easy to unit-review and to
 * keep the entrypoint focused on routing.
 */

import type { Context, Next } from "hono";

/** Methods that mutate server state and therefore require CSRF defenses. */
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Derive the set of accepted request origins from PUBLIC_BASE_URL.
 * In development we also accept the Vite dev server (5173) since the SPA
 * talks to the BFF cross-port via the Vite proxy or direct fetch.
 */
export function allowedOrigins(publicBaseUrl: string, nodeEnv: string): Set<string> {
  const origins = new Set<string>();
  try {
    origins.add(new URL(publicBaseUrl).origin);
  } catch {
    // Fall through; an unparseable PUBLIC_BASE_URL is a config error, but we
    // still want a non-empty set so the middleware fails closed rather than open.
  }
  if (nodeEnv !== "production") {
    origins.add("http://localhost:3000");
    origins.add("http://127.0.0.1:3000");
    origins.add("http://localhost:5173");
    origins.add("http://127.0.0.1:5173");
  }
  return origins;
}

/**
 * Derive the origin the request was actually delivered to, from the Host header
 * and the (proxy-forwarded) scheme. Behind fly.io's TLS-terminating proxy the
 * app speaks plain HTTP internally, so trust X-Forwarded-Proto for the scheme.
 *
 * A same-origin browser request always carries an Origin/Referer whose origin
 * equals this self-origin, so accepting it makes the CSRF guard robust to a
 * misconfigured PUBLIC_BASE_URL (or an extra hostname / custom domain) while
 * still rejecting genuine cross-site requests, whose Origin differs from the
 * host they are hitting.
 */
function selfOrigin(c: Context): string | null {
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
  if (!host) return null;
  const proto =
    c.req.header("x-forwarded-proto") ??
    (c.req.url.startsWith("https:") ? "https" : "http");
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}

/** Extract an origin from either the Origin header or the Referer header. */
function requestOrigin(c: Context): string | null {
  const origin = c.req.header("origin");
  if (origin) {
    try {
      return new URL(origin).origin;
    } catch {
      return null;
    }
  }
  const referer = c.req.header("referer");
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Reject cross-site state-changing requests.
 *
 * Strategy: require Origin (preferred) or Referer to match PUBLIC_BASE_URL.
 * Same-origin browser form/fetch always send at least one of them for
 * POST/PUT/DELETE in modern browsers. Missing both is treated as suspicious
 * (curl without headers can still opt in by sending Origin explicitly).
 *
 * Safe methods (GET/HEAD/OPTIONS) are not checked — they must remain free of
 * side effects.
 */
export function createCsrfOriginGuard(opts: {
  publicBaseUrl: string;
  nodeEnv: string;
}) {
  const allowed = allowedOrigins(opts.publicBaseUrl, opts.nodeEnv);

  return async (c: Context, next: Next) => {
    if (!STATE_CHANGING.has(c.req.method.toUpperCase())) {
      return next();
    }

    // Only protect app-owned mutable surfaces. /auth/* is reached via the
    // OIDC redirect chain (GET) today; if POST ever appears there it should
    // still be covered since it is same-origin from our SPA.
    const path = c.req.path;
    if (!path.startsWith("/api/") && !path.startsWith("/auth/")) {
      return next();
    }

    const origin = requestOrigin(c);
    // Accept when the request origin matches either the configured allow-list
    // or the origin the request was actually delivered to (its own host). The
    // latter keeps a same-origin request working even if PUBLIC_BASE_URL is
    // stale or the app is reached via an additional hostname / custom domain.
    const self = selfOrigin(c);
    if (!origin || (!allowed.has(origin) && origin !== self)) {
      console.warn(
        `[csrf] rejected ${c.req.method} ${path} origin=${origin ?? "(missing)"} ` +
          `allowed=${[...allowed].join(",")} self=${self ?? "(unknown)"}`,
      );
      return c.json(
        {
          error: "cross-origin request blocked",
          detail:
            "State-changing requests must include a matching Origin or Referer header.",
        },
        403,
      );
    }
    return next();
  };
}

/**
 * Attach baseline security headers to every response.
 * CSP is deliberately conservative for a same-origin SPA that does not need
 * remote script/style hosts. `unsafe-inline` is allowed only for styles so
 * existing Tailwind / inline style attributes keep working; scripts stay locked
 * to 'self' (Vite production builds do not rely on inline scripts in index.html
 * beyond the module entry, which is same-origin).
 */
export async function securityHeaders(c: Context, next: Next) {
  await next();
  const h = c.res.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-DNS-Prefetch-Control", "off");
  h.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  // frame-ancestors mirrors X-Frame-Options for modern browsers.
  // connect-src includes 'self' only; Meraki/Kintone calls go server-side.
  h.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      // React/Tailwind may set style attributes; keep scripts strict.
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
    ].join("; "),
  );
  // HSTS only when the request itself is HTTPS (or behind a TLS-terminating
  // proxy that sets X-Forwarded-Proto). Avoid setting it on plain HTTP local
  // dev, which would pin browsers to HTTPS for localhost.
  const proto =
    c.req.header("x-forwarded-proto") ??
    (c.req.url.startsWith("https:") ? "https" : "http");
  if (proto === "https") {
    h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}
