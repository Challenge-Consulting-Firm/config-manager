/**
 * Wireless (SSID / access point) extraction.
 *
 * Meraki MR configuration is captured in the serialized network dump (see
 * meraki.ts). This module turns that dump into two flat, listable snapshots:
 *   - SSIDs         from the `Wireless / SSIDs` section (/wireless/ssids)
 *   - Access points from the `! ===== Devices =====` block (productType=wireless)
 *
 * Like firewall.ts / routing.ts, extraction results are cached to Kintone
 * (keyed by body hash), presented in a table, exported, and diffed across
 * generations. The snapshot is a "static point": AP inventory + SSID settings
 * as they stood when the config generation was captured — not live status.
 *
 * Only Meraki dumps carry wireless data; other vendors yield empty results.
 */

import type { DeviceDetection } from "./detect.js";
import { collectMerakiJsonBlocks } from "./firewall.js";
import type {
  WirelessAccessPoint,
  WirelessAccessPointChange,
  WirelessDiff,
  WirelessSsid,
  WirelessSsidChange,
} from "./types.js";

// ----- cache (de)serialization -----

/** Wrapper shape persisted to Kintone. `bodyHash` lets readers verify the
 *  cache is still valid for the current config body. */
export interface WirelessCache {
  bodyHash: string;
  version: number; // schema version of this cache payload
  ssids: WirelessSsid[];
  accessPoints: WirelessAccessPoint[];
}

// v1: initial wireless (SSID + AP) extraction.
export const WIRELESS_CACHE_VERSION = 1;

/** The parsed extraction result (both lists together). */
export interface WirelessExtraction {
  ssids: WirelessSsid[];
  accessPoints: WirelessAccessPoint[];
}

/** Serialize the extraction to a compact JSON string for storage. */
export function serializeWireless(
  extraction: WirelessExtraction,
  bodyHash: string,
): string {
  const cache: WirelessCache = {
    bodyHash,
    version: WIRELESS_CACHE_VERSION,
    ssids: extraction.ssids,
    accessPoints: extraction.accessPoints,
  };
  return JSON.stringify(cache);
}

/** Parse a cached JSON string back into an extraction. Returns null if the
 *  cache is missing, malformed, or belongs to a different body hash / schema
 *  version. */
export function parseWirelessCache(
  stored: string,
  expectedBodyHash: string,
): WirelessExtraction | null {
  if (!stored || !stored.trim()) return null;
  try {
    const cache = JSON.parse(stored) as WirelessCache;
    if (
      cache.version !== WIRELESS_CACHE_VERSION ||
      cache.bodyHash !== expectedBodyHash ||
      !Array.isArray(cache.ssids) ||
      !Array.isArray(cache.accessPoints)
    ) {
      return null;
    }
    return { ssids: cache.ssids, accessPoints: cache.accessPoints };
  } catch {
    return null;
  }
}

// ----- helpers -----

function asString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v);
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return undefined;
}

/** Join Meraki RADIUS server entries `[{ host, port }]` into "host:port, ...". */
function formatRadiusServers(v: unknown): string {
  if (!Array.isArray(v)) return "";
  const parts: string[] = [];
  for (const s of v) {
    if (s === null || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const host = asString(o.host);
    if (!host) continue;
    const port = asString(o.port);
    parts.push(port ? `${host}:${port}` : host);
  }
  return parts.join(", ");
}

// ----- SSID extraction (Meraki /wireless/ssids) -----

/** True when a JSON value looks like a Meraki SSID entry. SSID objects carry a
 *  `number` slot and (almost always) `authMode`; we also accept the presence
 *  of `ssidAdminAccessible` / `splashPage` as corroborating signals so hidden
 *  or open SSIDs are still recognized. */
function looksLikeSsid(o: Record<string, unknown>): boolean {
  if (!("number" in o)) return false;
  return (
    "authMode" in o ||
    "ssidAdminAccessible" in o ||
    "splashPage" in o ||
    "ipAssignmentMode" in o
  );
}

function ssidFromObject(o: Record<string, unknown>, vendor: string): WirelessSsid {
  const vlanId = asNumber(o.defaultVlanId ?? o.vlanId);
  const attrParts: string[] = [];
  const minBitrate = asNumber(o.minBitrate);
  if (minBitrate !== undefined) attrParts.push(`minBitrate=${minBitrate}`);
  const availability = asString(o.availabilityTags);
  if (availability) attrParts.push(`availabilityTags=${availability}`);
  const lanIsolation = o.lanIsolationEnabled;
  if (lanIsolation === true) attrParts.push("lanIsolation");
  const mandatoryDhcp = (o.mandatoryDhcp as Record<string, unknown> | undefined)
    ?.enabled;
  if (mandatoryDhcp === true) attrParts.push("mandatoryDhcp");

  return {
    vendor,
    number: asNumber(o.number) ?? 0,
    name: asString(o.name),
    enabled: o.enabled === true,
    authMode: asString(o.authMode),
    encryptionMode: asString(o.encryptionMode),
    wpaEncryptionMode: asString(o.wpaEncryptionMode),
    ipAssignmentMode: asString(o.ipAssignmentMode),
    vlanId,
    useVlanTagging: o.useVlanTagging === true || vlanId !== undefined,
    bandSelection: asString(o.bandSelection),
    perClientBandwidthLimitDown: asNumber(o.perClientBandwidthLimitDown),
    perClientBandwidthLimitUp: asNumber(o.perClientBandwidthLimitUp),
    visible: o.visible !== false,
    radiusServers: formatRadiusServers(o.radiusServers),
    splashPage: asString(o.splashPage),
    attributes: attrParts.length ? attrParts.join(" ") : undefined,
    raw: JSON.stringify(o),
  };
}

/** Extract SSIDs from a serialized Meraki dump. Scans every embedded JSON
 *  block and keeps the entries that look like SSID objects, so it works on the
 *  raw dump (with `! ===== ... =====` headers) and on the normalized body
 *  (comment lines stripped). */
function extractMerakiSsids(text: string, vendor: string): WirelessSsid[] {
  const ssids: WirelessSsid[] = [];
  const seen = new Set<number>();
  for (const { value } of collectMerakiJsonBlocks(text)) {
    // SSIDs come as an array; guard against a single-object shape too.
    const arr: unknown[] = Array.isArray(value)
      ? value
      : value !== null && typeof value === "object"
        ? [value]
        : [];
    // Require the block to be genuinely SSID-shaped: at least one entry must
    // look like an SSID. This skips VLANs/routes/other JSON sections.
    const isSsidBlock = arr.some(
      (e) => e !== null && typeof e === "object" && looksLikeSsid(e as Record<string, unknown>),
    );
    if (!isSsidBlock) continue;
    for (const e of arr) {
      if (e === null || typeof e !== "object") continue;
      const o = e as Record<string, unknown>;
      if (!looksLikeSsid(o)) continue;
      const num = asNumber(o.number) ?? 0;
      // De-dup on slot number in case both raw and normalized copies appear.
      if (seen.has(num)) continue;
      seen.add(num);
      ssids.push(ssidFromObject(o, vendor));
    }
  }
  ssids.sort((a, b) => a.number - b.number);
  return ssids;
}

// ----- Access point extraction (Meraki Devices block) -----

/** Parse the `device ...` lines emitted by serializeMerakiConfig into APs.
 *  Only wireless devices (product=wireless) are kept. Each line has the form:
 *    device serial=Q2XX model=MR33 name=AP1 product=wireless mac=.. firmware=.. lanIp=.. publicIp=..
 *  Values never contain spaces in practice (names with spaces are rare on APs);
 *  we split on whitespace and parse key=value tokens. */
function extractMerakiAccessPoints(text: string, vendor: string): WirelessAccessPoint[] {
  const aps: WirelessAccessPoint[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("device ")) continue;
    const tokens = line.slice("device ".length).trim().split(/\s+/);
    const kv: Record<string, string> = {};
    for (const tok of tokens) {
      const eq = tok.indexOf("=");
      if (eq <= 0) continue;
      kv[tok.slice(0, eq)] = tok.slice(eq + 1);
    }
    if (kv.product !== "wireless") continue;
    const serial = kv.serial && kv.serial !== "-" ? kv.serial : "";
    // De-dup on serial (or full line when serial missing).
    const dedupKey = serial || line;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const clean = (v?: string) => (v && v !== "-" ? v : "");
    aps.push({
      vendor,
      name: clean(kv.name),
      model: clean(kv.model),
      serial,
      mac: clean(kv.mac),
      firmware: clean(kv.firmware),
      lanIp: clean(kv.lanIp),
      publicIp: clean(kv.publicIp),
      raw: line,
    });
  }
  aps.sort((a, b) => (a.name || a.serial).localeCompare(b.name || b.serial));
  return aps;
}

// ----- dispatcher -----

/** True when the body is a Meraki dump (fixed header) or clearly carries
 *  wireless SSID JSON. */
function isMerakiWireless(body: string): boolean {
  return (
    body.includes("Meraki Network Configuration Dump") ||
    /"authMode"\s*:/.test(body) ||
    /Wireless\s*\/\s*SSIDs/.test(body)
  );
}

/** Extract wireless SSIDs + access points from a config body. Only Meraki
 *  dumps carry wireless data; for any other vendor this returns empty lists.
 *  The `detection` argument is accepted for parity with the FW/routing
 *  extractors but wireless extraction is structural (Meraki-only). */
export function extractWireless(
  body: string,
  detection: DeviceDetection | undefined,
): WirelessExtraction {
  if (!body) return { ssids: [], accessPoints: [] };
  const vendor = detection?.vendor || "Cisco Meraki";
  if (!isMerakiWireless(body) && vendor !== "Cisco Meraki") {
    return { ssids: [], accessPoints: [] };
  }
  return {
    ssids: extractMerakiSsids(body, "Cisco Meraki"),
    accessPoints: extractMerakiAccessPoints(body, "Cisco Meraki"),
  };
}

// ----- presentation helpers -----

/** Japanese label for a Meraki auth mode. */
export function wirelessAuthModeLabel(authMode: string): string {
  switch (authMode) {
    case "open":
      return "オープン";
    case "psk":
      return "PSK";
    case "8021x-radius":
      return "802.1X (RADIUS)";
    case "8021x-meraki":
      return "802.1X (Meraki)";
    case "open-with-radius":
      return "オープン + RADIUS";
    case "ipsk-with-radius":
      return "iPSK (RADIUS)";
    case "ipsk-without-radius":
      return "iPSK";
    default:
      return authMode || "-";
  }
}

// ----- structural diff -----

/** SSIDs are identified by slot number (stable across generations). */
function ssidKey(s: WirelessSsid): number {
  return s.number;
}

/** Full equality of two SSIDs, ignoring only the raw JSON text. */
function ssidsEqual(a: WirelessSsid, b: WirelessSsid): boolean {
  return (
    a.name === b.name &&
    a.enabled === b.enabled &&
    a.authMode === b.authMode &&
    a.encryptionMode === b.encryptionMode &&
    a.wpaEncryptionMode === b.wpaEncryptionMode &&
    a.ipAssignmentMode === b.ipAssignmentMode &&
    (a.vlanId ?? -1) === (b.vlanId ?? -1) &&
    a.useVlanTagging === b.useVlanTagging &&
    a.bandSelection === b.bandSelection &&
    (a.perClientBandwidthLimitDown ?? 0) === (b.perClientBandwidthLimitDown ?? 0) &&
    (a.perClientBandwidthLimitUp ?? 0) === (b.perClientBandwidthLimitUp ?? 0) &&
    a.visible === b.visible &&
    a.radiusServers === b.radiusServers &&
    a.splashPage === b.splashPage &&
    (a.attributes ?? "") === (b.attributes ?? "")
  );
}

/** APs are identified by serial (falls back to name when serial is missing). */
function apKey(a: WirelessAccessPoint): string {
  return a.serial || `name:${a.name}`;
}

/** Full equality of two APs, ignoring only the raw text. */
function apsEqual(a: WirelessAccessPoint, b: WirelessAccessPoint): boolean {
  return (
    a.name === b.name &&
    a.model === b.model &&
    a.mac === b.mac &&
    a.firmware === b.firmware &&
    a.lanIp === b.lanIp &&
    a.publicIp === b.publicIp
  );
}

/** Compute a structural diff between two wireless snapshots. SSIDs are paired
 *  by slot number, access points by serial. */
export function diffWireless(
  before: WirelessExtraction,
  after: WirelessExtraction,
): WirelessDiff {
  // ----- SSIDs -----
  const beforeSsids = new Map<number, WirelessSsid>();
  for (const s of before.ssids) beforeSsids.set(ssidKey(s), s);
  const afterSsids = new Map<number, WirelessSsid>();
  for (const s of after.ssids) afterSsids.set(ssidKey(s), s);

  const ssidAdded: WirelessSsid[] = [];
  const ssidRemoved: WirelessSsid[] = [];
  const ssidChanged: WirelessSsidChange[] = [];
  let ssidUnchanged = 0;

  const ssidKeys = new Set<number>([
    ...beforeSsids.keys(),
    ...afterSsids.keys(),
  ]);
  for (const k of ssidKeys) {
    const b = beforeSsids.get(k);
    const a = afterSsids.get(k);
    if (b && a) {
      if (ssidsEqual(b, a)) ssidUnchanged++;
      else ssidChanged.push({ before: b, after: a });
    } else if (a) {
      ssidAdded.push(a);
    } else if (b) {
      ssidRemoved.push(b);
    }
  }

  // ----- Access points -----
  const beforeAps = new Map<string, WirelessAccessPoint>();
  for (const a of before.accessPoints) beforeAps.set(apKey(a), a);
  const afterAps = new Map<string, WirelessAccessPoint>();
  for (const a of after.accessPoints) afterAps.set(apKey(a), a);

  const apAdded: WirelessAccessPoint[] = [];
  const apRemoved: WirelessAccessPoint[] = [];
  const apChanged: WirelessAccessPointChange[] = [];
  let apUnchanged = 0;

  const apKeys = new Set<string>([...beforeAps.keys(), ...afterAps.keys()]);
  for (const k of apKeys) {
    const b = beforeAps.get(k);
    const a = afterAps.get(k);
    if (b && a) {
      if (apsEqual(b, a)) apUnchanged++;
      else apChanged.push({ before: b, after: a });
    } else if (a) {
      apAdded.push(a);
    } else if (b) {
      apRemoved.push(b);
    }
  }

  return {
    ssids: {
      added: ssidAdded,
      removed: ssidRemoved,
      changed: ssidChanged,
      unchanged: ssidUnchanged,
    },
    accessPoints: {
      added: apAdded,
      removed: apRemoved,
      changed: apChanged,
      unchanged: apUnchanged,
    },
  };
}
