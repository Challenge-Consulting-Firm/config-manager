/**
 * Tests for binary config upload / download (Issue #93).
 *
 * AirStation Pro の .bin のようにテキスト化できないコンフィグは
 * multipart でアップロードされ、Kintone の添付ファイル (original_file)
 * として保存される。ここでは:
 *   1. isLikelyBinary の判定（テキスト / NUL 含み / Shift-JIS）
 *   2. POST /api/upload (multipart) から GET /api/versions/:id/file までの
 *      一連の流れを Kintone HTTP をモックして検証する。
 */
import { strict as assert } from "node:assert";
import { connect, type Socket } from "node:net";
import { serve } from "@hono/node-server";
import { test } from "node:test";
import { Hono } from "hono";
import { isLikelyBinary, type AuthUser } from "@config-manager/shared";
import { api } from "./api.js";
import type { AppConfig } from "./config.js";
import type { AppEnv } from "./api.js";

// ---- テスト用設定（Kintone のみ使用。実際の通信は fetch を差し替える） ----
const cfg = {
  port: 3000,
  nodeEnv: "test",
  publicBaseUrl: "http://localhost:3000",
  authMode: "oidc",
  localDevUser: { name: "Test", email: "test@example.com" },
  entra: {
    tenantId: "t",
    clientId: "c",
    clientSecret: "s",
    redirectUri: "",
    requiredGroupIds: [],
    adminGroupIds: ["g-admin"],
    operatorGroupIds: [],
    viewerGroupIds: [],
  },
  localDevRole: "admin",
  sessionSecret: "test-session-secret-at-least-32-characters",
  credentialsEncryptionKey: null,
  kintone: {
    domain: "example.cybozu.com",
    configAppId: "1",
    configAppToken: "config-token",
    auditAppId: "2",
    auditAppToken: "audit-token",
    username: "",
    password: "",
    baseUrl: "https://example.cybozu.com",
    merakiAppId: "",
    merakiAppToken: "",
    customerInfoAppId: "",
    customerInfoAppToken: "",
  },
  commentPrefixes: ["!"],
  meraki: {
    apiKey: "",
    apiBase: "https://api.meraki.com/api/v1",
    timeoutMs: 1000,
    maxRetries: 0,
    sectionConcurrency: 1,
  },
} as unknown as AppConfig;

const operator: AuthUser = {
  displayName: "テスト太郎",
  email: "test@example.com",
  role: "operator",
};

/** /api/* の認可ミドルウェア相当（cfg / user を注入）を備えたテストアプリ。 */
function testApp() {
  const app = new Hono<AppEnv>();
  app.use("/api/*", async (c, next) => {
    c.set("cfg", cfg);
    c.set("session", {} as never);
    c.set("user", operator);
    await next();
  });
  app.route("/api", api);
  return app;
}

// ---- isLikelyBinary（shared） ----

test("isLikelyBinary: 通常のテキストコンフィグはバイナリ扱いしない", () => {
  const text = new TextEncoder().encode(
    "!\nhostname RTR-01\ninterface GigabitEthernet0/0\n ip address 10.0.0.1 255.255.255.0\n",
  );
  assert.equal(isLikelyBinary(text), false);
});

test("isLikelyBinary: NUL バイトを含むデータ（AirStation Pro .bin 等）はバイナリ", () => {
  const bytes = new Uint8Array(1024).fill(0x41);
  bytes[100] = 0x00;
  assert.equal(isLikelyBinary(bytes), true);
});

test("isLikelyBinary: 先頭 8KB に NUL があればバイナリ（巨大ファイル）", () => {
  const bytes = new Uint8Array(64 * 1024).fill(0x42);
  bytes[4_000] = 0x00;
  bytes[20_000] = 0x00; // limit 外は見ない
  assert.equal(isLikelyBinary(bytes), true);
});

test("isLikelyBinary: Shift-JIS の日本語テキストはバイナリ扱いしない", () => {
  // "!\n日本語コメント\nhostname AP-01\n" の Shift-JIS バイト列。
  // (日本語=93fa967b8cea, コメント=8352838183938367)
  // SJIS は NUL を含まず制御文字比率も低いためテキスト判定される。
  const sjis = Buffer.from(
    "210a93fa967b8cea83528381839383670a686f73746e616d652041502d30310a",
    "hex",
  );
  assert.equal(isLikelyBinary(new Uint8Array(sjis)), false);
  // 念のためデコードして意味が通ることも確認。
  assert.ok(sjis.includes(Buffer.from("hostname")));
});

test("isLikelyBinary: 制御文字だらけのデータはバイナリ", () => {
  const bytes = new Uint8Array(1000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = 0x01;
  assert.equal(isLikelyBinary(bytes), true);
});

// ---- multipart アップロード → 添付ダウンロードの E2E（Kintone モック） ----

interface MockCall {
  url: string;
  method: string;
  body: string;
}

/** Kintone の REST を模倣する fetch 差し替え。呼び出し記録を返す。 */
function installKintoneMock(options: {
  existingRecords?: unknown[];
  createdId?: string;
  fileBytes?: Uint8Array;
  fileHeaders?: Record<string, string>;
}) {
  const calls: MockCall[] = [];
  const originalFetch = globalThis.fetch;
  let uploadedFileKey = "";
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: describeBody(init?.body) });
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    // ファイルアップロード（multipart）。
    if (url.endsWith("/k/v1/file.json") && method === "POST") {
      uploadedFileKey = "fk-uploaded-1";
      return json({ fileKey: uploadedFileKey });
    }
    // ファイルダウンロード。
    if (url.includes("/k/v1/file.json?fileKey=")) {
      return new Response(options.fileBytes ?? new Uint8Array([1, 2, 3]), {
        headers: {
          "Content-Type": "application/octet-stream",
          ...options.fileHeaders,
        },
      });
    }
    // レコード系。
    if (url.endsWith("/k/v1/records.json") || url.endsWith("/k/v1/record.json")) {
      const isGet =
        method === "GET" ||
        (init?.headers as Record<string, string>)?.["X-HTTP-Method-Override"] === "GET";
      if (isGet) {
        if (url.endsWith("/record.json")) {
          // getVersionRecord: original_file 添付付きレコード。
          return json({
            record: {
              $id: { value: options.createdId ?? "77" },
              $revision: { value: "1" },
              customer: { value: "テスト顧客" },
              hostname: { value: "AP-01" },
              ip_address: { value: "192.168.1.10" },
              purpose: { value: "" },
              serial_number: { value: "" },
              role: { value: "本番" },
              generation: { value: "1" },
              body: { value: "" },
              hash: { value: "deadbeef" },
              original_file: {
                value: [
                  {
                    fileKey: uploadedFileKey || "fk-uploaded-1",
                    name: "airstation-pro.bin",
                    contentType: "application/octet-stream",
                    size: "1024",
                  },
                ],
              },
            },
          });
        }
        return json({ records: options.existingRecords ?? [] });
      }
      // createVersion / writeAudit は書き込みとみなす。
      return json({ id: options.createdId ?? "77", revision: "1" });
    }
    return json({ error: `unexpected mock url: ${url}` }, 500);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function describeBody(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof FormData) {
    const parts: string[] = [];
    for (const [k, v] of body.entries()) {
      parts.push(`${k}=${v instanceof File ? `(file ${v.name})` : String(v)}`);
    }
    return parts.join("&");
  }
  return "(non-text body)";
}

/** NUL 入りバイナリの File（AirStation Pro エクスポートの代わり）。 */
function fakeBinaryFile(name = "airstation-pro.bin"): File {
  const bytes = new Uint8Array(2048);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
  bytes[10] = 0x00; // NUL → バイナリ判定
  return new File([bytes], name, { type: "application/octet-stream" });
}

test("multipart でバイナリ世代を登録できる", async () => {
  const mock = installKintoneMock({});
  const app = testApp();
  try {
    const form = new FormData();
    form.append("file", fakeBinaryFile());
    form.append("customer", "テスト顧客");
    form.append("hostname", "AP-01");
    form.append("ipAddress", "192.168.1.10");
    form.append("role", "production");

    const res = await app.request("/api/upload", { method: "POST", body: form });
    const json = (await res.json()) as {
      isBinary?: boolean;
      created?: { generation: number; originalFile?: { name: string } };
    };
    assert.equal(res.status, 201, `await 201, got ${res.status}: ${JSON.stringify(json)}`);
    assert.equal(json.isBinary, true);
    assert.equal(json.created?.generation, 1);
    assert.equal(json.created?.originalFile?.name, "airstation-pro.bin");

    // Kintone file.json へのアップロードが行われていること。
    const fileUpload = mock.calls.find(
      (c) => c.url.endsWith("/k/v1/file.json") && c.method === "POST",
    );
    assert.ok(fileUpload, "file upload to Kintone should happen");

    // レコード作成に fileKey が含まれていること。
    const createCall = mock.calls.find(
      (c) =>
        c.url.endsWith("/k/v1/record.json") &&
        c.method === "POST" &&
        c.body.includes('"original_file"'),
    );
    assert.ok(createCall, "record creation should reference original_file");
    assert.match(createCall!.body, /fk-uploaded-1/);
  } finally {
    mock.restore();
  }
});

test("multipart でテキストファイルを送ると 400 で拒否される", async () => {
  const mock = installKintoneMock({});
  const app = testApp();
  try {
    const form = new FormData();
    form.append(
      "file",
      new File([new TextEncoder().encode("hostname RTR-01\n")], "rtr.conf", {
        type: "text/plain",
      }),
    );
    form.append("customer", "テスト顧客");
    form.append("hostname", "RTR-01");
    form.append("ipAddress", "10.0.0.1");
    form.append("role", "production");

    const res = await app.request("/api/upload", { method: "POST", body: form });
    assert.equal(res.status, 400);
    const json = (await res.json()) as { error?: string };
    assert.match(json.error ?? "", /text/);
  } finally {
    mock.restore();
  }
});

test("multipart で許可外の拡張子は 400", async () => {
  const mock = installKintoneMock({});
  const app = testApp();
  try {
    const form = new FormData();
    form.append("file", fakeBinaryFile("payload.exe"));
    form.append("customer", "テスト顧客");
    form.append("hostname", "AP-01");
    form.append("ipAddress", "192.168.1.10");
    form.append("role", "production");

    const res = await app.request("/api/upload", { method: "POST", body: form });
    assert.equal(res.status, 400);
    const json = (await res.json()) as { error?: string };
    assert.match(json.error ?? "", /extension/);
  } finally {
    mock.restore();
  }
});

test("本番機で必須識別子が欠けている場合は 400", async () => {
  const mock = installKintoneMock({});
  const app = testApp();
  try {
    const form = new FormData();
    form.append("file", fakeBinaryFile());
    form.append("customer", "テスト顧客");
    form.append("hostname", ""); // 欠落
    form.append("ipAddress", "192.168.1.10");
    form.append("role", "production");

    const res = await app.request("/api/upload", { method: "POST", body: form });
    assert.equal(res.status, 400);
    const json = (await res.json()) as { error?: string };
    assert.match(json.error ?? "", /required/);
  } finally {
    mock.restore();
  }
});

test("同一ハッシュ（同一バイナリ）の再アップロードはスキップされる", async () => {
  const { createHash } = await import("node:crypto");
  const bytes = new Uint8Array([9, 8, 7, 0]); // NUL 含み → バイナリ
  const hash = createHash("sha256").update(bytes).digest("hex");
  const mock = installKintoneMock({
    existingRecords: [
      {
        $id: { value: "1" },
        generation: { value: "2" },
        hash: { value: hash },
        customer: { value: "テスト顧客" },
        hostname: { value: "AP-01" },
        ip_address: { value: "192.168.1.10" },
        role: { value: "本番" },
      },
    ],
  });
  const app = testApp();
  try {
    const form = new FormData();
    form.append(
      "file",
      new File([bytes], "airstation-pro.bin", {
        type: "application/octet-stream",
      }),
    );
    form.append("customer", "テスト顧客");
    form.append("hostname", "AP-01");
    form.append("ipAddress", "192.168.1.10");
    form.append("role", "production");

    const res = await app.request("/api/upload", { method: "POST", body: form });
    assert.equal(res.status, 200, `await 200 (skip), got ${res.status}`);
    const json = (await res.json()) as { skipped?: boolean; generation?: number };
    assert.equal(json.skipped, true);
    assert.equal(json.generation, 2);
    // ファイルアップロードもレコード作成も行われていないこと。
    assert.equal(
      mock.calls.find((c) => c.url.endsWith("/k/v1/file.json") && c.method === "POST"),
      undefined,
      "identical binary must not be re-uploaded",
    );
  } finally {
    mock.restore();
  }
});

test("GET /api/versions/:id/file は添付バイナリを Content-Disposition 付きで返す", async () => {
  const fileBytes = new Uint8Array([0x00, 0x01, 0x02, 0xff]);
  const mock = installKintoneMock({ fileBytes });
  const app = testApp();
  try {
    const res = await app.request("/api/versions/77/file");
    assert.equal(res.status, 200, `await 200, got ${res.status}`);
    assert.equal(res.headers.get("Content-Type"), "application/octet-stream");
    const disposition = res.headers.get("Content-Disposition") ?? "";
    assert.match(disposition, /^attachment/);
    assert.match(disposition, /airstation-pro\.bin/);
    const buf = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...buf], [...fileBytes]);
  } finally {
    mock.restore();
  }
});

test("上限を超える添付ファイルは読み切らずに 400 (FILE_TOO_LARGE) を返す", async () => {
  // Content-Length の無いストリームでも、受信バイト数で打ち切ること。
  const mock = installKintoneMock({
    fileBytes: new Uint8Array(20 * 1024 * 1024 + 1),
  });
  const app = testApp();
  try {
    const res = await app.request("/api/versions/77/file");
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; code: string };
    assert.equal(body.code, "FILE_TOO_LARGE");
    assert.match(body.error, /大きすぎる/);
  } finally {
    mock.restore();
  }
});

test("Content-Length が上限を超える添付ファイルは本文を読まずに 400 を返す", async () => {
  const mock = installKintoneMock({
    fileBytes: new Uint8Array([1, 2, 3]),
    fileHeaders: { "Content-Length": String(100 * 1024 * 1024) },
  });
  const app = testApp();
  try {
    const res = await app.request("/api/versions/77/file");
    assert.equal(res.status, 400);
  } finally {
    mock.restore();
  }
});

test("送信中のダウンロードは同時実行枠を保持し、送信完了・切断で解放する", async () => {
  const mock = installKintoneMock({ fileBytes: new Uint8Array([1, 2, 3]) });
  const app = testApp();
  try {
    // 本文を読まない（送信が終わらない）レスポンスを上限の 4 件まで溜める。
    const pending: Response[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await app.request("/api/versions/77/file");
      assert.equal(res.status, 200);
      pending.push(res);
    }
    const full = await app.request("/api/versions/77/file");
    assert.equal(full.status, 503);

    // 1 件は読み切り（送信完了）、1 件は切断（cancel）すると 2 枠空く。
    assert.deepEqual([...new Uint8Array(await pending[0].arrayBuffer())], [1, 2, 3]);
    await pending[1].body?.cancel();
    for (let i = 0; i < 2; i++) {
      const res = await app.request("/api/versions/77/file");
      assert.equal(res.status, 200);
      pending.push(res);
    }
    assert.equal((await app.request("/api/versions/77/file")).status, 503);

    for (const res of pending.slice(2)) await res.body?.cancel();
    const after = await app.request("/api/versions/77/file");
    assert.equal(after.status, 200);
    await after.arrayBuffer();
  } finally {
    mock.restore();
  }
});

test("HEAD はファイルを取得せず、同時実行枠も消費しない", async () => {
  const mock = installKintoneMock({ fileBytes: new Uint8Array([1, 2, 3]) });
  const app = testApp();
  try {
    for (let i = 0; i < 6; i++) {
      const res = await app.request("/api/versions/77/file", { method: "HEAD" });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("Content-Disposition") ?? "", /^attachment/);
    }
    assert.equal(
      mock.calls.filter((c) => c.url.includes("/k/v1/file.json?fileKey=")).length,
      0,
    );
    const res = await app.request("/api/versions/77/file");
    assert.equal(res.status, 200);
    await res.arrayBuffer();
  } finally {
    mock.restore();
  }
});

test("取得中・送信前にクライアントが切断したら同時実行枠を返す", async () => {
  const mock = installKintoneMock({ fileBytes: new Uint8Array([1, 2, 3]) });
  const app = testApp();
  try {
    for (let i = 0; i < 6; i++) {
      const controller = new AbortController();
      const res = await app.request("/api/versions/77/file", {
        signal: controller.signal,
      });
      controller.abort();
      // 中断済みでも 200 の応答オブジェクト自体は返るが、本文は読まない。
      assert.ok(res.status === 200 || res.status >= 500);
    }
    const res = await app.request("/api/versions/77/file");
    assert.equal(res.status, 200);
    await res.arrayBuffer();
  } finally {
    mock.restore();
  }
});

test("実サーバーで受信を止めたクライアントは送信完了まで枠を保持し、切断で解放する", async () => {
  // 最後のチャンクが Node の送信バッファに滞留している間も枠を握り続けることを、
  // fetch を使わない生のソケットで確かめる（fetch はモック済みのため）。
  const mock = installKintoneMock({ fileBytes: new Uint8Array(8 * 1024 * 1024) });
  let port = 0;
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: testApp().fetch, port: 0 }, (info) => {
      port = info.port;
      resolve(s);
    });
  });
  const open = (): Socket => {
    const sock = connect(port, "127.0.0.1");
    sock.write("GET /api/versions/77/file HTTP/1.1\r\nHost: localhost\r\n\r\n");
    return sock;
  };
  /** ステータス行だけ読み、以降は受信を止める（遅いクライアントの再現）。 */
  const statusOf = (sock: Socket) =>
    new Promise<number>((resolve) => {
      sock.once("data", (d) => {
        sock.pause();
        resolve(Number(String(d).split(" ")[1]));
      });
    });
  const sockets: Socket[] = [];
  try {
    for (let i = 0; i < 4; i++) {
      const sock = open();
      sockets.push(sock);
      assert.equal(await statusOf(sock), 200);
    }
    // 送信が詰まっている 4 件が枠を握っているので 5 件目は 503。
    const fifth = open();
    sockets.push(fifth);
    assert.equal(await statusOf(fifth), 503);

    for (const sock of sockets) sock.destroy();
    await new Promise((r) => setTimeout(r, 200));
    const after = open();
    sockets.push(after);
    assert.equal(await statusOf(after), 200);
  } finally {
    for (const sock of sockets) sock.destroy();
    await new Promise((r) => server.close(() => r(undefined)));
    mock.restore();
  }
});

test("添付がない世代のファイルダウンロードは 404", async () => {
  // original_file を持たないレコードを返すモック。
  const mock = installKintoneMock({});
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/k/v1/record.json")) {
      return new Response(
        JSON.stringify({
          record: {
            $id: { value: "78" },
            customer: { value: "c" },
            hostname: { value: "h" },
            ip_address: { value: "i" },
            role: { value: "本番" },
            generation: { value: "1" },
            body: { value: "hostname h" },
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    return originalFetch(input);
  }) as typeof fetch;
  const app = testApp();
  try {
    const res = await app.request("/api/versions/78/file");
    assert.equal(res.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
    mock.restore();
  }
});
