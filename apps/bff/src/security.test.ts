import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Hono } from "hono";
import { createCloudflareOnlyGuard, ORIGIN_VERIFY_HEADER } from "./security.js";

const SECRET = "s".repeat(40);
const CF_IP = "172.70.1.2";
const DIRECT_IP = "203.0.113.5";

function appWith(enabled: boolean) {
  const app = new Hono();
  app.use("*", createCloudflareOnlyGuard({ enabled, originSecret: SECRET }));
  app.get("/healthz", (c) => c.text("ok"));
  app.get("/", (c) => c.text("home"));
  return app;
}

async function statusOf(
  headers: Record<string, string>,
  path = "/",
  enabled = true,
): Promise<number> {
  const res = await appWith(enabled).request(path, { headers });
  return res.status;
}

test("CloudflareOnlyGuard: 自ゾーン経由（Cloudflare IP + 秘密ヘッダ）は通す", async () => {
  assert.equal(
    await statusOf({ "fly-client-ip": CF_IP, [ORIGIN_VERIFY_HEADER]: SECRET }),
    200,
  );
});

test("CloudflareOnlyGuard: 他人の Cloudflare 経由（秘密ヘッダなし）は 403", async () => {
  assert.equal(await statusOf({ "fly-client-ip": CF_IP }), 403);
});

test("CloudflareOnlyGuard: 秘密ヘッダが違えば 403", async () => {
  assert.equal(
    await statusOf({ "fly-client-ip": CF_IP, [ORIGIN_VERIFY_HEADER]: "wrong" }),
    403,
  );
});

test("CloudflareOnlyGuard: fly.dev 直は秘密ヘッダが正しくても 403", async () => {
  assert.equal(
    await statusOf({ "fly-client-ip": DIRECT_IP, [ORIGIN_VERIFY_HEADER]: SECRET }),
    403,
  );
});

test("CloudflareOnlyGuard: Fly-Client-IP が無ければ 403", async () => {
  assert.equal(await statusOf({ [ORIGIN_VERIFY_HEADER]: SECRET }), 403);
});

test("CloudflareOnlyGuard: /healthz は直アクセスでも通す", async () => {
  assert.equal(await statusOf({ "fly-client-ip": DIRECT_IP }, "/healthz"), 200);
});

test("CloudflareOnlyGuard: 無効時は何もしない", async () => {
  assert.equal(await statusOf({}, "/", false), 200);
});
