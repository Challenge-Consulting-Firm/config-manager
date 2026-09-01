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
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { loadConfig } from "./config.js";
import { getSession } from "./session.js";
import {
  assertIdTokenClaims,
  buildAuthUrl,
  createPkce,
  decodeIdToken,
  exchangeCode,
  getUserGroups,
  toAuthUser,
} from "./entra.js";
import { api, type AppEnv } from "./api.js";
import { createHelperCredentialsApp } from "./helperCredentials.js";
import {
  createCsrfOriginGuard,
  securityHeaders,
} from "./security.js";
import { resolveRoleFromGroups, roleGroupsConfigured } from "./rbac.js";
import {
  isSessionRevoked,
  newSessionId,
  revokeSession,
} from "./sessionRegistry.js";
import { isAppRole, safeReturnPath, type AuthUser } from "@config-manager/shared";

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
  role: cfg.localDevRole,
};

const sessionSecure = cfg.nodeEnv === "production";
/** OIDC login/callback must use None so the cookie survives the Entra redirect. */
const oidcSessionOpts = {
  password: cfg.sessionSecret,
  secure: sessionSecure,
  sameSite: (sessionSecure ? "None" : "Lax") as "None" | "Lax",
};
/** Established sessions use Lax to shrink CSRF exposure. */
const establishedSessionOpts = {
  password: cfg.sessionSecret,
  secure: sessionSecure,
  sameSite: "Lax" as const,
};

const app = new Hono<AppEnv>();
app.use(logger());
// Cap request bodies at 6 MB so a 5 MB config upload (plus JSON/headers)
// is accepted but runaway payloads are rejected early with HTTP 413.
app.use("*", bodyLimit({ maxSize: 6 * 1024 * 1024 }));
// Baseline security headers on every response (CSP, XFO, nosniff, …).
app.use("*", securityHeaders);
// CSRF defense for state-changing /api/* and /auth/* requests: require a
// matching Origin/Referer. Complements SameSite cookie attributes.
app.use(
  "*",
  createCsrfOriginGuard({
    publicBaseUrl: cfg.publicBaseUrl,
    nodeEnv: cfg.nodeEnv,
  }),
);

// 末捕獲例外のフォーマットを統一する。/api/* へのリクエストでは JSON を返し、
// それ以外 (SPA fallback 等) ではプレーンテキストを返す。これにより、ハンドラ内で
// 例外が飛んだ際に Hono 既定の "Internal Server Error" プレーンテキストが返り、
// クライアント側で "SyntaxError: Unexpected token 'I'..." と JSON パースに失敗する
// 問題を防ぐ。開発時 (NODE_ENV !== production) にはエラーメッセージとスタックトーレスも返す。
app.onError((err, c) => {
  console.error("[unhandled]", err);
  const isApi = c.req.path.startsWith("/api/");
  const message = err instanceof Error ? err.message : String(err);
  if (isApi) {
    const body: Record<string, unknown> = {
      error: cfg.nodeEnv === "production" ? "internal server error" : message,
    };
    if (cfg.nodeEnv !== "production" && err instanceof Error) {
      body.stack = err.stack;
    }
    return c.json(body, 500);
  }
  return c.text(
    cfg.nodeEnv === "production" ? "Internal Server Error" : `Error: ${message}`,
    500,
  );
});

// ---- Health check (no auth) ----
app.get("/healthz", (c) => c.text("ok"));

// ---- ローカル取得ヘルパーの配布物（認証不要）----
// chrome.sockets.tcp 前提を廃止し「拡張機能なしの単体ローカルアプリ」方式
// に確定した（Issue #43 最終コメント）。バイナリ本体は GitHub Releases を
// 第一候補とし、社内 PC から github.com へ到達不可の場合のみ BFF 同梱
// （public/downloads/helper/）にフォールバックする。latest.json は URL と
// sha256 のみを持ち、SPA のセットアップ画面が OS 判定で該当リンクを提示する。
// 専用ルートを切り、未存在は明示 404（SPA fallback で 200+HTML にならないよう）。
const HELPER_DL_DIR = resolve(moduleDir, isBundled ? "../public/downloads/helper" : "./public/downloads/helper");
const HELPER_CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".pkg": "application/octet-stream",
  ".sha256": "text/plain; charset=utf-8",
  ".zip": "application/zip",
};
app.get("/downloads/helper/*", (c) => {
  // パストラバーサル対策: ワイルドカード以降を取り出し、`..` や絶対パスを拒否。
  const rest = c.req.path.slice("/downloads/helper/".length);
  if (!rest || rest.includes("..") || rest.includes("\0") || rest.startsWith("/")) {
    return c.text("Not Found", 404);
  }
  const filePath = resolve(HELPER_DL_DIR, rest);
  // resolve 結果が配布ディレクトリ配下であることを再確認。
  if (!filePath.startsWith(HELPER_DL_DIR)) {
    return c.text("Not Found", 404);
  }
  if (!existsSync(filePath)) {
    return c.text("Not Found", 404);
  }
  // ディレクトリやシンボリックリンクを弾く。readFileSync にディレクトリを渡すと
  // 例外で 500 になるため、通常ファイルのみ許容する。realpathSync でシンボリック
  // リンクを解決した上で配布ディレクトリ配下であることを再確認するとより安全だが、
  // 配布ディレクトリはリリース時のみ更新される静的資産のため、ここでは通常ファイル
  // チェックで十分とする。
  const st = statSync(filePath);
  if (!st.isFile()) {
    return c.text("Not Found", 404);
  }
  const ext = filePath.slice(filePath.lastIndexOf("."));
  const ct = HELPER_CONTENT_TYPES[ext] ?? "application/octet-stream";
  const data = readFileSync(filePath);
  // ファイル名を維持したダウンロード用 Content-Disposition。
  const filename = filePath.slice(filePath.lastIndexOf("/") + 1);
  c.header("Content-Type", ct);
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  return c.body(data);
});

// ---- 機器認証情報の引き換え（ローカル取得ヘルパー専用・Issue #53）----
// ルータの実体と多段の DoS ガードは helperCredentials.ts 側にある。
app.route("/helper", createHelperCredentialsApp(cfg));

// ---- Auth routes ----
app.get("/auth/login", async (c) => {
  if (cfg.authMode === "disabled") return c.redirect("/");
  const session = await getSession(c, oidcSessionOpts);
  const pkce = createPkce();
  const state = createPkce().verifier; // reuse as opaque state token
  session.set("pkceVerifier", pkce.verifier);
  session.set("oauthState", state);
  // Reject protocol-relative (//evil) and absolute URLs. Same rule as the SPA
  // (`safeReturnPath` in @config-manager/shared).
  session.set("returnTo", safeReturnPath(c.req.query("returnTo")));
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
  // Read PKCE state with None so the cookie set during /auth/login is visible
  // after the Entra cross-site redirect.
  const session = await getSession(c, oidcSessionOpts);
  if (state !== session.get("oauthState")) {
    return c.text("OAuth state mismatch", 400);
  }
  const verifier = session.get("pkceVerifier");
  if (!verifier) return c.text("Missing PKCE verifier in session", 400);

  try {
    const tokens = await exchangeCode(cfg, code, verifier);
    const claims = decodeIdToken(tokens.id_token);
    assertIdTokenClaims(claims, cfg);

    // Fetch groups once; used for both the admission gate and RBAC mapping.
    const needGroups =
      cfg.entra.requiredGroupIds.length > 0 || roleGroupsConfigured(cfg);
    const groups = needGroups
      ? await getUserGroups(tokens.access_token)
      : [];

    if (cfg.entra.requiredGroupIds.length > 0) {
      const ok = cfg.entra.requiredGroupIds.some((g) => groups.includes(g));
      if (!ok) {
        return c.text("Access denied: user is not in a required group.", 403);
      }
    }

    const role = resolveRoleFromGroups(groups, cfg);
    if (!role) {
      return c.text(
        "Access denied: user is not in any configured application role group.",
        403,
      );
    }

    const user = toAuthUser(claims, "Unknown operator", role);
    session.set("user", user);
    // Opaque sid enables logout revocation without a shared session store.
    session.set("sid", newSessionId());
    // Capture returnTo BEFORE clearTransient(), which deletes it. Re-sanitize
    // defensively in case an older cookie still holds a pre-hardening value.
    const returnTo = safeReturnPath(session.get("returnTo"));
    // We intentionally do NOT store the access/refresh tokens in the cookie
    // session: they are only needed for the optional group-membership check
    // above, and storing them bloats the encrypted cookie past the 4 KiB
    // browser limit — the browser then silently drops it, causing a 401 loop.
    // If a refresh / Graph call becomes necessary later, move to a shared
    // server-side session store (see docs/SECURITY.md).
    session.clearTransient();
    // Re-seal with SameSite=Lax for the established session (CSRF reduction).
    // The interstitial HTML response is same-origin, so Lax is accepted here.
    session.setSameSite("Lax");
    await session.save();
    // IMPORTANT: return an HTML interstitial that does a same-origin client-side
    // redirect, instead of a 302. When the OIDC callback arrives via a
    // cross-site redirect from login.microsoftonline.com, browsers (Chrome on
    // fly.dev which is in the Public Suffix List, Safari/ITP) sometimes defer
    // or drop Set-Cookie issued alongside a 302 in that chain — which leaves
    // the session cookie unset and /auth/me returns 401 in a loop. Serving a
    // 200 HTML page first lets the Set-Cookie land in a same-origin response,
    // and the subsequent navigation is a normal same-origin request that
    // carries the cookie.
    // No inline <script>: Content-Security-Policy is script-src 'self' only.
    // meta refresh + a plain link are enough for the same-origin handoff.
    return c.html(
      `<!doctype html><html><head><meta charset="utf-8">` +
        `<title>Logging in…</title>` +
        `<meta http-equiv="refresh" content="0;url=${escapeHtml(returnTo)}">` +
        `</head><body>` +
        `<p>ログインしました。続行中…</p>` +
        `<p><a href="${escapeHtml(returnTo)}">進む</a></p>` +
        `</body></html>`,
    );
  } catch (err) {
    console.error("[auth/callback] token exchange failed:", err);
    return c.text("Authentication failed. See server logs.", 500);
  }
});

app.get("/auth/logout", async (c) => {
  if (cfg.authMode === "disabled") return c.redirect("/");
  const session = await getSession(c, establishedSessionOpts);
  // Revoke before destroy so a stolen copy of the cookie cannot outlive logout
  // for the rest of this process lifetime.
  const user = session.get("user");
  revokeSession(session.get("sid"), { email: user?.email });
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
  const session = await getSession(c, establishedSessionOpts);
  if (isSessionRevoked(session.get("sid"))) {
    session.destroy();
    return c.json({ authenticated: false }, 401);
  }
  const user = session.get("user");
  // getSession() already drops payloads without a valid role; re-check here so
  // the admin backfill this replaced (Issue #82) cannot creep back in.
  if (!user || !isAppRole(user.role)) {
    return c.json({ authenticated: false }, 401);
  }
  return c.json({ authenticated: true, user });
});

// ---- Auth guard for /api/* ----
app.use("/api/*", async (c, next) => {
  const session = await getSession(c, establishedSessionOpts);
  let user: AuthUser;
  if (cfg.authMode === "disabled") {
    user = localUser;
  } else {
    if (isSessionRevoked(session.get("sid"))) {
      session.destroy();
      return c.json({ error: "unauthenticated", login: "/auth/login" }, 401);
    }
    const u = session.get("user");
    // A session without a valid role is rejected outright (fail closed): the
    // old behaviour promoted it to admin, so a pre-RBAC cookie granted full
    // privileges (Issue #82). Re-login resolves the real role.
    if (!u || !isAppRole(u.role)) {
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
          `dummy user (${localUser.email}, role=${localUser.role}) is used. NEVER use this in production.`,
      );
    }
    // Production without the mapping never boots (loadConfig throws), so this
    // only fires for local / staging runs.
    if (!roleGroupsConfigured(cfg) && cfg.authMode === "oidc") {
      console.warn(
        "[startup] ENTRA_GROUP_*_IDS are unset — every authenticated user is treated as admin. " +
          "Set ENTRA_GROUP_ADMIN_IDS / OPERATOR / VIEWER to enable RBAC (required in production).",
      );
    }
    if (
      !cfg.credentialsEncryptionKey &&
      cfg.kintone.merakiAppId &&
      cfg.nodeEnv === "production"
    ) {
      console.warn(
        "[startup] CREDENTIALS_ENCRYPTION_KEY is unset while Meraki credentials app is configured. " +
          "API keys will be stored in plaintext in Kintone. Set the key (openssl rand -base64 32).",
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

/** Minimal HTML escaper for interpolating user-controllable paths into the
 *  OIDC callback interstitial page. `returnTo` is sanitized by safeReturnPath
 *  (single-slash app-relative only), but we still escape defensively. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


