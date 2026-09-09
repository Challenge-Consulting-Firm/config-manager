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
        headers: { "Content-Type": "application/octet-stream" },
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
