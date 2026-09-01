import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Hono } from "hono";
import {
  LOGGED_QUERY_PARAMS,
  accessLogger,
  formatLoggedPath,
  sanitizeLogValue,
} from "./accessLog.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "./api.js";

/** Drive one request through the logger and collect what it wrote. */
async function logLines(
  path: string,
  status: ContentfulStatusCode = 200,
): Promise<string[]> {
  const lines: string[] = [];
  const app = new Hono<AppEnv>();
  app.use("*", accessLogger((m) => lines.push(m)));
  app.all("*", (c) => c.text("ok", status));
  await app.request(path);
  return lines;
}

test("OIDC callback の code / state はログに残らない", async () => {
  const lines = await logLines(
    "/auth/callback?code=super-secret-auth-code&state=csrf-state-value",
  );
  assert.equal(lines.length, 2, "incoming / outgoing の 2 行");
  for (const line of lines) {
    assert.ok(!line.includes("super-secret-auth-code"), line);
    assert.ok(!line.includes("csrf-state-value"), line);
    assert.ok(!line.includes("code="), line);
    assert.ok(!line.includes("state="), line);
    assert.ok(line.includes("/auth/callback"), line);
  }
});

test("検索語 q と業務データはログに残らない", async () => {
  const lines = await logLines(
    "/api/search?q=admin-password&customer=顧客A&hostname=rtr-01&ip=10.0.0.1",
  );
  for (const line of lines) {
    for (const leak of ["admin-password", "顧客A", "rtr-01", "10.0.0.1"]) {
      assert.ok(!line.includes(leak), `${leak} が ${line} に残っている`);
    }
    // pathname だけが残り、query は丸ごと落ちる。
    assert.ok(line.includes("/api/search"), line);
    assert.ok(!line.includes("?"), line);
  }
});

test("運用に必要な method / pathname / status / 処理時間は残る", async () => {
  const lines = await logLines("/api/devices?customer=顧客A", 500);
  assert.match(lines[0] ?? "", /^<-- GET \/api\/devices$/);
  assert.match(lines[1] ?? "", /^--> GET \/api\/devices 500 \d+ms$/);
});

test("allowlist の query だけは値ごと残る", async () => {
  const lines = await logLines("/api/search?q=secret&limit=50&scope=latest");
  for (const line of lines) {
    assert.ok(line.includes("limit=50"), line);
    assert.ok(line.includes("scope=latest"), line);
    assert.ok(!line.includes("secret"), line);
  }
});

test("allowlist に機密になり得る項目が紛れ込んでいない", () => {
  for (const forbidden of [
    "q",
    "code",
    "state",
    "returnTo",
    "customer",
    "hostname",
    "ip",
    "token",
  ]) {
    assert.ok(
      !LOGGED_QUERY_PARAMS.includes(forbidden),
      `${forbidden} を allowlist に入れてはならない`,
    );
  }
});

test("改行を含む値でログ行を偽造できない", () => {
  assert.equal(sanitizeLogValue("50\n<-- GET /forged"), "50<-- GET /forged");
  // %0A は URLSearchParams で改行に戻るため、出力側で落とす必要がある。
  const logged = formatLoggedPath("https://h/api/search?limit=1%0A%3C--+GET+/x");
  assert.ok(!logged.includes("\n"), logged);
  assert.equal(logged, "/api/search?limit=1<-- GET /x");
});

test("極端に長い値と path は切り詰める", () => {
  const long = formatLoggedPath(`https://h/api/search?limit=${"9".repeat(200)}`);
  assert.ok(long.length < 100, long);
  assert.ok(long.includes("…"));

  const deep = formatLoggedPath(`https://h/${"a".repeat(600)}`);
  assert.ok(deep.length <= 258, `${deep.length}`);
});

test("query が無い場合は pathname だけを返す", () => {
  assert.equal(formatLoggedPath("https://h/healthz"), "/healthz");
});

test("解釈できない URL は固定文字列にする", () => {
  assert.equal(formatLoggedPath("not-a-url"), "(unparsable)");
});
