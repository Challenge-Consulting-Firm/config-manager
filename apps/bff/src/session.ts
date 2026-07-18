/**
 * Session storage backed by a sealed (encrypted + signed) cookie.
 *
 * We use iron-session's `sealData` / `unsealData` primitives together with
 * Hono's cookie helpers so the session lifecycle is fully under our control.
 */

import { sealData, unsealData } from "iron-session";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AuthUser } from "@config-manager/shared";

const COOKIE_NAME = "cm_session";

export interface SessionData {
  user?: AuthUser;
  pkceVerifier?: string;
  oauthState?: string;
  returnTo?: string;
}

export interface SessionOptions {
  password: string;
  secure: boolean;
}

export class Session {
  private data: SessionData;
  private dirty = false;
  private destroyed = false;

  constructor(
    private ctx: Context,
    private options: SessionOptions,
    initial: SessionData,
  ) {
    this.data = initial;
  }

  get value(): SessionData {
    return this.data;
  }

  set<K extends keyof SessionData>(key: K, val: SessionData[K]) {
    this.data[key] = val;
    this.dirty = true;
  }

  get<K extends keyof SessionData>(key: K): SessionData[K] | undefined {
    return this.data[key];
  }

  clearTransient() {
    delete this.data.pkceVerifier;
    delete this.data.oauthState;
    delete this.data.returnTo;
    this.dirty = true;
  }

  destroy() {
    this.data = {};
    this.destroyed = true;
    setCookie(this.ctx, COOKIE_NAME, "", {
      httpOnly: true,
      // Match the cookie attributes used in save(); otherwise some browsers
      // ignore the expiry on the deletion path.
      sameSite: cookieSameSite(this.options.secure),
      secure: this.options.secure,
      path: "/",
      expires: new Date(0),
    });
  }

  async save() {
    if (this.destroyed) return;
    if (!this.dirty) return;
    const sealed = await sealData(this.data, {
      password: this.options.password,
      ttl: 60 * 60 * 24 * 7,
    });
    setCookie(this.ctx, COOKIE_NAME, sealed, {
      httpOnly: true,
      // SameSite=None is required so the session cookie survives the
      // cross-site redirect chain from login.microsoftonline.com back to
      // /auth/callback. On fly.dev (a public suffix in the PSL) Lax cookies
      // set during that chain are deferred/rejected by modern browsers,
      // which manifests as a 401 loop right after a successful OIDC login.
      // None requires Secure, so we only use it when secure=true (prod);
      // local dev keeps Lax because HTTP cannot use Secure.
      sameSite: cookieSameSite(this.options.secure),
      secure: this.options.secure,
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    // Log the size so we can detect 4 KiB browser-limit overruns in Fly logs.
    // Browsers silently drop cookies larger than ~4096 bytes, which previously
    // caused a post-login 401 loop.
    console.log(
      `[session] saved cookie: ${sealed.length} bytes, keys=${Object.keys(this.data).join(",") || "(empty)"}`,
    );
  }
}

/** SameSite policy: `None` (with Secure) in production so the OIDC
 *  cross-site redirect callback can set the session cookie; `Lax` in
 *  local dev because HTTP cannot use `Secure` (required for `None`). */
function cookieSameSite(secure: boolean): "None" | "Lax" {
  return secure ? "None" : "Lax";
}

export async function getSession(
  ctx: Context,
  options: SessionOptions,
): Promise<Session> {
  const sealed = getCookie(ctx, COOKIE_NAME);
  let data: SessionData = {};
  if (sealed) {
    try {
      data = (await unsealData(sealed, { password: options.password })) as SessionData;
    } catch {
      data = {};
    }
  }
  return new Session(ctx, options, data);
}
