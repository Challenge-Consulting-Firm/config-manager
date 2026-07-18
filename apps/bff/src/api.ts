/**
 * API routes (all mounted under /api). Every route requires an authenticated
 * session established by the /auth/* routes.
 */

import { Hono } from "hono";
import type { AppConfig } from "./config.js";
import type { KintoneRecord } from "./kintone.js";
import type { Session } from "./session.js";
import {
  createVersion,
  detectedFromRecord,
  getVersionRecord,
  getFwCacheRaw,
  getRoutingCacheRaw,
  identifiersFromRecord,
  latestGenerationFor,
  listAudit,
  listConfigRecords,
  listVersions,
  setFwCache,
  setRoutingCache,
  writeAudit,
  createMerakiCredential,
  deleteMerakiCredential,
  deleteVersion,
  getMerakiCredential,
  isEnabledMerakiCredentials,
  listMerakiCredentials,
  updateMerakiCredential,
  updateVersionMeta,
} from "./kintone.js";
import {
  diffConfigs,
  diffFirewallRules,
  diffRoutingRoutes,
  detectDeviceInfo,
  extractFirewallRules,
  extractRoutingRoutes,
  normalizeConfig,
  parseFirewallCache,
  parseRoutingCache,
  serializeFirewallRules,
  serializeMerakiConfig,
  serializeRoutingRoutes,
  summarizeMerakiImport,
} from "@config-manager/shared";
import type {
  AuthUser,
  ConfigSearchHit,
  ConfigVersion,
  Device,
  FirewallRule,
  Role,
  RoutingRoute,
} from "@config-manager/shared";
import { fetchMerakiConfig } from "./meraki.js";

interface Env {
  Variables: {
    cfg: AppConfig;
    session: Session;
    user: AuthUser;
  };
}

export type AppEnv = Env;

export const api = new Hono<Env>();

/** GET /api/me — current authenticated user. */
api.get("/me", (c) => c.json(c.var.user));

/** GET /api/devices — list logical devices (grouped from all versions).
 *  Query params: customer, hostname, role (optional filters). */
api.get("/devices", async (c) => {
  const cfg = c.var.cfg;
  const { customer, hostname, role } = c.req.query();
  const versions = await listVersions(cfg, {
    customer: customer || undefined,
    hostname: hostname || undefined,
    role: (role as Role) || undefined,
  });

  // Fetch identifiers for each version by reading its record.
  // For performance we cache by id.
  const idCache = new Map<string, ReturnType<typeof identifiersFromRecord>>();
  const devices = new Map<string, Device>();
  for (const v of versions) {
    let ids = idCache.get(v.id);
    if (!ids) {
      const rec = await getVersionRecord(cfg, v.id);
      if (!rec) continue;
      ids = identifiersFromRecord(rec);
      idCache.set(v.id, ids);
    }
    // Production and spare are distinct devices even with the same hostname.
    const key = `${ids.customer}|${ids.hostname}|${ids.ipAddress}|${ids.role}`;
    const existing = devices.get(key);
    if (!existing) {
      devices.set(key, {
        id: key,
        identifiers: ids,
        latestGeneration: v.generation,
        latestHash: v.hash,
        latestVersionId: v.id,
        lastUpdatedAt: v.createdAt,
        lastOperator: v.operator,
        versionCount: 1,
      });
    } else {
      existing.versionCount++;
      if (v.generation > existing.latestGeneration) {
        existing.latestGeneration = v.generation;
        existing.latestHash = v.hash;
        existing.latestVersionId = v.id;
        existing.lastUpdatedAt = v.createdAt;
        existing.lastOperator = v.operator;
      }
    }
  }
  return c.json({ devices: [...devices.values()] });
});

/** GET /api/devices/:key/versions — list versions for a device.
 *  key format: customer|hostname|ipAddress|role */
api.get("/devices/:key/versions", async (c) => {
  const cfg = c.var.cfg;
  const key = c.req.param("key");
  const [customer, hostname, ipAddress, role] = key.split("|");
  const versions = await listVersions(cfg, {
    customer,
    hostname,
    ipAddress,
    role: (role as Role) || undefined,
  });
  return c.json({ versions });
});

/** GET /api/versions/:id — fetch a single version's full body. */
api.get("/versions/:id", async (c) => {
  const cfg = c.var.cfg;
  const id = c.req.param("id");
  const rec = await getVersionRecord(cfg, id);
  if (!rec) return c.json({ error: "not found" }, 404);

  const val = (k: string) => rec[k]?.value ?? "";
  const body = val("body");
  const ids = identifiersFromRecord(rec);
  const version: ConfigVersion = {
    id: rec.$id.value,
    generation: Number.parseInt(val("generation"), 10) || 0,
    body,
    hash: val("hash"),
    operator: val("operator"),
    operatorEmail: val("operator_email"),
    createdAt: new Date(val("作成日時") || Date.now()).getTime(),
    note: val("note") || undefined,
    size: Number.parseInt(val("size"), 10) || 0,
    lines: Number.parseInt(val("lines"), 10) || 0,
    role: ids.role,
    detected: detectedFromRecord(rec),
  };

  // Audit: record a view event (best-effort).
  await writeAudit(cfg, {
    operator: c.var.user.displayName,
    operatorEmail: c.var.user.email,
    action: "view",
    customer: ids.customer,
    hostname: ids.hostname,
    generation: version.generation,
  });

  return c.json({ version, identifiers: ids });
});

/** GET /api/versions/:id/firewall — cached firewall rules. Returns the
 *  persisted extraction result; if missing or stale (body hash mismatch),
 *  recomputes on the fly and persists for next time. This keeps the matrix
 *  page fast regardless of config size or rule count. */
api.get("/versions/:id/firewall", async (c) => {
  const cfg = c.var.cfg;
  const id = c.req.param("id");
  const rec = await getVersionRecord(cfg, id);
  if (!rec) return c.json({ error: "not found" }, 404);

  const val = (k: string) => rec[k]?.value ?? "";
  const hash = val("hash");
  const rawBody = val("body");
  const detected = detectedFromRecord(rec);

  // Try the cache first.
  let rules = parseFirewallCache(getFwCacheRaw(rec), hash);
  let fromCache = rules !== null;
  if (rules === null) {
    // Cache miss: recompute and persist.
    rules = extractFirewallRules(rawBody, detected);
    void setFwCache(cfg, id, serializeFirewallRules(rules, hash));
    fromCache = false;
  }

  return c.json({ rules, fromCache, count: rules.length });
});

/** GET /api/versions/:id/routing — cached routing routes. Returns the
 *  persisted extraction result; if missing or stale (body hash mismatch),
 *  recomputes on the fly and persists for next time. This keeps the routing
 *  page fast regardless of config size or route count. */
api.get("/versions/:id/routing", async (c) => {
  const cfg = c.var.cfg;
  const id = c.req.param("id");
  const rec = await getVersionRecord(cfg, id);
  if (!rec) return c.json({ error: "not found" }, 404);

  const val = (k: string) => rec[k]?.value ?? "";
  const hash = val("hash");
  const rawBody = val("body");
  const detected = detectedFromRecord(rec);

  // Try the cache first.
  let routes = parseRoutingCache(getRoutingCacheRaw(rec), hash);
  let fromCache = routes !== null;
  if (routes === null) {
    // Cache miss: recompute and persist.
    routes = extractRoutingRoutes(rawBody, detected);
    void setRoutingCache(cfg, id, serializeRoutingRoutes(routes, hash));
    fromCache = false;
  }

  return c.json({ routes, fromCache, count: routes.length });
});

interface UploadBody {
  customer?: string;
  hostname?: string;
  ipAddress?: string;
  purpose?: string;
  serialNumber?: string;
  role?: Role;
  body?: string;
  note?: string;
}

const textField = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/** POST /api/upload — normalize + persist a new config generation. */
api.post("/upload", async (c) => {
  const cfg = c.var.cfg;
  const payload = await c.req.json<UploadBody>().catch(() => null);
  if (!payload) return c.json({ error: "invalid JSON body" }, 400);
  const customer = textField(payload.customer);
  const inputHostname = textField(payload.hostname);
  const inputIpAddress = textField(payload.ipAddress);
  const purpose = textField(payload.purpose);
  const body = typeof payload.body === "string" ? payload.body : "";
  const note = typeof payload.note === "string" ? payload.note : undefined;
  const role: Role = payload.role === "spare" ? "spare" : "production";
  const serialNumber = textField(payload.serialNumber);

  if (!body || body.trim().length === 0) {
    return c.json({ error: "body is empty" }, 400);
  }

  // Detect vendor/OS/model/hostname/IP from the RAW body before validating
  // hostname/IP. This lets the BFF recover even if the browser-side detection is
  // stale or the caller leaves those fields blank.
  const detected = detectDeviceInfo(body);
  const hostname = inputHostname || detected.hostname || "";
  const ipAddress = inputIpAddress || detected.ipAddress || "";

  if (!customer || !hostname || !ipAddress) {
    return c.json(
      {
        error: "customer, hostname, ipAddress are required",
        detected,
      },
      400,
    );
  }

  const normalized = await normalizeConfig(body, {
    commentPrefixes: cfg.commentPrefixes,
  });
  // Extract firewall rules once at upload time and cache them so that the
  // matrix page does not need to re-parse on every view.
  const fwRules = extractFirewallRules(body, detected);
  const fwRulesJson = serializeFirewallRules(fwRules, normalized.hash);
  // Likewise extract routing info once at upload time.
  const routingRoutes = extractRoutingRoutes(body, detected);
  const routingRoutesJson = serializeRoutingRoutes(routingRoutes, normalized.hash);

  // Detect an unchanged config (same hash as latest) and short-circuit.
  const prevGen = await latestGenerationFor(cfg, { customer, hostname, ipAddress, role });
  const prevVersions = await listVersions(cfg, { customer, hostname, ipAddress, role });
  const latest = prevVersions.find((v) => v.generation === prevGen);
  if (latest && latest.hash === normalized.hash) {
    return c.json({
      skipped: true,
      reason: "No changes since the latest generation.",
      generation: latest.generation,
      hash: latest.hash,
    });
  }

  const nextGen = prevGen + 1;
  const created = await createVersion(cfg, {
    identifiers: { customer, hostname, ipAddress, purpose, serialNumber, role },
    generation: nextGen,
    body: normalized.body,
    hash: normalized.hash,
    size: normalized.size,
    lines: normalized.lines,
    operator: c.var.user.displayName,
    operatorEmail: c.var.user.email,
    note,
    detected,
    fwRulesJson,
    routingRoutesJson,
  });

  await writeAudit(cfg, {
    operator: c.var.user.displayName,
    operatorEmail: c.var.user.email,
    action: "upload",
    customer,
    hostname,
    generation: nextGen,
    detail: `Uploaded ${role === "spare" ? "spare" : "production"} generation ${nextGen}; removed ${normalized.strippedLines} comment/blank lines.`,
  });

  return c.json({ created, strippedLines: normalized.strippedLines }, 201);
});

interface PromoteBody {
  sourceVersionId: string;
  ipAddress: string;
  note?: string;
}

/** POST /api/promote — register a spare's latest config as a new production
 *  generation. Used when a spare device is swapped in to replace a failed
 *  production device. The serial number and config body are carried over from
 *  the source (spare) version; the caller supplies the production IP. */
api.post("/promote", async (c) => {
  const cfg = c.var.cfg;
  const payload = await c.req.json<PromoteBody>().catch(() => null);
  if (!payload || !payload.sourceVersionId || !payload.ipAddress) {
    return c.json({ error: "sourceVersionId and ipAddress are required" }, 400);
  }
  const rec = await getVersionRecord(cfg, payload.sourceVersionId);
  if (!rec) return c.json({ error: "source version not found" }, 404);
  const src = identifiersFromRecord(rec);
  if (src.role !== "spare") {
    return c.json({ error: "source version is not a spare" }, 400);
  }
  const val = (k: string) => rec[k]?.value ?? "";
  const body = val("body");
  const hash = val("hash");
  const lines = Number.parseInt(val("lines"), 10) || 0;
  const size = Number.parseInt(val("size"), 10) || 0;
  const detected = detectedFromRecord(rec);

  const target = {
    customer: src.customer,
    hostname: src.hostname,
    ipAddress: payload.ipAddress,
    purpose: src.purpose,
    serialNumber: src.serialNumber,
    role: "production" as Role,
  };

  // Skip if production already has this exact config.
  const prevGen = await latestGenerationFor(cfg, target);
  const prevVersions = await listVersions(cfg, target);
  const latest = prevVersions.find((v) => v.generation === prevGen);
  if (latest && latest.hash === hash) {
    return c.json({
      skipped: true,
      reason: "Production already has this config as its latest generation.",
      generation: latest.generation,
    });
  }

  const nextGen = prevGen + 1;
  const created = await createVersion(cfg, {
    identifiers: target,
    generation: nextGen,
    body,
    hash,
    size,
    lines,
    operator: c.var.user.displayName,
    operatorEmail: c.var.user.email,
    note: payload.note ?? `Promoted from spare (serial ${src.serialNumber || "-"})`,
    detected,
    fwRulesJson: serializeFirewallRules(extractFirewallRules(body, detected), hash),
    routingRoutesJson: serializeRoutingRoutes(extractRoutingRoutes(body, detected), hash),
  });

  await writeAudit(cfg, {
    operator: c.var.user.displayName,
    operatorEmail: c.var.user.email,
    action: "upload",
    customer: target.customer,
    hostname: target.hostname,
    generation: nextGen,
    detail: `Promoted spare (serial ${src.serialNumber || "-"}) to production at ${payload.ipAddress}, generation ${nextGen}.`,
  });

  return c.json({ created }, 201);
});

interface MerakiImportBody {
  networkId: string;
  apiKey?: string;
  /** 登録済み Meraki 接続情報のレコード ID。指定時は networkId/apiKey
   *  より優先され、さらにデフォルト顧客・ホスト名も補完に使う。 */
  credentialId?: string;
  customer: string;
  hostname: string;
  ipAddress?: string;
  purpose?: string;
  serialNumber?: string;
  role?: Role;
  note?: string;
}

/** POST /api/meraki/import — Meraki Dashboard API から対象ネットワークの
 *  設定を取得し、通常のコンフィグ世代として新規登録する。
 *
 *  処理フローは通常アップロードと同一で、取得した設定をテキストへ
 *  シリアライズしたうえで normalizeConfig → 重複スキップ判定 →
 *  createVersion → writeAudit に渡す。これにより、既存の Diff 表示・
 *  FW/ルーティング抽出・監査ログ・本番/予備管理をすべて再利用できる。
 *
 *  認証情報の優先順位: credentialId > 要求ボディ (networkId/apiKey) >
 *  環境変数 MERAKI_API_KEY（apiKey のみ）。credentialId 指定時は、
 *  customer/hostname が未入力ならデフォルト値で補完する。 */
api.post("/meraki/import", async (c) => {
  const cfg = c.var.cfg;
  const payload = await c.req.json<MerakiImportBody>().catch(() => null);
  if (!payload) return c.json({ error: "invalid JSON body" }, 400);

  // 1. 認証情報を解決。credentialId 指定時は Kintone から取得し、networkId /
  //    apiKey / デフォルト識別子を上書き優先する。
  let resolvedNetworkId = textField(payload.networkId);
  let resolvedApiKey = textField(payload.apiKey);
  let defaultCustomer = "";
  let defaultHostname = "";
  const credentialId = textField(payload.credentialId);
  if (credentialId) {
    if (!isEnabledMerakiCredentials(cfg)) {
      return c.json(
        { error: "Meraki 接続情報アプリが未設定です（credentialId を使うには KINTONE_MERAKI_APP_ID が必要です）" },
        400,
      );
    }
    const cred = await getMerakiCredential(cfg, credentialId);
    if (!cred) {
      return c.json({ error: `Meraki 接続情報が見つかりません (id=${credentialId})` }, 404);
    }
    resolvedNetworkId = cred.networkId;
    resolvedApiKey = cred.apiKey;
    defaultCustomer = cred.defaultCustomer ?? "";
    defaultHostname = cred.defaultHostname ?? "";
  }
  // 要求ボディの apiKey が未指定なら環境変数へフォールバック。
  if (!resolvedApiKey) resolvedApiKey = cfg.meraki.apiKey;

  if (!resolvedNetworkId) {
    return c.json({ error: "networkId または credentialId は必須です" }, 400);
  }
  if (!resolvedApiKey) {
    return c.json(
      {
        error:
          "Meraki API キーが指定されていません（credentialId / 要求ボディ apiKey / 環境変数 MERAKI_API_KEY のいずれかが必要です）",
      },
      400,
    );
  }

  // 2. 識別子を確定。credentialId 由来のデフォルト → 要求ボディ順で優先。
  const customer = textField(payload.customer) || defaultCustomer;
  const hostname = textField(payload.hostname) || defaultHostname;
  const ipAddress = textField(payload.ipAddress);
  const purpose = textField(payload.purpose);
  const serialNumber = textField(payload.serialNumber);
  const note =
    typeof payload.note === "string" ? payload.note : undefined;
  const role: Role = payload.role === "spare" ? "spare" : "production";

  if (!customer || !hostname) {
    return c.json(
      { error: "customer, hostname は必須です（credentialId のデフォルト値または要求ボディで指定してください）" },
      400,
    );
  }

  // 3. Meraki API から取得。ネットワークが取れない場合は例外が飛ぶので
  //    クライアントへ 502 扱いで返す。
  let fetchResult;
  try {
    fetchResult = await fetchMerakiConfig(resolvedNetworkId, resolvedApiKey, {
      apiBase: cfg.meraki.apiBase,
      timeoutMs: cfg.meraki.timeoutMs,
      maxRetries: cfg.meraki.maxRetries,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Meraki API 取得失敗: ${msg}` }, 502);
  }
  const { dump } = fetchResult;
  const summary = summarizeMerakiImport(dump);

  // 4. コンフィグ本文をテキスト化し、以降は通常アップロードと同じフロー。
  const rawBody = serializeMerakiConfig(dump);
  const detected = detectDeviceInfo(rawBody);
  const normalized = await normalizeConfig(rawBody, {
    commentPrefixes: cfg.commentPrefixes,
  });
  const fwRules = extractFirewallRules(rawBody, detected);
  const fwRulesJson = serializeFirewallRules(fwRules, normalized.hash);
  const routingRoutes = extractRoutingRoutes(rawBody, detected);
  const routingRoutesJson = serializeRoutingRoutes(routingRoutes, normalized.hash);

  // IP はユーザー入力を優先。未入力時は以下の優先順位で補完:
  //   1. lanIp (プライベート IP / VLAN のゲートウェイ IP 等) - 既定で推奨
  //   2. publicIp (WAN 側 IP / uplinks/statuses から取得)
  // プライベート IP が一般的な運用 IP であるため、lanIp を優先する。
  const resolvedIp =
    ipAddress ||
    dump.devices.find((d) => d.lanIp)?.lanIp ||
    dump.devices.find((d) => d.publicIp)?.publicIp ||
    "";

  // Kintone のコンフィグ管理アプリは ip_address を必須項目としているため、
  // 補完後も空の場合は早期エラーにする。放置すると createVersion が 400 になり、
  // Hono のデフォルトエラーハンドラから "Internal Server Error" が返って
  // クライアント側の JSON パースを壊す原因になる。
  if (!resolvedIp) {
    return c.json(
      {
        error:
          "IPアドレスが取得できませんでした。取得画面で明示的に入力するか、ネットワーク内のデバイスに lanIp/publicIp が設定されているか確認してください。",
        summary,
        network: {
          id: dump.network.id,
          name: dump.network.name,
          productTypes: dump.network.productTypes,
        },
      },
      400,
    );
  }

  const identifiers = {
    customer,
    hostname,
    ipAddress: resolvedIp,
    purpose: purpose || `Meraki network ${dump.network.name} (${dump.network.id})`,
    // シリアル番号はユーザー入力を優先。未入力時はネットワーク内の最初の
    // デバイス (通常は MX appliance) のシリアルを補完。ネットワーク単位で
    // 取得しているため代表 1 件のみ採録する。
    serialNumber: serialNumber || dump.devices.find((d) => d.serial)?.serial || "",
    role,
  };

  const prevGen = await latestGenerationFor(cfg, identifiers);
  const prevVersions = await listVersions(cfg, identifiers);
  const latest = prevVersions.find((v) => v.generation === prevGen);
  if (latest && latest.hash === normalized.hash) {
    return c.json({
      skipped: true,
      reason: "最新世代と同一のコンフィグです。新世代は作成されませんでした。",
      generation: latest.generation,
      hash: latest.hash,
      summary,
      network: {
        id: dump.network.id,
        name: dump.network.name,
        productTypes: dump.network.productTypes,
      },
    });
  }

  const nextGen = prevGen + 1;
  const created = await createVersion(cfg, {
    identifiers,
    generation: nextGen,
    body: normalized.body,
    hash: normalized.hash,
    size: normalized.size,
    lines: normalized.lines,
    operator: c.var.user.displayName,
    operatorEmail: c.var.user.email,
    note:
      note ??
      `Meraki import: network=${dump.network.name} (${dump.network.id}), devices=${summary.deviceCount}, failedSections=${summary.failedSections}`,
    detected,
    fwRulesJson,
    routingRoutesJson,
  });

  await writeAudit(cfg, {
    operator: c.var.user.displayName,
    operatorEmail: c.var.user.email,
    action: "upload",
    customer,
    hostname,
    generation: nextGen,
    detail:
      `Meraki import: network=${dump.network.name} (${dump.network.id}); ` +
      `products=${dump.network.productTypes.join(",")}; ` +
      `devices=${summary.deviceCount}; failedSections=${summary.failedSections}`,
  });

  return c.json(
    {
      created,
      strippedLines: normalized.strippedLines,
      summary,
      network: {
        id: dump.network.id,
        name: dump.network.name,
        productTypes: dump.network.productTypes,
      },
    },
    201,
  );
});

// ===== Meraki credentials (CRUD) =====
// これらのエンドポイントは KINTONE_MERAKI_APP_ID が未設定の場合 503 を返す。

interface MerakiCredentialBody {
  label?: string;
  networkId?: string;
  apiKey?: string;
  defaultCustomer?: string;
  defaultHostname?: string;
  memo?: string;
}

function credentialBodyError(payload: MerakiCredentialBody): string | null {
  if (!payload.label || !payload.label.trim()) return "label は必須です";
  if (!payload.networkId || !payload.networkId.trim())
    return "networkId は必須です";
  if (!payload.apiKey || !payload.apiKey.trim()) return "apiKey は必須です";
  return null;
}

/** Meraki 接続情報アプリの有効/無効と、一覧取得。
 *  GET /api/meraki/credentials → 接続情報一覧（apiKey は隠してラスト 4 文字のみ）
 *  POST /api/meraki/credentials → 新規登録
 *  PUT /api/meraki/credentials/:id → 更新
 *  DELETE /api/meraki/credentials/:id → 削除 */
api.get("/meraki/credentials", async (c) => {
  const cfg = c.var.cfg;
  if (!isEnabledMerakiCredentials(cfg)) {
    return c.json({
      enabled: false,
      credentials: [],
      error: "Meraki 接続情報アプリが未設定です",
    });
  }
  const credentials = await listMerakiCredentials(cfg);
  // apiKey は全文返すと画面上に漏れるため、ラスト 4 文字のみマスク表示。
  // 取得時に再度 Kintone から読み直すため、この API 応答のマスクは UI 表示専用。
  const masked = credentials.map((c2) => ({
    ...c2,
    apiKey: maskApiKey(c2.apiKey),
  }));
  return c.json({ enabled: true, credentials: masked });
});

api.post("/meraki/credentials", async (c) => {
  const cfg = c.var.cfg;
  if (!isEnabledMerakiCredentials(cfg)) {
    return c.json({ error: "Meraki 接続情報アプリが未設定です" }, 503);
  }
  const payload = await c.req.json<MerakiCredentialBody>().catch(() => null);
  if (!payload) return c.json({ error: "invalid JSON body" }, 400);
  const err = credentialBodyError(payload);
  if (err) return c.json({ error: err }, 400);

  try {
    const created = await createMerakiCredential(cfg, {
      label: payload.label!.trim(),
      networkId: payload.networkId!.trim(),
      apiKey: payload.apiKey!.trim(),
      defaultCustomer: payload.defaultCustomer?.trim() || undefined,
      defaultHostname: payload.defaultHostname?.trim() || undefined,
      memo: payload.memo?.trim() || undefined,
    });
    await writeAudit(cfg, {
      operator: c.var.user.displayName,
      operatorEmail: c.var.user.email,
      action: "upload",
      detail: `Meraki 接続情報を登録: ${created.label} (network=${created.networkId})`,
    });
    return c.json({ credential: { ...created, apiKey: maskApiKey(created.apiKey) } }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `登録失敗: ${msg}` }, 500);
  }
});

api.put("/meraki/credentials/:id", async (c) => {
  const cfg = c.var.cfg;
  if (!isEnabledMerakiCredentials(cfg)) {
    return c.json({ error: "Meraki 接続情報アプリが未設定です" }, 503);
  }
  const id = c.req.param("id");
  const payload = await c.req.json<MerakiCredentialBody>().catch(() => null);
  if (!payload) return c.json({ error: "invalid JSON body" }, 400);
  // label/networkId/apiKey は必須だが、更新時は未指定のフィールドはそのまま残す。
  // ただし 3 つとも未指定だと意味がないので、何れか 1 つは指定を要求する。
  if (
    payload.label === undefined &&
    payload.networkId === undefined &&
    payload.apiKey === undefined &&
    payload.defaultCustomer === undefined &&
    payload.defaultHostname === undefined &&
    payload.memo === undefined
  ) {
    return c.json({ error: "更新対象フィールドがありません" }, 400);
  }

  try {
    await updateMerakiCredential(cfg, id, {
      label: payload.label?.trim(),
      networkId: payload.networkId?.trim(),
      apiKey: payload.apiKey?.trim(),
      defaultCustomer: payload.defaultCustomer?.trim(),
      defaultHostname: payload.defaultHostname?.trim(),
      memo: payload.memo?.trim(),
    });
    await writeAudit(cfg, {
      operator: c.var.user.displayName,
      operatorEmail: c.var.user.email,
      action: "upload",
      detail: `Meraki 接続情報を更新: id=${id}`,
    });
    const refreshed = await getMerakiCredential(cfg, id);
    return c.json({
      credential: refreshed
        ? { ...refreshed, apiKey: maskApiKey(refreshed.apiKey) }
        : null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `更新失敗: ${msg}` }, 500);
  }
});

api.delete("/meraki/credentials/:id", async (c) => {
  const cfg = c.var.cfg;
  if (!isEnabledMerakiCredentials(cfg)) {
    return c.json({ error: "Meraki 接続情報アプリが未設定です" }, 503);
  }
  const id = c.req.param("id");
  const existing = await getMerakiCredential(cfg, id);
  if (!existing) return c.json({ error: "not found" }, 404);
  try {
    await deleteMerakiCredential(cfg, id);
    await writeAudit(cfg, {
      operator: c.var.user.displayName,
      operatorEmail: c.var.user.email,
      action: "delete",
      detail: `Meraki 接続情報を削除: ${existing.label} (network=${existing.networkId})`,
    });
    return c.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `削除失敗: ${msg}` }, 500);
  }
});

/** API キーをマスク表示用に変換（ラスト 4 文字のみ残す）。 */
function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 4) return "****";
  return "*".repeat(key.length - 4) + key.slice(-4);
}

/** GET /api/diff?before=<id>&after=<id> — diff two versions. */
api.get("/diff", async (c) => {
  const cfg = c.var.cfg;
  const beforeId = c.req.query("before");
  const afterId = c.req.query("after");
  if (!beforeId || !afterId) {
    return c.json({ error: "before and after query params are required" }, 400);
  }
  const beforeRec = await getVersionRecord(cfg, beforeId);
  const afterRec = await getVersionRecord(cfg, afterId);
  if (!beforeRec || !afterRec) return c.json({ error: "not found" }, 404);

  const v = (rec: typeof beforeRec, k: string) => rec[k]?.value ?? "";
  const before = {
    generation: Number.parseInt(v(beforeRec, "generation"), 10) || 0,
    body: v(beforeRec, "body"),
    hash: v(beforeRec, "hash"),
  };
  const after = {
    generation: Number.parseInt(v(afterRec, "generation"), 10) || 0,
    body: v(afterRec, "body"),
    hash: v(afterRec, "hash"),
  };
  const diff = diffConfigs(before, after);

  await writeAudit(cfg, {
    operator: c.var.user.displayName,
    operatorEmail: c.var.user.email,
    action: "diff",
    customer: v(beforeRec, "customer"),
    hostname: v(beforeRec, "hostname"),
    detail: `Diffed generation ${before.generation} -> ${after.generation}`,
  });

  return c.json({ diff });
});

interface VersionMetaBody {
  purpose?: string;
  note?: string;
  serialNumber?: string;
  customer?: string;
  hostname?: string;
  ipAddress?: string;
}

/** PUT /api/versions/:id — 既存バージョンのメタ情報を編集する。
 *  編集可能なのは purpose / note / serialNumber / customer / hostname /
 *  ipAddress のみ。body・hash・generation・detected は変更不可 (一意性保証)。
 *  誤登録のメタ情報修正や、後からの用途・メモ追加に使う。 */
api.put("/versions/:id", async (c) => {
  const cfg = c.var.cfg;
  const id = c.req.param("id");
  const payload = await c.req.json<VersionMetaBody>().catch(() => null);
  if (!payload) return c.json({ error: "invalid JSON body" }, 400);

  const rec = await getVersionRecord(cfg, id);
  if (!rec) return c.json({ error: "not found" }, 404);
  const before = identifiersFromRecord(rec);

  // 未指定のフィールドは更新しない。空文字列明示的な場合はクリア可能。
  const update: VersionMetaBody = {};
  if (payload.purpose !== undefined) update.purpose = payload.purpose.trim();
  if (payload.note !== undefined) update.note = payload.note;
  if (payload.serialNumber !== undefined)
    update.serialNumber = payload.serialNumber.trim();
  if (payload.customer !== undefined) update.customer = payload.customer.trim();
  if (payload.hostname !== undefined) update.hostname = payload.hostname.trim();
  if (payload.ipAddress !== undefined) {
    const trimmed = payload.ipAddress.trim();
    if (!trimmed) {
      return c.json(
        { error: "IPアドレスは必須項目のため空にはできません" },
        400,
      );
    }
    update.ipAddress = trimmed;
  }

  // 何れも指定が無い場合は更新不要。
  if (Object.keys(update).length === 0) {
    return c.json({ error: "更新対象フィールドがありません" }, 400);
  }

  try {
    await updateVersionMeta(cfg, id, update);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `更新失敗: ${msg}` }, 500);
  }

  // 変更内容を監査ログへ。どのフィールドが変わったかを detail に記録。
  const changedFields = Object.keys(update);
  await writeAudit(cfg, {
    operator: c.var.user.displayName,
    operatorEmail: c.var.user.email,
    action: "edit",
    customer: update.customer ?? before.customer,
    hostname: update.hostname ?? before.hostname,
    generation: Number.parseInt(rec["generation"]?.value ?? "0", 10) || undefined,
    detail: `メタ情報を編集: ${changedFields.join(", ")}`,
  });

  return c.json({ ok: true, updated: changedFields });
});

/** DELETE /api/versions/:id — バージョンを削除する。
 *  誤登録の取り消し用。世代の歯抜けが生じるが、latestGenerationFor は
 *  最大値を追うため重複は発生しない。コンフィグ本文は復元できないため、
 *  UI 側で確認ダイアログを必ず出すこと。 */
api.delete("/versions/:id", async (c) => {
  const cfg = c.var.cfg;
  const id = c.req.param("id");
  const rec = await getVersionRecord(cfg, id);
  if (!rec) return c.json({ error: "not found" }, 404);
  const ids = identifiersFromRecord(rec);
  const generation = Number.parseInt(rec["generation"]?.value ?? "0", 10) || 0;

  try {
    await deleteVersion(cfg, id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `削除失敗: ${msg}` }, 500);
  }

  await writeAudit(cfg, {
    operator: c.var.user.displayName,
    operatorEmail: c.var.user.email,
    action: "delete",
    customer: ids.customer,
    hostname: ids.hostname,
    generation,
    detail: `世代 #${generation} を削除 (id=${id})`,
  });

  return c.json({ ok: true });
});

/** GET /api/audit — recent operator activity. */
api.get("/audit", async (c) => {
  const limit = Math.min(
    Number.parseInt(c.req.query("limit") ?? "100", 10) || 100,
    500,
  );
  const entries = await listAudit(c.var.cfg, limit);
  return c.json({ entries });
});

/** Escape regex metacharacters so a literal string is treated as a literal
 *  match by RegExp. */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** GET /api/search?q=...&scope=latest|all&regex=0|1 — full-text search across
 *  config bodies. Scans all config records server-side (Kintone has no native
 *  substring query for multi-line text) and returns line-level matches with
 *  one line of context. `scope=latest` restricts to each device's latest
 *  generation so typical impact surveys don't drown in historical noise. */
api.get("/search", async (c) => {
  const cfg = c.var.cfg;
  const q = c.req.query("q")?.trim() ?? "";
  const scopeParam = c.req.query("scope");
  const scope: "latest" | "all" = scopeParam === "all" ? "all" : "latest";
  const isRegex = c.req.query("regex") === "1";
  const maxPerVersion = Math.min(
    Number.parseInt(c.req.query("maxPerVersion") ?? "30", 10) || 30,
    200,
  );
  const recordLimit = Math.min(
    Number.parseInt(c.req.query("limit") ?? "500", 10) || 500,
    500,
  );

  if (!q) {
    return c.json({
      query: q,
      isRegex,
      scope,
      hits: [],
      scannedDevices: 0,
      scannedVersions: 0,
    });
  }

  let pattern: RegExp;
  try {
    pattern = isRegex ? new RegExp(q, "i") : new RegExp(escapeRegExp(q), "i");
  } catch {
    return c.json({ error: "invalid regex pattern" }, 400);
  }

  const records = await listConfigRecords(cfg, recordLimit);

  // Find the latest generation per device key so we can filter when
  // scope=latest. The device key mirrors the grouping in /api/devices.
  const latestGenByKey = new Map<string, number>();
  for (const rec of records) {
    const ids = identifiersFromRecord(rec);
    const key = `${ids.customer}|${ids.hostname}|${ids.ipAddress}|${ids.role}`;
    const gen =
      Number.parseInt(rec["generation"]?.value ?? "0", 10) || 0;
    const prev = latestGenByKey.get(key);
    if (prev === undefined || gen > prev) latestGenByKey.set(key, gen);
  }

  const hits: ConfigSearchHit[] = [];
  for (const rec of records) {
    const ids = identifiersFromRecord(rec);
    const gen =
      Number.parseInt(rec["generation"]?.value ?? "0", 10) || 0;
    if (scope === "latest") {
      const key = `${ids.customer}|${ids.hostname}|${ids.ipAddress}|${ids.role}`;
      const latest = latestGenByKey.get(key);
      if (latest === undefined || gen !== latest) continue;
    }
    const body = rec["body"]?.value ?? "";
    if (!body) continue;
    const lines = body.split("\\n");
    let matchCount = 0;
    for (let i = 0; i < lines.length && matchCount < maxPerVersion; i++) {
      if (pattern.test(lines[i])) {
        hits.push({
          versionId: rec.$id.value,
          generation: gen,
          customer: ids.customer,
          hostname: ids.hostname,
          ipAddress: ids.ipAddress,
          role: ids.role,
          line: i + 1,
          text: lines[i],
          before: i > 0 ? lines[i - 1] : undefined,
          after: i < lines.length - 1 ? lines[i + 1] : undefined,
        });
        matchCount++;
      }
    }
  }

  // Audit the search so administrators can see what operators are looking
  // for (useful during incident response). Best-effort.
  void writeAudit(cfg, {
    operator: c.var.user.displayName,
    operatorEmail: c.var.user.email,
    action: "view",
    detail: `Searched "${q}" (scope=${scope}, regex=${isRegex}) -> ${hits.length} hits`,
  });

  return c.json({
    query: q,
    isRegex,
    scope,
    hits,
    scannedDevices: latestGenByKey.size,
    scannedVersions: records.length,
  });
});

/** Resolve the firewall rules for a version record, using the persisted cache
 *  and recomputing lazily when missing/stale (same logic as
 *  GET /versions/:id/firewall). Returns null for a missing record. */
async function resolveFirewallRules(cfg: AppConfig, id: string): Promise<{
  rules: FirewallRule[];
  record: KintoneRecord;
} | null> {
  const rec = await getVersionRecord(cfg, id);
  if (!rec) return null;
  const val = (k: string) => rec[k]?.value ?? "";
  const hash = val("hash");
  const rawBody = val("body");
  const detected = detectedFromRecord(rec);
  let rules = parseFirewallCache(getFwCacheRaw(rec), hash);
  if (rules === null) {
    rules = extractFirewallRules(rawBody, detected);
    void setFwCache(cfg, id, serializeFirewallRules(rules, hash));
  }
  return { rules, record: rec };
}

/** Analogous to {@link resolveFirewallRules} for routing. */
async function resolveRoutingRoutes(cfg: AppConfig, id: string): Promise<{
  routes: RoutingRoute[];
  record: KintoneRecord;
} | null> {
  const rec = await getVersionRecord(cfg, id);
  if (!rec) return null;
  const val = (k: string) => rec[k]?.value ?? "";
  const hash = val("hash");
  const rawBody = val("body");
  const detected = detectedFromRecord(rec);
  let routes = parseRoutingCache(getRoutingCacheRaw(rec), hash);
  if (routes === null) {
    routes = extractRoutingRoutes(rawBody, detected);
    void setRoutingCache(cfg, id, serializeRoutingRoutes(routes, hash));
  }
  return { routes, record: rec };
}

/** GET /api/diff/firewall?before=<id>&after=<id> — structural diff between
 *  the firewall rule sets of two versions. Uses cached extractions so it is
 *  fast even for large policies. */
api.get("/diff/firewall", async (c) => {
  const cfg = c.var.cfg;
  const beforeId = c.req.query("before");
  const afterId = c.req.query("after");
  if (!beforeId || !afterId) {
    return c.json(
      { error: "before and after query params are required" },
      400,
    );
  }
  const before = await resolveFirewallRules(cfg, beforeId);
  const after = await resolveFirewallRules(cfg, afterId);
  if (!before || !after) return c.json({ error: "not found" }, 404);

  const diff = diffFirewallRules(before.rules, after.rules);
  void writeAudit(cfg, {
    operator: c.var.user.displayName,
    operatorEmail: c.var.user.email,
    action: "diff",
    customer: before.record["customer"]?.value,
    hostname: before.record["hostname"]?.value,
    detail: `Diffed firewall rules`,
  });
  return c.json({ diff });
});

/** GET /api/diff/routing?before=<id>&after=<id> — structural diff between
 *  the routing tables of two versions. */
api.get("/diff/routing", async (c) => {
  const cfg = c.var.cfg;
  const beforeId = c.req.query("before");
  const afterId = c.req.query("after");
  if (!beforeId || !afterId) {
    return c.json(
      { error: "before and after query params are required" },
      400,
    );
  }
  const before = await resolveRoutingRoutes(cfg, beforeId);
  const after = await resolveRoutingRoutes(cfg, afterId);
  if (!before || !after) return c.json({ error: "not found" }, 404);

  const diff = diffRoutingRoutes(before.routes, after.routes);
  void writeAudit(cfg, {
    operator: c.var.user.displayName,
    operatorEmail: c.var.user.email,
    action: "diff",
    customer: before.record["customer"]?.value,
    hostname: before.record["hostname"]?.value,
    detail: `Diffed routing routes`,
  });
  return c.json({ diff });
});
