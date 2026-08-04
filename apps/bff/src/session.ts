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
  /**
   * Cookie SameSite policy. Defaults to secure? None : Lax.
   * OIDC login/callback need None so the cross-site Set-Cookie lands; once the
   * user is established we re-save with Lax to shrink the CSRF surface.
   */
  sameSite?: "None" | "Lax";
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

  /** Switch SameSite for the next save() (e.g. None during OIDC → Lax after). */
  setSameSite(sameSite: "None" | "Lax") {
    this.options = { ...this.options, sameSite };
  }

  destroy() {
    this.data = {};
    this.destroyed = true;
    const sameSite = resolveSameSite(this.options);
    setCookie(this.ctx, COOKIE_NAME, "", {
      httpOnly: true,
      // Match the cookie attributes used in save(); otherwise some browsers
      // ignore the expiry on the deletion path. Clear under both policies so a
      // leftover None cookie from the OIDC handoff cannot outlive logout.
      sameSite,
      secure: this.options.secure || sameSite === "None",
      path: "/",
      expires: new Date(0),
    });
    if (sameSite === "Lax" && this.options.secure) {
      setCookie(this.ctx, COOKIE_NAME, "", {
        httpOnly: true,
        sameSite: "None",
        secure: true,
        path: "/",
        expires: new Date(0),
      });
    }
  }

  async save() {
    if (this.destroyed) return;
    if (!this.dirty) return;
    const sealed = await sealData(this.data, {
      password: this.options.password,
      ttl: 60 * 60 * 24 * 7,
    });
    const sameSite = resolveSameSite(this.options);
    // None requires Secure. When callers ask for None we force secure even if
    // the ambient option is false (should only happen in tests).
    const secure = this.options.secure || sameSite === "None";
    setCookie(this.ctx, COOKIE_NAME, sealed, {
      httpOnly: true,
      // OIDC login/callback use SameSite=None so the cookie survives the
      // cross-site redirect from login.microsoftonline.com (fly.dev is on the
      // PSL; Lax cookies set in that chain are deferred/dropped). After the
      // user is established the callback re-saves with SameSite=Lax to reduce
      // CSRF exposure for the rest of the session lifetime.
      sameSite,
      secure,
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    // Log the size so we can detect 4 KiB browser-limit overruns in Fly logs.
    // Browsers silently drop cookies larger than ~4096 bytes, which previously
    // caused a post-login 401 loop.
    console.log(
      `[session] saved cookie: ${sealed.length} bytes, sameSite=${sameSite}, keys=${Object.keys(this.data).join(",") || "(empty)"}`,
    );
  }
}

function resolveSameSite(options: SessionOptions): "None" | "Lax" {
  if (options.sameSite) return options.sameSite;
  // Default: None in prod (legacy behaviour) — callers should pass an explicit
  // value. Kept only as a safe fallback for code paths that forgot.
  return options.secure ? "None" : "Lax";
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
