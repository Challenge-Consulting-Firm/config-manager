/**
 * Kintone REST API client.
 *
 * The two apps used are:
 *   - config app:   one record per config generation (revision)
 *   - audit app:    one record per operator action
 *
 * Field codes must match the Kintone app definitions described in README.md.
 */

import type { AppConfig } from "./config.js";
import type {
  AuditAction,
  AuditLogEntry,
  ConfigVersion,
  DeviceDetection,
  DeviceIdentifiers,
  MerakiCredential,
  Role,
} from "@config-manager/shared";
import { ROLE_LABELS } from "@config-manager/shared";

// ----- Kintone field-code maps (must match the Kintone app definitions) -----
const F = {
  // Config app
  config: {
    customer: "customer",
    hostname: "hostname",
    ipAddress: "ip_address",
    purpose: "purpose",
    serialNumber: "serial_number",
    role: "role",
    generation: "generation",
    body: "body",
    hash: "hash",
    operator: "operator",
    operatorEmail: "operator_email",
    note: "note",
    size: "size",
    lines: "lines",
    // Auto-detected fields
    vendor: "vendor",
    deviceOs: "device_os",
    osVersion: "os_version",
    detectedModel: "detected_model",
    // Cached firewall-rule extraction result (JSON)
    fwRulesJson: "fw_rules_json",
    // Cached routing-routes extraction result (JSON)
    routingRoutesJson: "routing_routes_json",
    // Cached wireless (SSID + AP) extraction result (JSON)
    wirelessJson: "wireless_json",
  },
  // Audit app
  audit: {
    operator: "operator",
    operatorEmail: "operator_email",
    action: "action",
    customer: "customer",
    hostname: "hostname",
    generation: "generation",
    detail: "detail",
  },
  // Meraki credentials app (optional)
  meraki: {
    label: "label",
    networkId: "network_id",
    apiKey: "api_key",
    defaultCustomer: "default_customer",
    defaultHostname: "default_hostname",
    memo: "memo",
  },
} as const;

// ----- Role <-> Kintone dropdown value (stored as Japanese label) -----
function roleToKintone(role: Role): string {
  return ROLE_LABELS[role];
}
function kintoneToRole(v: string | undefined): Role {
  return v === ROLE_LABELS.spare ? "spare" : "production";
}

function authHeaders(cfg: AppConfig, token: string): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Cybozu-API-Token": token,
    "Content-Type": "application/json",
  };
  // Optional basic auth (when Kintone is configured to require it alongside
  // the token). For Entra-ID-federated Kintone domains this is usually empty.
  if (cfg.kintone.username && cfg.kintone.password) {
    const basic = Buffer.from(
      `${cfg.kintone.username}:${cfg.kintone.password}`,
    ).toString("base64");
    headers["X-Cybozu-Authorization"] = basic;
  }
  return headers;
}

async function kintoneFetch<T>(
  cfg: AppConfig,
  token: string,
  path: string,
  init: RequestInit,
): Promise<T> {
  const url = `${cfg.kintone.baseUrl}/k/v1${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...authHeaders(cfg, token), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Kintone ${path} failed (${res.status}): ${text}`,
    );
  }
  return text ? (JSON.parse(text) as T) : (undefined as unknown as T);
}

export interface KintoneRecord {
  $id: { value: string };
  $revision: { value: string };
  [fieldCode: string]: { value: string };
}

export function detectedFromRecord(rec: KintoneRecord): DeviceDetection | undefined {
  const val = (k: string) => rec[k]?.value ?? "";
  const vendor = val(F.config.vendor);
  const os = val(F.config.deviceOs);
  if (!vendor && !os) return undefined;
  return {
    vendor,
    os,
    osVersion: val(F.config.osVersion),
    model: val(F.config.detectedModel),
    hostname: "",
    ipAddress: "",
    confidence: 1, // already stored
  };
}

function toConfigVersion(rec: KintoneRecord): ConfigVersion {
  const val = (k: string) => rec[k]?.value ?? "";
  return {
    id: rec.$id.value,
    generation: Number.parseInt(val(F.config.generation), 10) || 0,
    body: val(F.config.body),
    hash: val(F.config.hash),
    operator: val(F.config.operator),
    operatorEmail: val(F.config.operatorEmail),
    createdAt: new Date(val("作成日時") || val("Created_datetime") || Date.now()).getTime(),
    note: val(F.config.note) || undefined,
    size: Number.parseInt(val(F.config.size), 10) || 0,
    lines: Number.parseInt(val(F.config.lines), 10) || 0,
    role: kintoneToRole(val(F.config.role)),
    detected: detectedFromRecord(rec),
  };
}

/** バージョン一覧を「メタ情報＋識別子」のペアで返す。body 本文は含めない。
 *  /api/devices の一覧構築で、各バージョンの識別子（customer/hostname/
 *  ipAddress/role）を 1 クエリでまとめて得るために使う。従来は各バージョン
 *  ごとに getVersionRecord（body 込み・数 MB）を呼んでいたため OOM の温床だった。 */
export async function listVersionsDetailed(
  cfg: AppConfig,
  filter: Partial<DeviceIdentifiers>,
): Promise<{ version: ConfigVersion; identifiers: DeviceIdentifiers }[]> {
  const records = await listVersionRecords(cfg, filter);
  return records.map((rec) => ({
    version: toConfigVersion(rec),
    identifiers: identifiersFromRecord(rec),
  }));
}

/** listVersions / listVersionsDetailed 共通の生レコード取得。body を除いた
 *  必要フィールドのみを最大 500 件取得する。 */
async function listVersionRecords(
  cfg: AppConfig,
  filter: Partial<DeviceIdentifiers>,
): Promise<KintoneRecord[]> {
  const conds: string[] = [];
  if (filter.customer) {
    conds.push(`${F.config.customer} = ${JSON.stringify(filter.customer)}`);
  }
  if (filter.hostname) {
    conds.push(`${F.config.hostname} = ${JSON.stringify(filter.hostname)}`);
  }
  if (filter.ipAddress) {
    conds.push(`${F.config.ipAddress} = ${JSON.stringify(filter.ipAddress)}`);
  }
  if (filter.role) {
    conds.push(`${F.config.role} = ${JSON.stringify(roleToKintone(filter.role))}`);
  }
  const query = conds.length ? conds.join(" and ") : "";
  const res = await kintoneFetch<{
    records: KintoneRecord[];
  }>(cfg, cfg.kintone.configAppToken, "/records.json", {
    method: "POST",
    headers: { "X-HTTP-Method-Override": "GET" },
    body: JSON.stringify({
      app: cfg.kintone.configAppId,
      query: `${query} order by ${F.config.generation} desc limit 500`,
      fields: [
        "$id",
        F.config.customer,
        F.config.hostname,
        F.config.ipAddress,
        F.config.purpose,
        F.config.serialNumber,
        F.config.role,
        F.config.generation,
        F.config.hash,
        F.config.operator,
        F.config.operatorEmail,
        F.config.note,
        F.config.size,
        F.config.lines,
        F.config.vendor,
        F.config.deviceOs,
        F.config.osVersion,
        F.config.detectedModel,
        "作成日時",
      ],
    }),
  });
  return res.records;
}

/** List config versions, optionally filtered by identifiers. body は含めない
 *  （一覧・重複判定用途）。本文が必要な場合は getVersionRecord を使うこと。 */
export async function listVersions(
  cfg: AppConfig,
  filter: Partial<DeviceIdentifiers>,
): Promise<ConfigVersion[]> {
  const records = await listVersionRecords(cfg, filter);
  return records.map(toConfigVersion);
}

interface KintoneGetRecordResponse {
  record: KintoneRecord;
}

/** Fetch a single config version record (to read its identifiers). */
export async function getVersionRecord(
  cfg: AppConfig,
  id: string,
): Promise<KintoneRecord | null> {
  try {
    const res = await kintoneFetch<KintoneGetRecordResponse>(
      cfg,
      cfg.kintone.configAppToken,
      `/record.json`,
      {
        method: "POST",
        headers: { "X-HTTP-Method-Override": "GET" },
        body: JSON.stringify({ app: cfg.kintone.configAppId, id }),
      },
    );
    return res.record;
  } catch {
    return null;
  }
}

export function identifiersFromRecord(rec: KintoneRecord): DeviceIdentifiers {
  return {
    customer: rec[F.config.customer]?.value ?? "",
    hostname: rec[F.config.hostname]?.value ?? "",
    ipAddress: rec[F.config.ipAddress]?.value ?? "",
    purpose: rec[F.config.purpose]?.value ?? "",
    serialNumber: rec[F.config.serialNumber]?.value ?? "",
    role: kintoneToRole(rec[F.config.role]?.value),
  };
}

/** Read the persisted firewall-rules JSON for a record (or empty string). */
export function getFwCacheRaw(rec: KintoneRecord): string {
  return rec[F.config.fwRulesJson]?.value ?? "";
}

/** Update only the fw_rules_json field of an existing record (used when the
 *  cache is missing/stale and we recompute it lazily). */
export async function setFwCache(
  cfg: AppConfig,
  recordId: string,
  fwRulesJson: string,
): Promise<void> {
  try {
    await kintoneFetch(cfg, cfg.kintone.configAppToken, "/record.json", {
      method: "PUT",
      body: JSON.stringify({
        app: cfg.kintone.configAppId,
        id: recordId,
        record: { [F.config.fwRulesJson]: { value: fwRulesJson } },
      }),
    });
  } catch (err) {
    console.error("[fw-cache] failed to persist:", err);
  }
}

/** Read the persisted routing-routes JSON for a record (or empty string). */
export function getRoutingCacheRaw(rec: KintoneRecord): string {
  return rec[F.config.routingRoutesJson]?.value ?? "";
}

/** Update only the routing_routes_json field of an existing record. */
export async function setRoutingCache(
  cfg: AppConfig,
  recordId: string,
  routingRoutesJson: string,
): Promise<void> {
  try {
    await kintoneFetch(cfg, cfg.kintone.configAppToken, "/record.json", {
      method: "PUT",
      body: JSON.stringify({
        app: cfg.kintone.configAppId,
        id: recordId,
        record: { [F.config.routingRoutesJson]: { value: routingRoutesJson } },
      }),
    });
  } catch (err) {
    console.error("[routing-cache] failed to persist:", err);
  }
}

/** Read the persisted wireless (SSID + AP) JSON for a record (or empty). */
export function getWirelessCacheRaw(rec: KintoneRecord): string {
  return rec[F.config.wirelessJson]?.value ?? "";
}

/** Update only the wireless_json field of an existing record. */
export async function setWirelessCache(
  cfg: AppConfig,
  recordId: string,
  wirelessJson: string,
): Promise<void> {
  try {
    await kintoneFetch(cfg, cfg.kintone.configAppToken, "/record.json", {
      method: "PUT",
      body: JSON.stringify({
        app: cfg.kintone.configAppId,
        id: recordId,
        record: { [F.config.wirelessJson]: { value: wirelessJson } },
      }),
    });
  } catch (err) {
    console.error("[wireless-cache] failed to persist:", err);
  }
}

/** Create a new config version record. */
export async function createVersion(
  cfg: AppConfig,
  args: {
    identifiers: DeviceIdentifiers;
    generation: number;
    body: string;
    hash: string;
    size: number;
    lines: number;
    operator: string;
    operatorEmail: string;
    note?: string;
    detected?: DeviceDetection;
    fwRulesJson?: string;
    routingRoutesJson?: string;
    wirelessJson?: string;
  },
): Promise<ConfigVersion> {
  // Kintone requires each field value wrapped in { value: ... }.
  const fields: Record<string, { value: string }> = {
    [F.config.customer]: { value: args.identifiers.customer },
    [F.config.hostname]: { value: args.identifiers.hostname },
    [F.config.ipAddress]: { value: args.identifiers.ipAddress },
    [F.config.purpose]: { value: args.identifiers.purpose },
    [F.config.serialNumber]: { value: args.identifiers.serialNumber },
    [F.config.role]: { value: roleToKintone(args.identifiers.role) },
    [F.config.generation]: { value: String(args.generation) },
    [F.config.body]: { value: args.body },
    [F.config.hash]: { value: args.hash },
    [F.config.operator]: { value: args.operator },
    [F.config.operatorEmail]: { value: args.operatorEmail },
    [F.config.size]: { value: String(args.size) },
    [F.config.lines]: { value: String(args.lines) },
    [F.config.vendor]: { value: args.detected?.vendor ?? "" },
    [F.config.deviceOs]: { value: args.detected?.os ?? "" },
    [F.config.osVersion]: { value: args.detected?.osVersion ?? "" },
    [F.config.detectedModel]: { value: args.detected?.model ?? "" },
    [F.config.fwRulesJson]: { value: args.fwRulesJson ?? "" },
    [F.config.routingRoutesJson]: { value: args.routingRoutesJson ?? "" },
    [F.config.wirelessJson]: { value: args.wirelessJson ?? "" },
  };
  if (args.note) fields[F.config.note] = { value: args.note };

  const res = await kintoneFetch<{ id: string; revision: string }>(
    cfg,
    cfg.kintone.configAppToken,
    "/record.json",
    {
      method: "POST",
      body: JSON.stringify({ app: cfg.kintone.configAppId, record: fields }),
    },
  );

  return {
    id: res.id,
    generation: args.generation,
    body: args.body,
    hash: args.hash,
    operator: args.operator,
    operatorEmail: args.operatorEmail,
    createdAt: Date.now(),
    note: args.note,
    size: args.size,
    lines: args.lines,
    role: args.identifiers.role,
    detected: args.detected,
  };
}

/** Find the highest existing generation number for the given identifiers. */
export async function latestGenerationFor(
  cfg: AppConfig,
  identifiers: Partial<DeviceIdentifiers>,
): Promise<number> {
  const conds: string[] = [];
  if (identifiers.customer) {
    conds.push(`${F.config.customer} = ${JSON.stringify(identifiers.customer)}`);
  }
  if (identifiers.hostname) {
    conds.push(`${F.config.hostname} = ${JSON.stringify(identifiers.hostname)}`);
  }
  if (identifiers.ipAddress) {
    conds.push(`${F.config.ipAddress} = ${JSON.stringify(identifiers.ipAddress)}`);
  }
  if (identifiers.role) {
    conds.push(`${F.config.role} = ${JSON.stringify(roleToKintone(identifiers.role))}`);
  }
  const query = conds.join(" and ");
  const res = await kintoneFetch<{ records: KintoneRecord[] }>(
    cfg,
    cfg.kintone.configAppToken,
    "/records.json",
    {
      method: "POST",
      headers: { "X-HTTP-Method-Override": "GET" },
      body: JSON.stringify({
        app: cfg.kintone.configAppId,
        query: `${query} order by ${F.config.generation} desc limit 1`,
        fields: [F.config.generation, "$id"],
      }),
    },
  );
  if (res.records.length === 0) return 0;
  return Number.parseInt(res.records[0][F.config.generation]?.value ?? "0", 10) || 0;
}

/** Record an entry in the audit app. Failures are logged but not fatal. */
export async function writeAudit(
  cfg: AppConfig,
  entry: {
    operator: string;
    operatorEmail: string;
    action: AuditAction;
    customer?: string;
    hostname?: string;
    generation?: number;
    detail?: string;
  },
): Promise<void> {
  const fields: Record<string, { value: string }> = {
    [F.audit.operator]: { value: entry.operator },
    [F.audit.operatorEmail]: { value: entry.operatorEmail },
    [F.audit.action]: { value: entry.action },
  };
  if (entry.customer) fields[F.audit.customer] = { value: entry.customer };
  if (entry.hostname) fields[F.audit.hostname] = { value: entry.hostname };
  if (entry.generation !== undefined)
    fields[F.audit.generation] = { value: String(entry.generation) };
  if (entry.detail) fields[F.audit.detail] = { value: entry.detail };

  try {
    await kintoneFetch(
      cfg,
      cfg.kintone.auditAppToken,
      "/record.json",
      {
        method: "POST",
        body: JSON.stringify({ app: cfg.kintone.auditAppId, record: fields }),
      },
    );
  } catch (err) {
    console.error("[audit] failed to write audit entry:", err);
  }
}

/** List audit entries (most-recent first). */
export async function listAudit(
  cfg: AppConfig,
  limit = 100,
): Promise<AuditLogEntry[]> {
  const res = await kintoneFetch<{ records: KintoneRecord[] }>(
    cfg,
    cfg.kintone.auditAppToken,
    "/records.json",
    {
      method: "POST",
      headers: { "X-HTTP-Method-Override": "GET" },
      body: JSON.stringify({
        app: cfg.kintone.auditAppId,
        query: `order by $id desc limit ${limit}`,
      }),
    },
  );
  return res.records.map((rec) => {
    const val = (k: string) => rec[k]?.value ?? "";
    return {
      id: rec.$id.value,
      operator: val(F.audit.operator),
      operatorEmail: val(F.audit.operatorEmail),
      action: val(F.audit.action) as AuditAction,
      customer: val(F.audit.customer) || undefined,
      hostname: val(F.audit.hostname) || undefined,
      generation: Number.parseInt(val(F.audit.generation), 10) || undefined,
      detail: val(F.audit.detail) || undefined,
      createdAt: new Date(val("作成日時") || Date.now()).getTime(),
    } satisfies AuditLogEntry;
  });
}

/** List config records without filter. Used by full-text search and other
 *  batch-scanning endpoints. Returns raw Kintone records so callers can read
 *  both identifiers and body in one pass. */
export async function listConfigRecords(
  cfg: AppConfig,
  limit = 500,
): Promise<KintoneRecord[]> {
  const res = await kintoneFetch<{ records: KintoneRecord[] }>(
    cfg,
    cfg.kintone.configAppToken,
    "/records.json",
    {
      method: "POST",
      headers: { "X-HTTP-Method-Override": "GET" },
      body: JSON.stringify({
        app: cfg.kintone.configAppId,
        query: `order by ${F.config.generation} desc limit ${limit}`,
      }),
    },
  );
  return res.records;
}

// ===== Version metadata (edit / delete) =====
// コンフィグ管理アプリのレコードは「世代」を表す。新規作成 (createVersion) の
// ほか、誤登録の削除・後からのメタ情報編集 (purpose/note/serial 等) を提供する。
// ただしコンフィグ本文 (body)・hash・generation は編集不可 (一意性保証のため)。

/** 編集可能なバージョンメタ情報。undefined のフィールドは更新しない。 */
export interface VersionMetaUpdate {
  purpose?: string;
  note?: string;
  serialNumber?: string;
  customer?: string;
  hostname?: string;
  ipAddress?: string;
}

/** 既存バージョンのメタ情報を更新する。body/hash/generation は更新不可。
 *  存在しない ID の場合は 404 相当で例外が飛ぶ (呼び出し元で getPrivacy すること)。 */
export async function updateVersionMeta(
  cfg: AppConfig,
  id: string,
  update: VersionMetaUpdate,
): Promise<void> {
  const fields: Record<string, { value: string }> = {};
  if (update.purpose !== undefined)
    fields[F.config.purpose] = { value: update.purpose };
  if (update.note !== undefined) fields[F.config.note] = { value: update.note };
  if (update.serialNumber !== undefined)
    fields[F.config.serialNumber] = { value: update.serialNumber };
  if (update.customer !== undefined)
    fields[F.config.customer] = { value: update.customer };
  if (update.hostname !== undefined)
    fields[F.config.hostname] = { value: update.hostname };
  if (update.ipAddress !== undefined)
    fields[F.config.ipAddress] = { value: update.ipAddress };

  await kintoneFetch(cfg, cfg.kintone.configAppToken, "/record.json", {
    method: "PUT",
    body: JSON.stringify({
      app: cfg.kintone.configAppId,
      id,
      record: fields,
    }),
  });
}

/** 指定 ID のバージョンレコードを削除する。誤登録の取り消し等で使用。
 *  削除すると世代番号の歯抜けが生じるが、latestGenerationFor は最大値を追う
 *  ため重複は発生しない。世代の復元はできないので呼び出し元で確認ダイアログを表示すること。 */
export async function deleteVersion(
  cfg: AppConfig,
  id: string,
): Promise<void> {
  await kintoneFetch(cfg, cfg.kintone.configAppToken, "/records.json", {
    method: "DELETE",
    body: JSON.stringify({
      app: cfg.kintone.configAppId,
      ids: [id],
    }),
  });
}

/** 複数のバージョンレコードを一括削除する。機器（＝customer/hostname/
 *  ipAddress/role で束ねた論理デバイス）を全世代まとめて削除する用途。
 *  Kintone の DELETE /records.json は 1 回あたり最大 100 件のため、100 件ずつ
 *  分割して呼び出す。空配列なら何もしない。 */
export async function deleteVersions(
  cfg: AppConfig,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    await kintoneFetch(cfg, cfg.kintone.configAppToken, "/records.json", {
      method: "DELETE",
      body: JSON.stringify({
        app: cfg.kintone.configAppId,
        ids: chunk,
      }),
    });
  }
}

// ===== Meraki credentials (optional app) =====
// Meraki 接続情報アプリ（nw_meraki_credentials）は任意。env で
// KINTONE_MERAKI_APP_ID が未設定の場合、これらの関数は securityError を投げる。
// API 側で isEnabledMerakiCredentials() でガードして呼び出すこと。

/** Meraki 接続情報アプリが利用可能か（env で ID とトークンが設定されているか）。 */
export function isEnabledMerakiCredentials(cfg: AppConfig): boolean {
  return (
    cfg.kintone.merakiAppId.length > 0 &&
    cfg.kintone.merakiAppToken.length > 0
  );
}

function merakiAppGuard(cfg: AppConfig): void {
  if (!isEnabledMerakiCredentials(cfg)) {
    throw new Error(
      "Meraki 接続情報アプリが未設定です。KINTONE_MERAKI_APP_ID / KINTONE_MERAKI_APP_TOKEN を設定してください。",
    );
  }
}

function toMerakiCredential(rec: KintoneRecord): MerakiCredential {
  const val = (k: string) => rec[k]?.value ?? "";
  return {
    id: rec.$id.value,
    label: val(F.meraki.label),
    networkId: val(F.meraki.networkId),
    apiKey: val(F.meraki.apiKey),
    defaultCustomer: val(F.meraki.defaultCustomer) || undefined,
    defaultHostname: val(F.meraki.defaultHostname) || undefined,
    memo: val(F.meraki.memo) || undefined,
    updatedAt: new Date(val("更新日時") || Date.now()).getTime(),
  };
}

/** 登録済み Meraki 接続情報を一覧取得する。 */
export async function listMerakiCredentials(
  cfg: AppConfig,
): Promise<MerakiCredential[]> {
  merakiAppGuard(cfg);
  const res = await kintoneFetch<{ records: KintoneRecord[] }>(
    cfg,
    cfg.kintone.merakiAppToken,
    "/records.json",
    {
      method: "POST",
      headers: { "X-HTTP-Method-Override": "GET" },
      body: JSON.stringify({
        app: cfg.kintone.merakiAppId,
        query: `order by $id desc limit 500`,
      }),
    },
  );
  return res.records.map(toMerakiCredential);
}

/** Meraki 接続情報を 1 件取得する。 */
export async function getMerakiCredential(
  cfg: AppConfig,
  id: string,
): Promise<MerakiCredential | null> {
  merakiAppGuard(cfg);
  try {
    const res = await kintoneFetch<KintoneGetRecordResponse>(
      cfg,
      cfg.kintone.merakiAppToken,
      "/record.json",
      {
        method: "POST",
        headers: { "X-HTTP-Method-Override": "GET" },
        body: JSON.stringify({ app: cfg.kintone.merakiAppId, id }),
      },
    );
    return toMerakiCredential(res.record);
  } catch {
    return null;
  }
}

/** Meraki 接続情報を新規登録する。 */
export async function createMerakiCredential(
  cfg: AppConfig,
  args: {
    label: string;
    networkId: string;
    apiKey: string;
    defaultCustomer?: string;
    defaultHostname?: string;
    memo?: string;
  },
): Promise<MerakiCredential> {
  merakiAppGuard(cfg);
  const fields: Record<string, { value: string }> = {
    [F.meraki.label]: { value: args.label },
    [F.meraki.networkId]: { value: args.networkId },
    [F.meraki.apiKey]: { value: args.apiKey },
  };
  if (args.defaultCustomer)
    fields[F.meraki.defaultCustomer] = { value: args.defaultCustomer };
  if (args.defaultHostname)
    fields[F.meraki.defaultHostname] = { value: args.defaultHostname };
  if (args.memo) fields[F.meraki.memo] = { value: args.memo };

  const res = await kintoneFetch<{ id: string; revision: string }>(
    cfg,
    cfg.kintone.merakiAppToken,
    "/record.json",
    {
      method: "POST",
      body: JSON.stringify({ app: cfg.kintone.merakiAppId, record: fields }),
    },
  );
  return {
    id: res.id,
    label: args.label,
    networkId: args.networkId,
    apiKey: args.apiKey,
    defaultCustomer: args.defaultCustomer,
    defaultHostname: args.defaultHostname,
    memo: args.memo,
    updatedAt: Date.now(),
  };
}

/** Meraki 接続情報を更新する。未指定のフィールドは更新しない。 */
export async function updateMerakiCredential(
  cfg: AppConfig,
  id: string,
  args: Partial<{
    label: string;
    networkId: string;
    apiKey: string;
    defaultCustomer: string;
    defaultHostname: string;
    memo: string;
  }>,
): Promise<void> {
  merakiAppGuard(cfg);
  const fields: Record<string, { value: string }> = {};
  if (args.label !== undefined) fields[F.meraki.label] = { value: args.label };
  if (args.networkId !== undefined)
    fields[F.meraki.networkId] = { value: args.networkId };
  if (args.apiKey !== undefined) fields[F.meraki.apiKey] = { value: args.apiKey };
  if (args.defaultCustomer !== undefined)
    fields[F.meraki.defaultCustomer] = { value: args.defaultCustomer };
  if (args.defaultHostname !== undefined)
    fields[F.meraki.defaultHostname] = { value: args.defaultHostname };
  if (args.memo !== undefined) fields[F.meraki.memo] = { value: args.memo };

  await kintoneFetch(cfg, cfg.kintone.merakiAppToken, "/record.json", {
    method: "PUT",
    body: JSON.stringify({
      app: cfg.kintone.merakiAppId,
      id,
      record: fields,
    }),
  });
}

/** Meraki 接続情報を削除する。 */
export async function deleteMerakiCredential(
  cfg: AppConfig,
  id: string,
): Promise<void> {
  merakiAppGuard(cfg);
  await kintoneFetch(cfg, cfg.kintone.merakiAppToken, "/records.json", {
    method: "DELETE",
    body: JSON.stringify({
      app: cfg.kintone.merakiAppId,
      ids: [id],
    }),
  });
}
