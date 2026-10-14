import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Hono } from "hono";
import { clientIp, isCloudflareIp } from "./rateLimit.js";

async function ipOf(headers: Record<string, string>): Promise<string> {
  const app = new Hono();
  app.get("/", (c) => c.text(clientIp(c)));
  const res = await app.request("/", { headers });
  return res.text();
}

test("isCloudflareIp: Cloudflare レンジのみ true", () => {
  assert.equal(isCloudflareIp("172.70.1.2"), true);
  assert.equal(isCloudflareIp("2606:4700::1"), true);
  assert.equal(isCloudflareIp("203.0.113.5"), false);
  assert.equal(isCloudflareIp("not-an-ip"), false);
});

test("clientIp: Cloudflare エッジ経由なら CF-Connecting-IP を使う", async () => {
  assert.equal(
    await ipOf({ "fly-client-ip": "172.70.1.2", "cf-connecting-ip": "198.51.100.7" }),
    "198.51.100.7",
  );
});

test("clientIp: fly.dev 直アクセスでは CF-Connecting-IP の偽装を無視する", async () => {
  assert.equal(
    await ipOf({ "fly-client-ip": "203.0.113.5", "cf-connecting-ip": "198.51.100.7" }),
    "203.0.113.5",
  );
});

test("clientIp: Cloudflare エッジでも CF-Connecting-IP が不正なら Fly-Client-IP", async () => {
  assert.equal(
    await ipOf({ "fly-client-ip": "172.70.1.2", "cf-connecting-ip": "garbage" }),
    "172.70.1.2",
  );
});
