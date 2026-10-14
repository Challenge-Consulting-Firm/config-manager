import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Hono } from "hono";
import { createCloudflareOnlyGuard } from "./security.js";

function appWith(enabled: boolean) {
  const app = new Hono();
  app.use("*", createCloudflareOnlyGuard({ enabled }));
  app.get("/healthz", (c) => c.text("ok"));
  app.get("/", (c) => c.text("home"));
  return app;
}

test("CloudflareOnlyGuard: Cloudflare エッジ経由は通す", async () => {
  const res = await appWith(true).request("/", {
    headers: { "fly-client-ip": "172.70.1.2" },
  });
  assert.equal(res.status, 200);
});

test("CloudflareOnlyGuard: fly.dev 直アクセスは Host を偽装しても 403", async () => {
  const res = await appWith(true).request("https://config.ccf.work/", {
    headers: { "fly-client-ip": "203.0.113.5", "cf-connecting-ip": "198.51.100.7" },
  });
  assert.equal(res.status, 403);
});

test("CloudflareOnlyGuard: Fly-Client-IP が無ければ 403", async () => {
  const res = await appWith(true).request("/");
  assert.equal(res.status, 403);
});

test("CloudflareOnlyGuard: /healthz は直アクセスでも通す", async () => {
  const res = await appWith(true).request("/healthz", {
    headers: { "fly-client-ip": "203.0.113.5" },
  });
  assert.equal(res.status, 200);
});

test("CloudflareOnlyGuard: 無効時は何もしない", async () => {
  const res = await appWith(false).request("/");
  assert.equal(res.status, 200);
});
