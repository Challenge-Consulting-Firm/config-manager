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
  HelperOsHint,
  HelperProtocol,
  MerakiCredential,
  NodeCredentialCandidate,
  NodeCredentialField,
  NodeCredentialHint,
  Role,
} from "@config-manager/shared";
import { ROLE_LABELS } from "@config-manager/shared";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from "./secretCrypto.js";

/**
 * Best-effort: when a legacy plaintext api_key is loaded and encryption is
 * configured, rewrite the Kintone row as ciphertext so the next operator who
 * merely *reads* a credential also migrates it. Failures are logged only.
 */
async function maybeReencryptMerakiApiKey(
  cfg: AppConfig,
  id: string,
  storedRaw: string,
): Promise<void> {
  if (!cfg.credentialsEncryptionKey) return;
  if (!storedRaw || isEncryptedSecret(storedRaw)) return;
  try {
    const cipher = encryptSecret(storedRaw, cfg.credentialsEncryptionKey);
    await kintoneFetch(cfg, cfg.kintone.merakiAppToken, "/record.json", {
      method: "PUT",
      body: JSON.stringify({
        app: cfg.kintone.merakiAppId,
        id,
        record: { [F.meraki.apiKey]: { value: cipher } },
      }),
    });
    console.info(`[meraki-cred] re-encrypted plaintext api_key for id=${id}`);
  } catch (err) {
    console.error(`[meraki-cred] failed to re-encrypt id=${id}:`, err);
  }
}

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
  // 顧客情報（ノード管理）アプリ（任意・読み取り専用）
  // 既存の社内アプリを参照するため、フィールドコードは日本語のまま。
  // config-manager 側の命名規則には合わせられない（アプリ側の正本が優先）。
  customerInfo: {
    customerName: "顧客名",
    nodeName: "名前",
    ipAddress: "IPアドレス",
    accountName: "アカウント名",
    password: "パスワード",
    systemType: "システム種別_詳細区分",
    note: "備考",
    target: "対象",
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
  opts: {
    /**
     * true のとき、監査の書き込みに失敗したら例外を投げる。
     *
     * 既定（false）はベストエフォートで、監査が書けなくても操作自体は続行する。
     * 機器認証情報の参照のように「記録できないなら実行してはいけない」操作では
     * true を渡し、呼び出し側で操作を中止すること。
     */
    failClosed?: boolean;
  } = {},
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
    if (opts.failClosed) throw err;
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

function toMerakiCredential(
  rec: KintoneRecord,
  cfg: AppConfig,
): MerakiCredential {
  const val = (k: string) => rec[k]?.value ?? "";
  const storedKey = val(F.meraki.apiKey);
  // Decrypt at the boundary so callers always see the usable plaintext key.
  // Legacy plaintext rows pass through and are rewritten asynchronously.
  const apiKey = decryptSecret(storedKey, cfg.credentialsEncryptionKey);
  // Fire-and-forget migration; do not await inside the mapper.
  void maybeReencryptMerakiApiKey(cfg, rec.$id.value, storedKey);
  return {
    id: rec.$id.value,
    label: val(F.meraki.label),
    networkId: val(F.meraki.networkId),
    apiKey,
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
  return res.records.map((r) => toMerakiCredential(r, cfg));
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
    return toMerakiCredential(res.record, cfg);
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
  const storedKey = encryptSecret(args.apiKey, cfg.credentialsEncryptionKey);
  const fields: Record<string, { value: string }> = {
    [F.meraki.label]: { value: args.label },
    [F.meraki.networkId]: { value: args.networkId },
    [F.meraki.apiKey]: { value: storedKey },
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
    // Return the plaintext key to the caller; the Kintone row holds ciphertext.
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
  if (args.apiKey !== undefined) {
    fields[F.meraki.apiKey] = {
      value: encryptSecret(args.apiKey, cfg.credentialsEncryptionKey),
    };
  }
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

// ===== 顧客情報（ノード管理）アプリ =====
// 社内の既存アプリに登録済みの機器アカウントを、ローカル取得ヘルパーの
// ログインへ適用するための読み取り専用アクセス（Issue #53）。
//
// 【設計上の約束】
//   - 書き込みは一切行わない（API トークンも閲覧のみで発行する）。
//   - パスワードは候補一覧の経路では読まない。単一レコード取得でのみ読む。
//   - 照合用の正規化はキー項目にのみ適用し、パスワード本文には適用しない。

// `システム種別_詳細区分` によるホワイトリスト絞り込みは廃止した。
//
// 当初は「NW 機器だけを候補に出す」ための露出制限として入れたが、
//   - 参照元アプリは社内全員が閲覧できるため（Issue #53 決定 B）、ここで絞っても
//     実効的な保護にならない
//   - 区分はアプリ側で自由に増える値で、追加のたびにコード修正が必要になる
//   - 実際、区分が未設定の実在機器を軒並み除外してしまい、候補に出せなかった
// という理由で、守っているものに対して害が大きすぎた。
//
// 実質的なゲートは以下で、これらは維持している。
//   - IP アドレスの正規化後の完全一致（機器コンテキスト無しには引けない）
//   - トークンのレコード ID 束縛（発行時に IP で再検証する）
//   - 監査ログ（fail closed）
// 区分は候補一覧に表示するので、利用者が見て選べる（自動選択はしない）。

/** `対象` が明示的にこの値のレコードは候補から除外する（空欄は対象に含める）。 */
const TARGET_EXCLUDED = "削除・管理外";

/**
 * ゼロ幅スペース類と BOM。
 *
 * このアプリのデータは Excel からの貼り付け痕跡とみられる `U+200B` を広範に
 * 含んでおり（調査時点で IP 75 件 / アカウント名 94 件 / パスワード 102 件）、
 * 除去しないと IP の完全一致が成立しない。
 *
 * 【重要】除去してよいのは照合キーだけ。パスワードは任意の文字列であり、
 * 不可視文字を含む正当なパスワードを壊しうるため、既定では触らない。
 */
const INVISIBLE_CHARS = /[\u200B-\u200D\uFEFF]/g;

/** 照合キー用の正規化。不可視文字の除去と前後空白の除去のみを行う。 */
function normalizeLookupValue(raw: string): string {
  return raw.replace(INVISIBLE_CHARS, "").trim();
}

/** 値に不可視文字（または前後空白）が含まれるか。UI の警告表示に使う。 */
function hasInvisibleChars(raw: string): boolean {
  if (!raw) return false;
  return normalizeLookupValue(raw) !== raw;
}

/** 顧客情報アプリが env で有効化されているか。 */
export function isEnabledCustomerInfo(cfg: AppConfig): boolean {
  return (
    cfg.kintone.customerInfoAppId.length > 0 &&
    cfg.kintone.customerInfoAppToken.length > 0
  );
}

function customerInfoGuard(cfg: AppConfig): void {
  if (!isEnabledCustomerInfo(cfg)) {
    throw new Error(
      "顧客情報アプリが未設定です。KINTONE_CUSTOMER_INFO_APP_ID / KINTONE_CUSTOMER_INFO_APP_TOKEN を設定してください。",
    );
  }
}

/**
 * 候補検索の対象レコード（パスワードを含まない）。
 *
 * Kintone の `like` はテキストのトークン化に依存し、IP アドレスのような文字列
 * では期待どおりに絞り込めないことがある。対象アプリは 700 件規模と小さいので、
 * **クエリで絞らず全件を取得して JS 側で正規化・完全一致**させるほうが確実で、
 * クエリ文字列のエスケープ問題も避けられる。
 */
interface CustomerInfoRow {
  id: string;
  customerName: string;
  nodeName: string;
  ipAddress: string;
  accountName: string;
  systemType: string;
  note: string;
  /** 不可視文字を含んでいたキー項目（パスワードは単一取得時に判定する）。 */
  dirtyFields: NodeCredentialField[];
}

/** 全件取得のページサイズ（Kintone の上限）。 */
const CUSTOMER_INFO_PAGE_SIZE = 500;
/** 取得するページ数の上限。アプリが想定外に肥大化した場合の保険。 */
const CUSTOMER_INFO_MAX_PAGES = 10;
/**
 * 全件キャッシュの有効期間 (ms)。
 *
 * 長くすると Kintone への往復は減るが、「機器を登録した直後に取得を試す」
 * という一番ありがちな流れで候補が出ず、原因の分からない待ちが発生する。
 * 対象は 700 件規模（1 回あたり 2 リクエスト）で取得コストが小さいため、
 * 反映の速さを優先して短めに倒している。
 */
const CUSTOMER_INFO_CACHE_TTL_MS = 60_000;

let customerInfoCache: { rows: CustomerInfoRow[]; fetchedAt: number } | null =
  null;

/** テストおよび設定変更時にキャッシュを捨てる。 */
export function clearCustomerInfoCache(): void {
  customerInfoCache = null;
}

/**
 * 顧客情報アプリの全レコードを取得する（パスワードは取得しない）。
 * 一定時間はプロセス内にキャッシュする。
 */
async function loadCustomerInfoRows(
  cfg: AppConfig,
): Promise<CustomerInfoRow[]> {
  customerInfoGuard(cfg);
  const now = Date.now();
  if (
    customerInfoCache &&
    now - customerInfoCache.fetchedAt < CUSTOMER_INFO_CACHE_TTL_MS
  ) {
    return customerInfoCache.rows;
  }

  const C = F.customerInfo;
  // パスワードは意図的に fields から外す。候補一覧の経路で平文を読み込まない。
  const fields = [
    "$id",
    C.customerName,
    C.nodeName,
    C.ipAddress,
    C.accountName,
    C.systemType,
    C.note,
    C.target,
  ];

  const rows: CustomerInfoRow[] = [];
  for (let page = 0; page < CUSTOMER_INFO_MAX_PAGES; page++) {
    const offset = page * CUSTOMER_INFO_PAGE_SIZE;
    const res = await kintoneFetch<{ records: KintoneRecord[] }>(
      cfg,
      cfg.kintone.customerInfoAppToken,
      "/records.json",
      {
        method: "POST",
        headers: { "X-HTTP-Method-Override": "GET" },
        body: JSON.stringify({
          app: cfg.kintone.customerInfoAppId,
          query: `order by $id asc limit ${CUSTOMER_INFO_PAGE_SIZE} offset ${offset}`,
          fields,
        }),
      },
    );
    const batch = res.records ?? [];
    for (const rec of batch) {
      const raw = (k: string) => rec[k]?.value ?? "";
      if (normalizeLookupValue(raw(C.target)) === TARGET_EXCLUDED) continue;

      const rawNode = raw(C.nodeName);
      const rawIp = raw(C.ipAddress);
      const rawAccount = raw(C.accountName);
      const dirty: NodeCredentialField[] = [];
      if (hasInvisibleChars(rawNode)) dirty.push("nodeName");
      if (hasInvisibleChars(rawIp)) dirty.push("ipAddress");
      if (hasInvisibleChars(rawAccount)) dirty.push("accountName");

      rows.push({
        id: rec.$id.value,
        customerName: normalizeLookupValue(raw(C.customerName)),
        nodeName: normalizeLookupValue(rawNode),
        ipAddress: normalizeLookupValue(rawIp),
        accountName: normalizeLookupValue(rawAccount),
        systemType: normalizeLookupValue(raw(C.systemType)),
        note: raw(C.note),
        dirtyFields: dirty,
      });
    }
    if (batch.length < CUSTOMER_INFO_PAGE_SIZE) break;
    if (page === CUSTOMER_INFO_MAX_PAGES - 1) {
      console.warn(
        `[customer-info] reached the ${CUSTOMER_INFO_MAX_PAGES}-page cap ` +
          `(${rows.length} records). Later records are not searched — raise the cap.`,
      );
    }
  }

  customerInfoCache = { rows, fetchedAt: now };
  return rows;
}

/**
 * `備考` の自由記述から接続ヒントを推定する。**初期値の提案にのみ使う**。
 *
 * プロトコルが読み取れない場合は null を返し、Telnet へは倒さない
 * （誤推定で平文接続に落ちるのを避けるため）。
 */
export function inferNodeCredentialHint(note: string): NodeCredentialHint {
  const reasons: string[] = [];
  let protocol: HelperProtocol | null = null;
  let osHint: HelperOsHint | null = null;

  if (/ssh/i.test(note)) {
    protocol = "ssh";
    reasons.push("備考に「SSH」の記載");
  } else if (/telnet/i.test(note)) {
    protocol = "telnet";
    reasons.push("備考に「Telnet」の記載");
  }

  if (/SWX/i.test(note)) {
    osHint = "yamaha-swx";
    reasons.push("備考に YAMAHA SWX の記載");
  } else if (/YAMAHA|RTX\s*\d|FWX\s*\d|NVR\s*\d/i.test(note)) {
    osHint = "yamaha-rt";
    reasons.push("備考に YAMAHA ルーターの記載");
  } else if (/cisco|catalyst/i.test(note)) {
    osHint = "cisco-ios";
    reasons.push("備考に Cisco の記載");
  }

  return { protocol, osHint, reason: reasons.join(" / ") };
}

/**
 * 対象機器に対する認証情報の候補を返す。
 *
 * 突合は **IP アドレスの正規化後の完全一致**のみで行う。顧客名とホスト名は
 * 絞り込みには使わず、並び順（一致するものを上位へ）と UI 表示に使う。
 * 同一 IP が複数顧客に存在しうるため、呼び出し側は候補が 1 件でも自動確定
 * してはならない。
 */
export async function listNodeCredentials(
  cfg: AppConfig,
  target: { ipAddress: string; hostname?: string; customer?: string },
): Promise<NodeCredentialCandidate[]> {
  const ip = normalizeLookupValue(target.ipAddress);
  if (!ip) return [];

  const rows = await loadCustomerInfoRows(cfg);
  const hostname = normalizeLookupValue(target.hostname ?? "");
  const customer = normalizeLookupValue(target.customer ?? "");

  const candidates = rows
    .filter((row) => row.ipAddress === ip)
    .map<NodeCredentialCandidate>((row) => ({
      id: row.id,
      customerName: row.customerName,
      nodeName: row.nodeName,
      ipAddress: row.ipAddress,
      accountName: row.accountName,
      systemType: row.systemType,
      note: row.note,
      // 顧客名は形式が異なる（app 側は "1004 野原ホールディングス"）ため、
      // 部分一致で「一致っぽさ」を見るに留める。一致しなくても候補から外さない。
      matchesCustomer:
        customer.length > 0 &&
        (row.customerName.includes(customer) ||
          customer.includes(row.customerName)),
      matchesHostname:
        hostname.length > 0 &&
        row.nodeName.toLowerCase() === hostname.toLowerCase(),
      invisibleCharFields: row.dirtyFields,
      hint: inferNodeCredentialHint(row.note),
    }));

  // 対象機器と一致する候補を上位に。次いでアカウント名で安定ソート。
  const score = (c: NodeCredentialCandidate) =>
    (c.matchesHostname ? 2 : 0) + (c.matchesCustomer ? 1 : 0);
  return candidates.sort((a, b) => {
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    return a.accountName.localeCompare(b.accountName);
  });
}

/** {@link getNodeCredentialSecret} が返す平文。ログへ出さないこと。 */
export interface NodeCredentialSecret {
  username: string;
  password: string;
  /** 監査ログ用の識別情報（機密ではない）。 */
  customerName: string;
  nodeName: string;
  ipAddress: string;
}

/**
 * レコード 1 件の平文パスワードを取得する。
 *
 * 呼び出し側は必ず対象機器のコンテキスト（IP）を検証済みであること。トークン
 * 発行時に候補一覧を引き直して突合しているため、ここへ到達する ID は対象機器の
 * IP と一致するレコードに限られる。この関数では `対象` のみ再確認する。
 *
 * `stripInvisible` が true のときだけパスワードの不可視文字を除去する。既定は
 * false で、Kintone に入っている値をそのまま返す。
 */
export async function getNodeCredentialSecret(
  cfg: AppConfig,
  id: string,
  opts: { stripInvisible?: boolean } = {},
): Promise<NodeCredentialSecret | null> {
  customerInfoGuard(cfg);
  const C = F.customerInfo;

  let rec: KintoneRecord;
  try {
    const res = await kintoneFetch<KintoneGetRecordResponse>(
      cfg,
      cfg.kintone.customerInfoAppToken,
      "/record.json",
      {
        method: "POST",
        headers: { "X-HTTP-Method-Override": "GET" },
        body: JSON.stringify({ app: cfg.kintone.customerInfoAppId, id }),
      },
    );
    rec = res.record;
  } catch {
    return null;
  }

  const raw = (k: string) => rec[k]?.value ?? "";
  if (normalizeLookupValue(raw(C.target)) === TARGET_EXCLUDED) return null;

  const storedPassword = raw(C.password);
  return {
    username: normalizeLookupValue(raw(C.accountName)),
    // 既定では手を加えない。除去は利用者が明示的に選んだときだけ。
    password: opts.stripInvisible
      ? normalizeLookupValue(storedPassword)
      : storedPassword,
    customerName: normalizeLookupValue(raw(C.customerName)),
    nodeName: normalizeLookupValue(raw(C.nodeName)),
    ipAddress: normalizeLookupValue(raw(C.ipAddress)),
  };
}
