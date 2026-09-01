import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AppConfig } from "./config.js";
import {
  REDEEM_MAX_BODY_BYTES,
  REDEEM_MAX_CONCURRENCY,
  REDEEM_RATE_LIMIT_PER_MIN,
  createHelperCredentialsApp,
  type HelperCredentialsDeps,
} from "./helperCredentials.js";
import {
  clearNodeCredentialTokens,
  issueNodeCredentialToken,
} from "./nodeCredentialTokens.js";

const cfg = {} as AppConfig;

const SECRET = {
  username: "admin",
  password: "s3cret",
  customerName: "顧客A",
  nodeName: "rtr-01",
  ipAddress: "10.0.0.1",
};

interface Calls {
  loadSecret: number;
  audit: number;
}

/** Build the router with fake Kintone deps and a call counter. */
function setup(
  overrides: Partial<HelperCredentialsDeps> = {},
): { app: ReturnType<typeof createHelperCredentialsApp>; calls: Calls } {
  const calls: Calls = { loadSecret: 0, audit: 0 };
  const deps: HelperCredentialsDeps = {
    loadSecret: async () => {
      calls.loadSecret += 1;
      return SECRET;
    },
    writeAudit: async () => {
      calls.audit += 1;
    },
    ...overrides,
  };
  return { app: createHelperCredentialsApp(cfg, deps), calls };
}

/** Each test uses its own client IP so the shared rate-limit buckets do not mix. */
function redeem(
  app: ReturnType<typeof createHelperCredentialsApp>,
  body: string,
  ip: string,
) {
  return app.request("/credentials/redeem", {
    method: "POST",
    headers: { "content-type": "application/json", "fly-client-ip": ip },
    body,
  });
}

function issue() {
  return issueNodeCredentialToken({
    credentialId: "1",
    stripInvisible: false,
    operator: "Tester",
    operatorEmail: "tester@example.com",
    target: { customer: "顧客A", hostname: "rtr-01", ipAddress: "10.0.0.1" },
  }).token;
}

test("正規トークンは一度だけ引き換えられる", async (t) => {
  t.after(clearNodeCredentialTokens);
  const { app, calls } = setup();
  const token = issue();

  const ok = await redeem(app, JSON.stringify({ token }), "203.0.113.1");
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), {
    username: SECRET.username,
    password: SECRET.password,
  });
  assert.equal(calls.loadSecret, 1);
  assert.equal(calls.audit, 1);

  // 2 回目は使用済みとして拒否され、Kintone にも触れない。
  const replay = await redeem(app, JSON.stringify({ token }), "203.0.113.1");
  assert.equal(replay.status, 401);
  assert.equal(calls.loadSecret, 1);
});

test("body 上限を超える要求は 413 で拒否する", async () => {
  const { app, calls } = setup();
  const body = JSON.stringify({ token: "A".repeat(REDEEM_MAX_BODY_BYTES * 8) });
  assert.ok(body.length > REDEEM_MAX_BODY_BYTES);

  const res = await redeem(app, body, "203.0.113.2");
  assert.equal(res.status, 413);
  assert.equal(calls.loadSecret, 0, "Kintone を呼ばずに落ちること");
});

test("形式が不正な token は Kintone に触れず 401 で拒否する", async () => {
  const { app, calls } = setup();
  // 上限内に収まる長さでも、正規トークン（43 文字 Base64URL）ではない。
  for (const token of ["A".repeat(500), "short", "!".repeat(43), ""]) {
    const res = await redeem(
      app,
      JSON.stringify({ token }),
      "203.0.113.3",
    );
    assert.equal(res.status, token ? 401 : 400, `token=${token.slice(0, 8)}`);
  }
  assert.equal(calls.loadSecret, 0);
});

test("不正 token の応答は未知・使用済みと区別できない", async (t) => {
  t.after(clearNodeCredentialTokens);
  const { app } = setup();
  const malformed = await redeem(
    app,
    JSON.stringify({ token: "A".repeat(100) }),
    "203.0.113.4",
  );
  // 形式は正しいが発行されていないトークン。
  const unknown = await redeem(
    app,
    JSON.stringify({ token: "x".repeat(43) }),
    "203.0.113.4",
  );
  assert.equal(malformed.status, unknown.status);
  assert.deepEqual(await malformed.json(), await unknown.json());
});

test("同時実行が上限を超えると 503 で即座に落とす", async (t) => {
  t.after(clearNodeCredentialTokens);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { app } = setup({
    loadSecret: async () => {
      await gate;
      return SECRET;
    },
  });

  const overflow = 2;
  const tokens = Array.from(
    { length: REDEEM_MAX_CONCURRENCY + overflow },
    issue,
  );
  const responses = tokens.map((token, i) =>
    redeem(app, JSON.stringify({ token }), `198.51.100.${i}`),
  );
  // 上限を超えた分は待たされずに 503 が返る。
  const shed = await Promise.all(responses.slice(REDEEM_MAX_CONCURRENCY));
  for (const res of shed) {
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "1");
  }

  release();
  const admitted = await Promise.all(
    responses.slice(0, REDEEM_MAX_CONCURRENCY),
  );
  for (const res of admitted) assert.equal(res.status, 200);
});

test("同一 IP からの過剰要求は 429 になる", async () => {
  const { app } = setup();
  const ip = "192.0.2.10";
  const body = JSON.stringify({ token: "z".repeat(43) });

  for (let i = 0; i < REDEEM_RATE_LIMIT_PER_MIN; i += 1) {
    const res = await redeem(app, body, ip);
    assert.equal(res.status, 401, `${i} 回目は上限内`);
  }
  const limited = await redeem(app, body, ip);
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get("retry-after"));

  // 別 IP は影響を受けない。
  const other = await redeem(app, body, "192.0.2.11");
  assert.equal(other.status, 401);
});

test("監査を書けないときは平文を返さず 503 にする", async (t) => {
  t.after(clearNodeCredentialTokens);
  const { app } = setup({
    writeAudit: async () => {
      throw new Error("kintone down");
    },
  });
  const res = await redeem(
    app,
    JSON.stringify({ token: issue() }),
    "192.0.2.20",
  );
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: string };
  assert.ok(!body.error.includes(SECRET.password));
});
