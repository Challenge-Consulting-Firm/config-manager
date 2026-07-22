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
  getWirelessCacheRaw,
  identifiersFromRecord,
  latestGenerationFor,
  listAudit,
  listConfigRecords,
  listVersions,
  listVersionsDetailed,
  setFwCache,
  setRoutingCache,
  setWirelessCache,
  writeAudit,
  createMerakiCredential,
  deleteMerakiCredential,
  deleteVersion,
  deleteVersions,
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
  diffWireless,
  detectDeviceInfo,
  extractFirewallRules,
  extractRoutingRoutes,
  extractWireless,
  extractVlans,
  normalizeConfig,
  parseFirewallCache,
  parseRoutingCache,
  parseWirelessCache,
  serializeFirewallRules,
  serializeMerakiConfig,
  serializeRoutingRoutes,
  serializeWireless,
  summarizeMerakiImport,
} from "@config-manager/shared";
import type {
  AuthUser,
  ConfigSearchHit,
  ConfigVersion,
  Device,
  FirewallRule,
  MerakiDeviceInfo,
  MerakiProductType,
  Role,
  RoutingRoute,
  WirelessExtraction,
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
  // body 本文を含まない一覧＋識別子を 1 クエリで取得する。以前は各バージョンを
  // getVersionRecord（body 込み・Meraki では数 MB）で読み直しており、レコードが
  // 増えると OOM していた。
  const detailed = await listVersionsDetailed(cfg, {
    customer: customer || undefined,
    hostname: hostname || undefined,
    role: (role as Role) || undefined,
  });

  const devices = new Map<string, Device>();
  for (const { version: v, identifiers: ids } of detailed) {
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

/** GET /api/versions/:id/wireless — cached wireless (SSID + AP) snapshot.
 *  Returns the persisted extraction; recomputes + persists on cache miss or
 *  body-hash mismatch. Only Meraki dumps carry wireless data — other vendors
 *  yield empty lists. */
api.get("/versions/:id/wireless", async (c) => {
  const cfg = c.var.cfg;
  const id = c.req.param("id");
  const rec = await getVersionRecord(cfg, id);
  if (!rec) return c.json({ error: "not found" }, 404);

  const val = (k: string) => rec[k]?.value ?? "";
  const hash = val("hash");
  const rawBody = val("body");
  const detected = detectedFromRecord(rec);

  let extraction = parseWirelessCache(getWirelessCacheRaw(rec), hash);
  let fromCache = extraction !== null;
  if (extraction === null) {
    extraction = extractWireless(rawBody, detected);
    void setWirelessCache(cfg, id, serializeWireless(extraction, hash));
    fromCache = false;
  }

  return c.json({
    ssids: extraction.ssids,
    accessPoints: extraction.accessPoints,
    fromCache,
    count: extraction.ssids.length + extraction.accessPoints.length,
  });
});

/** GET /api/versions/:id/vlan — VLAN definitions + port membership for a
 *  version. Unlike FW/routing/wireless this is NOT cached to Kintone: VLAN
 *  data is small and cheap to recompute, so it is parsed from the stored body
 *  on every request. Structural (vendor-neutral) so any switch config with the
 *  common `vlan` / `switchport` grammar works. */
api.get("/versions/:id/vlan", async (c) => {
  const cfg = c.var.cfg;
  const id = c.req.param("id");
  const rec = await getVersionRecord(cfg, id);
  if (!rec) return c.json({ error: "not found" }, 404);

  const val = (k: string) => rec[k]?.value ?? "";
  const detected = detectedFromRecord(rec);
  const extraction = extractVlans(val("body"), detected?.vendor ?? "");

  return c.json({
    vlans: extraction.vlans,
    ports: extraction.ports,
    count: extraction.vlans.length,
  });
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
  // Wireless (SSID + AP) snapshot; empty for non-Meraki configs.
  const wireless = extractWireless(body, detected);
  const wirelessJson = serializeWireless(wireless, normalized.hash);

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
    wirelessJson,
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
    wirelessJson: serializeWireless(extractWireless(body, detected), hash),
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
  /** 登録済 Meraki 接続情報のレコード ID。指定時は networkId/apiKey
   *  より優先され、さらにデフォルト顧客・ホスト名も補完に使う。 */
  credentialId?: string;
  customer: string;
  /** デバイス name が取れない場合のフォールバックホスト名。デバイス name が
   *  存在する場合はその name が優先される（デバイス単位レコード化のため）。 */
  hostname: string;
  /** 未指定時は各デバイスの lanIp / publicIp で補完。指定時は全デバイスの
   *  IP を強制上書きするため、複数デバイスを抱えるネットワークでは推奨しない。 */
  ipAddress?: string;
  purpose?: string;
  serialNumber?: string;
  role?: Role;
  note?: string;
}

/** Meraki import のデバイス每結果。ネットワーク内のデバイス 1 件につき 1
 *  レコード作成（またはスキップ・エラー）を返す。Meraki はネットワーク単位
 *  で設定を保持するため、同一 productType の複数デバイス（例: MR 3 台）は
 *  コンフィグ本体が同一になるが、シリアル・IP・ホスト名で識別する。 */
interface MerakiImportDeviceResult {
  /** 取り込み対象デバイスの識別情報。UI 側で結果一覧を並べるのに使う。 */
  device: {
    serial: string;
    name: string;
    model: string;
    productType: string;
    lanIp?: string;
    publicIp?: string;
  };
  /** createVersion が成功した場合の結果。skipped/error のどちらかのみ立つ。 */
  created?: {
    id: string;
    generation: number;
    hash: string;
    detected?: {
      vendor: string;
      os: string;
      osVersion: string;
      model: string;
      confidence: number;
    };
  };
  /** 最新世代と同一コンフィグと判定されて新世代作成をスキップした場合。 */
  skipped?: boolean;
  reason?: string;
  /** このデバイスの取り込みで失敗した場合のエラー理由。 */
  error?: string;
  /** normalize で除去されたコメント/空白行数。created のみ。 */
  strippedLines?: number;
}

/** POST /api/meraki/import — Meraki Dashboard API から対象ネットワークの
 *  設定を取得し、**ネットワーク内のデバイス 1 件每**に新規世代として登録する。
 *
 *  Meraki は設定をネットワーク単位で保持するため、ネットワーク内の全デバイス
 *  が共通のネットワーク設定（VLAN/FW/SSID/ルーティング等）を共有する。本
 *  エンドポイントでは「デバイスの productType に属するセクションのみ」を
 *  シリアライズし、各デバイスを 1 レコードとして扱う。これにより「同一
 *  ネットワークの MR と MX が同一レコードになる」問題を回避する。
 *
 *  識別子の決定（デバイス每）:
 *    - customer: 要求ボディ（全デバイス共通）
 *    - hostname: device.name → device.serial → 要求ボディ（フォールバック）
 *    - ipAddress: 要求ボディ → device.lanIp → device.publicIp の順
 *    - serialNumber: device.serial
 *    - purpose: 要求ボディ → `${productType} in ${networkName}`
 *
 *  認証情報の優先順位: credentialId > 要求ボディ (networkId/apiKey) >
 *  環境変数 MERAKI_API_KEY（apiKey のみ）。credentialId 指定時は、
 *  customer/hostname が未入力ならデフォルト値で補完する。
 *
 *  トランザクション性は持たない：一部デバイスの取り込みに失敗しても、成功
 *  したデバイスは保存し、results 配列で個別結果を返す。 */
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

  // 2. 共通識別子を確定。Meraki はネットワーク単位で取り込み、hostname /
  //    ipAddress / serialNumber / purpose はすべて各デバイスの情報から自動
  //    決定する。したがってユーザー入力で必須なのは customer のみ。
  //    payload.hostname / defaultHostname は name も serial も持たない稀な
  //    デバイス向けのフォールバックとしてのみ使う（未指定可）。
  const customer = textField(payload.customer) || defaultCustomer;
  const fallbackHostname = textField(payload.hostname) || defaultHostname;
  const inputIpAddress = textField(payload.ipAddress);
  const inputPurpose = textField(payload.purpose);
  const inputSerialNumber = textField(payload.serialNumber);
  const note =
    typeof payload.note === "string" ? payload.note : undefined;
  const role: Role = payload.role === "spare" ? "spare" : "production";

  if (!customer) {
    return c.json(
      { error: "customer は必須です（credentialId のデフォルト値または要求ボディで指定してください）" },
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
      sectionConcurrency: cfg.meraki.sectionConcurrency,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "Meraki API 取得失敗: " + msg }, 502);
  }
  const { dump } = fetchResult;
  const summary = summarizeMerakiImport(dump);

  // ネットワーク内に MR/MX/MS デバイスが 1 件も無い場合は早期エラー。
  // (cell/camera/sensor 等のみのネットワーク)
  const supportedDevices = dump.devices.filter(
    (d): d is MerakiDeviceInfo & { productType: MerakiProductType } =>
      d.productType === "appliance" ||
      d.productType === "switch" ||
      d.productType === "wireless",
  );
  if (supportedDevices.length === 0) {
    // 诊断情報: 実際に取得したデバイスの productType / model を返す。
    // UI 側で「なぜ MR/MX/MS と判定されなかったか」を確認できるようにする。
    const deviceDiagnostics = dump.devices.map((d) => ({
      name: d.name || "",
      model: d.model || "",
      serial: d.serial || "",
      productType: d.productType || "",
    }));
    const productTypesFound = Array.from(
      new Set(deviceDiagnostics.map((d) => d.productType || "(empty)")),
    );
    return c.json(
      {
        error:
          "ネットワーク内に MR/MX/MS デバイスが見つかりませんでした（cell/camera/sensor 等のみの可能性があります）",
        diagnostic: {
          deviceCount: dump.devices.length,
          productTypesFound,
          devices: deviceDiagnostics,
        },
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

  // 4. デバイス每にレコード作成を試みる。同一ネットワーク内で device.name が
  //    重複・空の場合は serial サフィックスして hostname 衝突を回避する
  //    （listVersions が customer/hostname/ipAddress/role で絞るため）。
  const usedHostnames = new Set<string>();
  const results: MerakiImportDeviceResult[] = [];
  const operator = c.var.user.displayName;
  const operatorEmail = c.var.user.email;

  for (const device of supportedDevices) {
    const pt = device.productType;
    const deviceSummary: MerakiImportDeviceResult["device"] = {
      serial: device.serial || "",
      name: device.name || "",
      model: device.model || "",
      productType: pt,
      lanIp: device.lanIp,
      publicIp: device.publicIp,
    };

    try {
      // 4-1. hostname を決定。device.name → device.serial → 要求ボディ →
      //      mac の順。ネットワーク単位取り込みでは hostname 入力が無いため、
      //      デバイス情報から必ず一意な名前を導出する。
      let deviceHostname =
        device.name || device.serial || fallbackHostname || device.mac;
      if (usedHostnames.has(deviceHostname)) {
        const suffix = device.serial || device.mac || pt;
        deviceHostname = deviceHostname + "-" + suffix;
      }
      if (usedHostnames.has(deviceHostname)) {
        // それでも衝突する場合は index 付与（極めてレアなケース）。
        let i = 2;
        while (usedHostnames.has(deviceHostname + "-" + i)) i++;
        deviceHostname = deviceHostname + "-" + i;
      }
      usedHostnames.add(deviceHostname);

      // 4-2. IP を決定。ユーザー入力 → lanIp → publicIp の順。
      //      lanIp が無いデバイス（例: WAN 側 MR）は publicIp を、それも無い場合は
      //      スキップして results へ反映する（他デバイスへは影響させない）。
      const deviceIp = inputIpAddress || device.lanIp || device.publicIp || "";
      if (!deviceIp) {
        results.push({
          device: deviceSummary,
          skipped: true,
          reason:
            "IPアドレスが取得できませんでした（lanIp/publicIp のいずれも未設定）。",
        });
        continue;
      }

      // 4-3. productType フィルタしたシリアライズ。focusDevice で対象デバイスを
      //      ヘッダへ強調表示し、どのデバイス向けのダンプか一目で分かるようにする。
      const rawBody = serializeMerakiConfig(dump, {
        productType: pt,
        focusDevice: device,
      });
      const detected = detectDeviceInfo(rawBody);
      const normalized = await normalizeConfig(rawBody, {
        commentPrefixes: cfg.commentPrefixes,
      });
      const fwRules = extractFirewallRules(rawBody, detected);
      const fwRulesJson = serializeFirewallRules(fwRules, normalized.hash);
      const routingRoutes = extractRoutingRoutes(rawBody, detected);
      const routingRoutesJson = serializeRoutingRoutes(
        routingRoutes,
        normalized.hash,
      );
      const wireless = extractWireless(rawBody, detected);
      const wirelessJson = serializeWireless(wireless, normalized.hash);

      const identifiers = {
        customer,
        hostname: deviceHostname,
        ipAddress: deviceIp,
        purpose:
          inputPurpose ||
          pt + " in " + dump.network.name + " (" + dump.network.id + ")",
        // シリアルはデバイス情報を優先。空欄の場合のみユーザー入力で補完。
        serialNumber: device.serial || inputSerialNumber || "",
        role,
      };

      // 4-4. 重複スキップ判定。同一 customer/hostname/ipAddress/role の最新世代と
      //      hash が一致する場合は新世代を作らない。
      const prevGen = await latestGenerationFor(cfg, identifiers);
      const prevVersions = await listVersions(cfg, identifiers);
      const latest = prevVersions.find((v) => v.generation === prevGen);
      if (latest && latest.hash === normalized.hash) {
        results.push({
          device: deviceSummary,
          skipped: true,
          reason: "最新世代と同一のコンフィグです。新世代は作成されませんでした。",
        });
        continue;
      }

      // 4-5. createVersion。失敗した場合は catch で results へ反映して次デバイスへ。
      const nextGen = prevGen + 1;
      const created = await createVersion(cfg, {
        identifiers,
        generation: nextGen,
        body: normalized.body,
        hash: normalized.hash,
        size: normalized.size,
        lines: normalized.lines,
        operator,
        operatorEmail,
        note:
          note ??
          "Meraki import: network=" +
            dump.network.name +
            " (" +
            dump.network.id +
            "), device=" +
            (device.name || "(unnamed)") +
            ", serial=" +
            (device.serial || "-") +
            ", product=" +
            pt +
            ", failedSections=" +
            summary.failedSections,
        detected,
        fwRulesJson,
        routingRoutesJson,
        wirelessJson,
      });

      await writeAudit(cfg, {
        operator,
        operatorEmail,
        action: "upload",
        customer,
        hostname: deviceHostname,
        generation: nextGen,
        detail:
          "Meraki import: network=" +
          dump.network.name +
          " (" +
          dump.network.id +
          "); device=" +
          (device.name || "(unnamed)") +
          "; serial=" +
          (device.serial || "-") +
          "; product=" +
          pt +
          "; failedSections=" +
          summary.failedSections,
      });

      results.push({
        device: deviceSummary,
        created: {
          id: created.id,
          generation: created.generation,
          hash: created.hash,
          detected: created.detected,
        },
        strippedLines: normalized.strippedLines,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ device: deviceSummary, error: msg });
    }
  }

  return c.json(
    {
      results,
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

/** DELETE /api/devices/:key — 機器（論理デバイス）を関連コンフィグごと一括削除
 *  する。key は customer|hostname|ipAddress|role（GET /api/devices の id と同形式）。
 *  その識別子に紐づく全世代のコンフィグレコードを削除する。コンフィグ本文は
 *  復元できないため、UI 側で確認ダイアログを必ず出すこと。 */
api.delete("/devices/:key", async (c) => {
  const cfg = c.var.cfg;
  const key = c.req.param("key");
  const [customer, hostname, ipAddress, role] = key.split("|");
  if (!customer || !hostname) {
    return c.json({ error: "不正なデバイスキーです" }, 400);
  }
  const versions = await listVersions(cfg, {
    customer,
    hostname,
    ipAddress,
    role: (role as Role) || undefined,
  });
  if (versions.length === 0) {
    return c.json({ error: "対象の機器が見つかりません" }, 404);
  }

  const ids = versions.map((v) => v.id);
  try {
    await deleteVersions(cfg, ids);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `削除失敗: ${msg}` }, 500);
  }

  await writeAudit(cfg, {
    operator: c.var.user.displayName,
    operatorEmail: c.var.user.email,
    action: "delete",
    customer,
    hostname,
    generation: 0,
    detail: `機器を一括削除: ${hostname} (ip=${ipAddress || "-"}, role=${role || "-"}) — 全 ${ids.length} 世代`,
  });

  return c.json({ ok: true, deletedCount: ids.length });
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

/** Analogous to {@link resolveFirewallRules} for wireless (SSID + AP). */
async function resolveWireless(cfg: AppConfig, id: string): Promise<{
  extraction: WirelessExtraction;
  record: KintoneRecord;
} | null> {
  const rec = await getVersionRecord(cfg, id);
  if (!rec) return null;
  const val = (k: string) => rec[k]?.value ?? "";
  const hash = val("hash");
  const rawBody = val("body");
  const detected = detectedFromRecord(rec);
  let extraction = parseWirelessCache(getWirelessCacheRaw(rec), hash);
  if (extraction === null) {
    extraction = extractWireless(rawBody, detected);
    void setWirelessCache(cfg, id, serializeWireless(extraction, hash));
  }
  return { extraction, record: rec };
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

/** GET /api/diff/wireless?before=<id>&after=<id> — structural diff between
 *  the wireless SSID + AP snapshots of two versions. */
api.get("/diff/wireless", async (c) => {
  const cfg = c.var.cfg;
  const beforeId = c.req.query("before");
  const afterId = c.req.query("after");
  if (!beforeId || !afterId) {
    return c.json(
      { error: "before and after query params are required" },
      400,
    );
  }
  const before = await resolveWireless(cfg, beforeId);
  const after = await resolveWireless(cfg, afterId);
  if (!before || !after) return c.json({ error: "not found" }, 404);

  const diff = diffWireless(before.extraction, after.extraction);
  void writeAudit(cfg, {
    operator: c.var.user.displayName,
    operatorEmail: c.var.user.email,
    action: "diff",
    customer: before.record["customer"]?.value,
    hostname: before.record["hostname"]?.value,
    detail: `Diffed wireless SSID/AP`,
  });
  return c.json({ diff });
});
