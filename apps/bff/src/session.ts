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
  accessToken?: string;
  refreshToken?: string;
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
      sameSite: "Lax",
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
      sameSite: "Lax",
      secure: this.options.secure,
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
  }
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
