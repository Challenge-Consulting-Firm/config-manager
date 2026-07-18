/**
 * BFF entry point.
 *
 * Responsibilities:
 *   1. Serve the React SPA (static build assets) and fall back to index.html.
 *   2. Handle Entra ID OIDC (/auth/login, /auth/callback, /auth/logout, /auth/me).
 *   3. Expose JSON API (/api/*) on top of Kintone.
 *
 * Run with `pnpm --filter @config-manager/bff dev` (tsx watch) in development,
 * or `node dist/index.js` from the compiled output in production.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { getSession } from "./session.js";
import {
  buildAuthUrl,
  createPkce,
  decodeIdToken,
  exchangeCode,
  getUserGroups,
  toAuthUser,
} from "./entra.js";
import { api, type AppEnv } from "./api.js";
import type { AuthUser } from "@config-manager/shared";

const cfg = loadConfig();
// Resolve the SPA directory relative to THIS module so it works regardless of
// the process cwd (dev runs from apps/bff; the bundled prod runs from /app).
// dist/index.js  ->  ../public/spa
// src/index.ts   ->  ./public/spa
const moduleDir = dirname(fileURLToPath(import.meta.url));
const isBundled = existsSync(resolve(moduleDir, "index.js")) &&
  !existsSync(resolve(moduleDir, "index.ts"));
const SPA_DIR = resolve(
  moduleDir,
  isBundled ? "../public/spa" : "./public/spa",
);
const INDEX_HTML = resolve(SPA_DIR, "index.html");

// Dummy user injected when AUTH_MODE=disabled (local validation only).
const localUser: AuthUser = {
  displayName: cfg.localDevUser.name,
  email: cfg.localDevUser.email,
};

const app = new Hono<AppEnv>();
app.use(logger());
// Cap request bodies at 6 MB so a 5 MB config upload (plus JSON/headers)
// is accepted but runaway payloads are rejected early with HTTP 413.
app.use("*", bodyLimit({ maxSize: 6 * 1024 * 1024 }));

// ---- Health check (no auth) ----
app.get("/healthz", (c) => c.text("ok"));

// ---- Auth routes ----
app.get("/auth/login", async (c) => {
  if (cfg.authMode === "disabled") return c.redirect("/");
  const session = await getSession(c, {
    password: cfg.sessionSecret,
    secure: cfg.nodeEnv === "production",
  });
  const pkce = createPkce();
  const state = createPkce().verifier; // reuse as opaque state token
  session.set("pkceVerifier", pkce.verifier);
  session.set("oauthState", state);
  const returnTo = c.req.query("returnTo") || "/";
  if (!returnTo.startsWith("/")) {
    session.set("returnTo", "/");
  } else {
    session.set("returnTo", returnTo);
  }
  await session.save();
  const url = await buildAuthUrl(cfg, pkce, state);
  return c.redirect(url);
});

app.get("/auth/callback", async (c) => {
  if (cfg.authMode === "disabled") return c.redirect("/");
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");
  const errorDescription = c.req.query("error_description");
  if (error) {
    return c.text(`Auth error: ${error} — ${errorDescription ?? ""}`, 400);
  }
  if (!code || !state) {
    return c.text("Missing code or state in callback", 400);
  }
  const session = await getSession(c, {
    password: cfg.sessionSecret,
    secure: cfg.nodeEnv === "production",
  });
  if (state !== session.get("oauthState")) {
    return c.text("OAuth state mismatch", 400);
  }
  const verifier = session.get("pkceVerifier");
  if (!verifier) return c.text("Missing PKCE verifier in session", 400);

  try {
    const tokens = await exchangeCode(cfg, code, verifier);
    const claims = decodeIdToken(tokens.id_token);
    const user = toAuthUser(claims, "Unknown operator");

    // Group-based access control, if configured.
    if (cfg.entra.requiredGroupIds.length > 0) {
      const groups = await getUserGroups(tokens.access_token);
      const ok = cfg.entra.requiredGroupIds.some((g) => groups.includes(g));
      if (!ok) {
        return c.text("Access denied: user is not in a required group.", 403);
      }
    }

    session.set("user", user);
    session.set("accessToken", tokens.access_token);
    if (tokens.refresh_token) session.set("refreshToken", tokens.refresh_token);
    session.clearTransient();
    await session.save();
    const returnTo = session.get("returnTo") || "/";
    return c.redirect(returnTo);
  } catch (err) {
    console.error("[auth/callback] token exchange failed:", err);
    return c.text("Authentication failed. See server logs.", 500);
  }
});

app.get("/auth/logout", async (c) => {
  if (cfg.authMode === "disabled") return c.redirect("/");
  const session = await getSession(c, {
    password: cfg.sessionSecret,
    secure: cfg.nodeEnv === "production",
  });
  session.destroy();
  const postLogoutUri = `${cfg.publicBaseUrl}/`;
  const url =
    `https://login.microsoftonline.com/${cfg.entra.tenantId}/oauth2/v2.0/logout` +
    `?post_logout_redirect_uri=${encodeURIComponent(postLogoutUri)}`;
  return c.redirect(url);
});

app.get("/auth/me", async (c) => {
  if (cfg.authMode === "disabled") {
    return c.json({ authenticated: true, user: localUser });
  }
  const session = await getSession(c, {
    password: cfg.sessionSecret,
    secure: cfg.nodeEnv === "production",
  });
  const user = session.get("user");
  if (!user) return c.json({ authenticated: false }, 401);
  return c.json({ authenticated: true, user });
});

// ---- Auth guard for /api/* ----
app.use("/api/*", async (c, next) => {
  const session = await getSession(c, {
    password: cfg.sessionSecret,
    secure: cfg.nodeEnv === "production",
  });
  let user: AuthUser;
  if (cfg.authMode === "disabled") {
    user = localUser;
  } else {
    const u = session.get("user");
    if (!u) {
      return c.json({ error: "unauthenticated", login: "/auth/login" }, 401);
    }
    user = u;
  }
  c.set("cfg", cfg);
  c.set("session", session);
  c.set("user", user);
  await next();
});

app.route("/api", api);

// ---- Static SPA assets (production only; in dev Vite serves these) ----
app.use(
  "/*",
  serveStatic({
    root: SPA_DIR,
  }),
);

// SPA fallback: any non-API, non-file route serves index.html so client-side
// routing works on deep links.
app.get("*", (c) => {
  if (existsSync(INDEX_HTML)) {
    const html = readFileSync(INDEX_HTML, "utf8");
    return c.html(html);
  }
  return c.text(
    "Frontend build not found. Run `pnpm --filter @config-manager/web build` then `pnpm --filter @config-manager/bff build`.",
    404,
  );
});

serve(
  { fetch: app.fetch, port: cfg.port },
  (info) => {
    console.log(`config-manager BFF listening on http://localhost:${info.port}`);
    if (cfg.authMode === "disabled") {
      console.warn(
        `[startup] AUTH_MODE=disabled — Entra ID auth is BYPASSED and a local ` +
          `dummy user (${localUser.email}) is used. NEVER use this in production.`,
      );
    }
    if (!existsSync(SPA_DIR)) {
      mkdirSync(SPA_DIR, { recursive: true });
      console.warn(
        `[startup] SPA directory ${SPA_DIR} is empty. The frontend will 404 until built.`,
      );
    }
  },
);


