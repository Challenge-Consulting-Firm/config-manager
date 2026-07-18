/**
 * API routes (all mounted under /api). Every route requires an authenticated
 * session established by the /auth/* routes.
 */

import { Hono } from "hono";
import type { AppConfig } from "./config.js";
import type { Session } from "./session.js";
import {
  createVersion,
  detectedFromRecord,
  getVersionRecord,
  getFwCacheRaw,
  identifiersFromRecord,
  latestGenerationFor,
  listAudit,
  listVersions,
  setFwCache,
  writeAudit,
} from "./kintone.js";
import {
  diffConfigs,
  detectDeviceInfo,
  extractFirewallRules,
  normalizeConfig,
  parseFirewallCache,
  serializeFirewallRules,
} from "@config-manager/shared";
import type {
  AuthUser,
  ConfigVersion,
  Device,
  Role,
} from "@config-manager/shared";

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

/** GET /api/audit — recent operator activity. */
api.get("/audit", async (c) => {
  const limit = Math.min(
    Number.parseInt(c.req.query("limit") ?? "100", 10) || 100,
    500,
  );
  const entries = await listAudit(c.var.cfg, limit);
  return c.json({ entries });
});
