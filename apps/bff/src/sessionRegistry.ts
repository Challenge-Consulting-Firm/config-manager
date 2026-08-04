/**
 * Process-local session registry for logout revocation.
 *
 * Cookie sessions remain iron-sealed (survive fly auto-stop cold starts), but
 * each established login carries a random `sid`. Logout puts that sid on a
 * denylist so a stolen cookie cannot be reused for the rest of the process
 * lifetime (or until the original cookie TTL elapses — whichever comes first).
 *
 * Limits (documented in docs/SECURITY.md):
 *   - Single machine only. Multi-machine needs a shared store (Redis etc.).
 *   - Machine restart / auto-stop clears the denylist; sealed cookies remain
 *     valid until their own TTL. Rotate SESSION_SECRET for a hard cutover.
 */

import { randomBytes } from "node:crypto";

/** Default denylist retention: match the 7-day cookie maxAge. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface RevokedEntry {
  /** Epoch-ms after which the entry may be GC'd. */
  expiresAt: number;
  /** Optional actor email for diagnostics. */
  email?: string;
}

const revoked = new Map<string, RevokedEntry>();

/** Create a new opaque session id (url-safe, 128-bit entropy). */
export function newSessionId(): string {
  return randomBytes(16).toString("base64url");
}

/** Mark a session id as revoked until `ttlMs` elapses. */
export function revokeSession(
  sid: string | undefined,
  opts: { email?: string; ttlMs?: number } = {},
): void {
  if (!sid) return;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  revoked.set(sid, {
    expiresAt: Date.now() + ttlMs,
    email: opts.email,
  });
  // Opportunistic GC so the map does not grow without bound.
  if (revoked.size > 5_000) gcRevoked();
}

/** True when the sid was explicitly revoked and has not expired yet. */
export function isSessionRevoked(sid: string | undefined): boolean {
  if (!sid) return false;
  const entry = revoked.get(sid);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    revoked.delete(sid);
    return false;
  }
  return true;
}

function gcRevoked(): void {
  const now = Date.now();
  for (const [k, v] of revoked) {
    if (v.expiresAt <= now) revoked.delete(k);
  }
}

/** Test helper — wipe the denylist. Not used in production paths. */
export function _resetSessionRegistryForTests(): void {
  revoked.clear();
}
