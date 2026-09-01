import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Hono } from "hono";
import { sealData } from "iron-session";
import type { AppConfig } from "./config.js";
import type { AppEnv } from "./api.js";
import { buildEntraLogoutUrl, createAuthLogoutApp } from "./authLogout.js";
import { createCsrfOriginGuard } from "./security.js";
import { SESSION_SCHEMA_VERSION, type SessionOptions } from "./session.js";
import {
  _resetSessionRegistryForTests,
  isSessionRevoked,
} from "./sessionRegistry.js";

const PUBLIC_BASE_URL = "https://config.example.com";
const SID = "sid-under-test";

const SESSION_OPTS: SessionOptions = {
  password: "test-session-secret-at-least-32-characters",
  secure: true,
  sameSite: "Lax",
};

function cfgWith(authMode: AppConfig["authMode"] = "oidc"): AppConfig {
  return {
    nodeEnv: "production",
    authMode,
    publicBaseUrl: PUBLIC_BASE_URL,
    entra: { tenantId: "tenant-1" },
  } as unknown as AppConfig;
}

/** Mirror index.ts: the CSRF guard runs in front of the logout router. */
function buildApp(cfg: AppConfig = cfgWith()) {
  const app = new Hono<AppEnv>();
  app.use(
    "*",
    createCsrfOriginGuard({
      publicBaseUrl: PUBLIC_BASE_URL,
      nodeEnv: "production",
    }),
  );
  app.route("/auth", createAuthLogoutApp(cfg, SESSION_OPTS));
  return app;
}

async function sessionCookie(): Promise<string> {
  const sealed = await sealData(
    {
      v: SESSION_SCHEMA_VERSION,
      sid: SID,
      user: {
        displayName: "Tester",
        email: "tester@example.com",
        role: "operator",
      },
    },
    { password: SESSION_OPTS.password, ttl: 3600 },
  );
  return `cm_session=${sealed}`;
}

async function post(
  app: ReturnType<typeof buildApp>,
  headers: Record<string, string>,
  body?: string,
) {
  return app.request(`${PUBLIC_BASE_URL}/auth/logout`, {
    method: "POST",
    headers: { ...headers, cookie: await sessionCookie() },
    body,
  });
}

test("GET /auth/logout は副作用を持たず確認ページを返す", async (t) => {
  t.after(_resetSessionRegistryForTests);
  const app = buildApp();
  const res = await app.request(`${PUBLIC_BASE_URL}/auth/logout`, {
    headers: { cookie: await sessionCookie() },
  });

  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<form method="post" action="\/auth\/logout">/);
  assert.equal(res.headers.get("set-cookie"), null, "cookie を消さないこと");
  assert.equal(isSessionRevoked(SID), false, "セッションを revoke しないこと");
});

test("外部 Origin からの POST logout は 403 で拒否する", async (t) => {
  t.after(_resetSessionRegistryForTests);
  const app = buildApp();
  const res = await post(app, {
    origin: "https://evil.example",
    "content-type": "application/json",
  });

  assert.equal(res.status, 403);
  assert.equal(isSessionRevoked(SID), false);
});

test("Origin / Referer の無い POST logout は 403 で拒否する", async (t) => {
  t.after(_resetSessionRegistryForTests);
  const app = buildApp();
  const res = await post(app, { "content-type": "application/json" });

  assert.equal(res.status, 403);
  assert.equal(isSessionRevoked(SID), false);
});

test("same-origin の POST logout は revoke と cookie 削除を行う", async (t) => {
  t.after(_resetSessionRegistryForTests);
  const app = buildApp();
  const res = await post(app, {
    origin: PUBLIC_BASE_URL,
    "content-type": "application/json",
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; redirectTo: string };
  assert.equal(body.ok, true);
  assert.equal(body.redirectTo, buildEntraLogoutUrl(cfgWith()));
  assert.equal(isSessionRevoked(SID), true, "sid が revoke されること");

  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /cm_session=;/, "cookie が削除されること");
});

test("Entra の post logout redirect URI は従来どおり組み立てる", () => {
  const url = buildEntraLogoutUrl(cfgWith());
  assert.ok(
    url.startsWith(
      "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/logout?",
    ),
    url,
  );
  const redirect = new URL(url).searchParams.get("post_logout_redirect_uri");
  assert.equal(redirect, `${PUBLIC_BASE_URL}/`);
});

test("確認ページの form 送信は Entra へ 303 で送る", async (t) => {
  t.after(_resetSessionRegistryForTests);
  const app = buildApp();
  const res = await post(
    app,
    {
      origin: PUBLIC_BASE_URL,
      "content-type": "application/x-www-form-urlencoded",
    },
    "",
  );

  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), buildEntraLogoutUrl(cfgWith()));
  assert.equal(isSessionRevoked(SID), true);
});

test("AUTH_MODE=disabled ではセッション操作をせずトップへ戻す", async (t) => {
  t.after(_resetSessionRegistryForTests);
  const app = buildApp(cfgWith("disabled"));

  const get = await app.request(`${PUBLIC_BASE_URL}/auth/logout`);
  assert.equal(get.status, 302);
  assert.equal(get.headers.get("location"), "/");

  const res = await post(app, {
    origin: PUBLIC_BASE_URL,
    "content-type": "application/json",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, redirectTo: "/" });
  assert.equal(isSessionRevoked(SID), false);
});
