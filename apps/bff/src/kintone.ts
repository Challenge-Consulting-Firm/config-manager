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

/** List config versions, optionally filtered by identifiers. */
export async function listVersions(
  cfg: AppConfig,
  filter: Partial<DeviceIdentifiers>,
): Promise<ConfigVersion[]> {
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
  const query = conds.length
    ? conds.join(" and ")
    : "";
  const res = await kintoneFetch<{
    records: KintoneRecord[];
  }>(cfg, cfg.kintone.configAppToken, "/records.json", {
    method: "POST",
    headers: {
      "X-HTTP-Method-Override": "GET",
    },
    body: JSON.stringify({
      app: cfg.kintone.configAppId,
      query: `${query} order by ${F.config.generation} desc limit 500`,
    }),
  });
  return res.records.map(toConfigVersion);
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
