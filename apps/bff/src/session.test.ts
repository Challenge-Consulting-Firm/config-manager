import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sealData } from "iron-session";
import { Hono } from "hono";
import {
  SESSION_SCHEMA_VERSION,
  acceptSessionData,
  getSession,
  type SessionData,
  type SessionOptions,
} from "./session.js";
import type { AuthUser } from "@config-manager/shared";

const OPTS: SessionOptions = {
  password: "test-session-secret-at-least-32-characters",
  secure: false,
  sameSite: "Lax",
};

const USER: AuthUser = {
  displayName: "Tester",
  email: "tester@example.com",
  role: "viewer",
};

/** Round-trip an arbitrary payload through a sealed cookie and getSession(). */
async function readBackSealed(payload: unknown): Promise<SessionData> {
  const sealed = await sealData(payload as Record<string, unknown>, {
    password: OPTS.password,
    ttl: 60 * 60,
  });
  const app = new Hono();
  let seen: SessionData = {};
  app.get("/probe", async (c) => {
    seen = (await getSession(c, OPTS)).value;
    return c.body(null, 204);
  });
  await app.request("/probe", { headers: { cookie: `cm_session=${sealed}` } });
  return seen;
}

test("現行バージョンのセッションはそのまま読み戻せる", async () => {
  const seen = await readBackSealed({
    v: SESSION_SCHEMA_VERSION,
    user: USER,
    sid: "sid-1",
  } satisfies SessionData);
  assert.equal(seen.user?.email, USER.email);
  assert.equal(seen.user?.role, "viewer");
  assert.equal(seen.sid, "sid-1");
});

test("version を持たない旧セッションは破棄する", async () => {
  const seen = await readBackSealed({ user: USER, sid: "sid-legacy" });
  assert.deepEqual(seen, {});
});

test("未知の version のセッションは破棄する", async () => {
  const seen = await readBackSealed({
    v: SESSION_SCHEMA_VERSION + 1,
    user: USER,
  });
  assert.deepEqual(seen, {});
});

test("role 欠落セッションは admin へ補完せず破棄する", async () => {
  const seen = await readBackSealed({
    v: SESSION_SCHEMA_VERSION,
    user: { displayName: "Tester", email: "tester@example.com" },
    sid: "sid-2",
  });
  assert.deepEqual(seen, {});
});

test("未知の role 文字列を持つセッションは破棄する", () => {
  const seen = acceptSessionData({
    v: SESSION_SCHEMA_VERSION,
    user: { ...USER, role: "superadmin" as AuthUser["role"] },
  });
  assert.deepEqual(seen, {});
});

test("save() は schema version を書き込む", async () => {
  const app = new Hono();
  app.get("/login", async (c) => {
    const session = await getSession(c, OPTS);
    session.set("user", USER);
    await session.save();
    return c.body(null, 204);
  });
  const res = await app.request("/login");
  const cookie = res.headers.get("set-cookie") ?? "";
  const sealed = /cm_session=([^;]+)/.exec(cookie)?.[1];
  assert.ok(sealed, "セッション cookie が発行されること");

  // Feed the freshly issued cookie back in: it must survive the version check.
  const app2 = new Hono();
  let seen: SessionData = {};
  app2.get("/probe", async (c) => {
    seen = (await getSession(c, OPTS)).value;
    return c.body(null, 204);
  });
  await app2.request("/probe", {
    headers: { cookie: `cm_session=${decodeURIComponent(sealed)}` },
  });
  assert.equal(seen.v, SESSION_SCHEMA_VERSION);
  assert.equal(seen.user?.email, USER.email);
});
