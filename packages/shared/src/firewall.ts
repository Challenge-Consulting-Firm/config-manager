/**
 * Firewall / ACL rule extraction.
 *
 * Vendor-specific syntaxes (Cisco IOS/IOS-XE/NX-OS ACLs, Cisco ASA access-lists,
 * Juniper Junos firewall filters, Fortinet FortiOS policies, YAMAHA ip filter /
 * SWX access-list) are parsed into a common {@link FirewallRule} shape.
 *
 * Extraction is best-effort: complex constructs (object-groups, address books,
 * nested policies) are kept as-is (the group name appears literally in the
 * source/destination field) rather than expanded.
 */

import type { DeviceDetection } from "./detect.js";
import type {
  ExpandedFirewallCombination,
  FirewallRule,
  FirewallRuleCategory,
  FirewallRuleChange,
  FirewallRuleDiff,
} from "./types.js";

// ----- cache (de)serialization -----

/** Wrapper shape persisted to Kintone. `bodyHash` lets readers verify the
 *  cache is still valid for the current config body. */
export interface FirewallCache {
  bodyHash: string;
  version: number; // schema version of this cache payload
  rules: FirewallRule[];
}

// v4: added Meraki (Dashboard JSON) firewall policy extraction. Bumping the
// version invalidates older caches (notably Meraki records that cached an empty
// ruleset before this parser existed) so they recompute on next read.
// v5: Yamaha SWX management-plane ACL extraction (`<svc>-server access`).
// v6: Yamaha SWX data-plane ACL extraction (`access-list` IPv4/IPv6/MAC +
//     access-group / vlan filter bindings).
export const FIREWALL_CACHE_VERSION = 6;

/** Serialize rules to a compact JSON string for storage. */
export function serializeFirewallRules(
  rules: FirewallRule[],
  bodyHash: string,
): string {
  const cache: FirewallCache = {
    bodyHash,
    version: FIREWALL_CACHE_VERSION,
    rules,
  };
  return JSON.stringify(cache);
}

/** Parse a cached JSON string back into rules. Returns null if the cache is
 *  missing, malformed, or belongs to a different body hash / schema version. */
export function parseFirewallCache(
  stored: string,
  expectedBodyHash: string,
): FirewallRule[] | null {
  if (!stored || !stored.trim()) return null;
  try {
    const cache = JSON.parse(stored) as FirewallCache;
    if (
      cache.version !== FIREWALL_CACHE_VERSION ||
      cache.bodyHash !== expectedBodyHash ||
      !Array.isArray(cache.rules)
    ) {
      return null;
    }
    return cache.rules;
  } catch {
    return null;
  }
}

// ----- helpers -----

/** Convert a Cisco wildcard mask (e.g. 0.0.0.255) to a CIDR-length string
 *  (e.g. "/24"). Returns empty string for non-contiguous wildcards. */
function wildcardToCidr(wildcard: string): string {
  const parts = wildcard.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return "";
  }
  // Wildcard bits are "don't care" bits. A valid contiguous wildcard has the
  // form 0...01...1, i.e. (bits+1) is a power of two (== (bits+1) & bits === 0).
  let bits = 0;
  for (const p of parts) bits = (bits << 8) | p;
  bits = bits >>> 0;
  if (bits === 0) return "/32"; // exact host
  if (((bits + 1) & bits) >>> 0 !== 0) return ""; // non-contiguous
  // Count set bits (= host portion length).
  let hostBits = 0;
  let v = bits;
  while (v !== 0) {
    hostBits++;
    v &= v - 1;
  }
  return `/${32 - hostBits}`;
}

interface AddressSpec {
  text: string; // "any" | "1.2.3.4/32" | "10.0.0.0/24" | "object-group X"
  consumed: number; // how many tokens were consumed
}

/** Parse an address spec starting at tokens[i]. Forms supported:
 *    any | host IP | IP WILDCARD | object-group NAME | IP */
function parseAddr(tokens: string[], i: number): AddressSpec {
  const t = tokens[i] ?? "";
  if (/^any$/i.test(t)) return { text: "any", consumed: 1 };
  if (/^host$/i.test(t)) {
    return { text: `${tokens[i + 1] ?? ""}/32`, consumed: 2 };
  }
  if (/^object-group$/i.test(t)) {
    return { text: `object-group:${tokens[i + 1] ?? ""}`, consumed: 2 };
  }
  if (/^object$/i.test(t)) {
    return { text: `object:${tokens[i + 1] ?? ""}`, consumed: 2 };
  }
  if (/^addrgroup$/i.test(t)) {
    return { text: `addrgroup:${tokens[i + 1] ?? ""}`, consumed: 2 };
  }
  // Maybe IP with wildcard on the next token.
  const next = tokens[i + 1] ?? "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t) && /^\d{1,3}(\.\d{1,3}){3}$/.test(next)) {
    const cidr = wildcardToCidr(next);
    if (cidr === "/32") return { text: `${t}/32`, consumed: 2 };
    return { text: cidr ? `${t}${cidr}` : `${t} ${next}`, consumed: 2 };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}\/\d+$/.test(t)) {
    return { text: t, consumed: 1 };
  }
  // Bare host name
  return { text: t, consumed: 1 };
}

/** Parse a port clause (eq/gt/lt/range/neq). Returns the port spec text and
 *  token consumption. */
function parsePort(tokens: string[], i: number): { port: string; consumed: number } {
  const op = (tokens[i] ?? "").toLowerCase();
  if (op === "eq") return { port: tokens[i + 1] ?? "", consumed: 2 };
  if (op === "gt") return { port: `>${tokens[i + 1] ?? ""}`, consumed: 2 };
  if (op === "lt") return { port: `<${tokens[i + 1] ?? ""}`, consumed: 2 };
  if (op === "neq") return { port: `!=${tokens[i + 1] ?? ""}`, consumed: 2 };
  if (op === "range") {
    return {
      port: `${tokens[i + 1] ?? ""}-${tokens[i + 3] ?? ""}`.replace(/-$/, ""),
      consumed: 4,
    };
  }
  return { port: "any", consumed: 0 };
}

// ----- Cisco IOS/IOS-XE/NX-OS ACL + Cisco ASA access-list -----

/** Parse a Cisco-style permit/deny line into a partial rule.
 *  Tokens after the action keyword, e.g.
 *    tcp any host 10.0.0.1 eq 80
 *    ip 10.0.0.0 0.0.0.255 any
 *    icmp any any echo
 *  Also handles ASA: action preceded by `extended` keyword and the leading
 *  `access-list NAME ...` form is handled by the caller. */
function parseCiscoRuleBody(
  tokens: string[],
): { protocol: string; source: string; destination: string; port: string } | null {
  if (tokens.length === 0) return null;
  const protocol = tokens[0];
  let idx = 1;
  const src = parseAddr(tokens, idx);
  idx += src.consumed;
  // optional source port (rare but valid for some ACLs)
  let sourcePort = "";
  if (idx < tokens.length && /^(eq|gt|lt|neq|range)$/i.test(tokens[idx])) {
    const sp = parsePort(tokens, idx);
    sourcePort = sp.port;
    idx += sp.consumed;
  }
  if (idx >= tokens.length) return null;
  const dst = parseAddr(tokens, idx);
  idx += dst.consumed;
  let port = "any";
  if (idx < tokens.length && /^(eq|gt|lt|neq|range)$/i.test(tokens[idx])) {
    const dp = parsePort(tokens, idx);
    port = dp.port;
  }
  // Combine source port with dest port for the display.
  if (sourcePort) port = `src ${sourcePort} / dst ${port}`;
  return { protocol, source: src.text, destination: dst.text, port };
}

/** Extract Cisco ACL rules (IOS, IOS-XE, NX-OS, ASA). */
function extractCisco(
  lines: string[],
  vendor: string,
): FirewallRule[] {
  const rules: FirewallRule[] = [];
  let currentAcl = ""; // within `ip access-list ...` block
  let inAclBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const lower = raw.toLowerCase();

    // `ip access-list [extended|standard] NAME` opens a block.
    const blockM = raw.match(/^ip\s+access-list\s+(?:extended|standard|role-based)\s+(\S+)/i);
    if (blockM) {
      inAclBlock = true;
      currentAcl = blockM[1];
      continue;
    }
    // A blank-ish `!` or new top-level directive ends the block.
    if (inAclBlock) {
      if (/^(interface|router|ip\s|vlan|no\s|policy-map|class-map|exit)/i.test(raw)) {
        inAclBlock = false;
        currentAcl = "";
      }
    }

    // Numbered/extended access-list (top-level, single line):
    //   access-list 101 permit tcp any any eq 22
    //   access-list OUT extended permit tcp any host X eq 80
    const numM = raw.match(/^access-list\s+(\S+)\s+(?:extended\s+|compiled\s+|standard\s+)?(permit|deny)\s+/i);
    if (numM) {
      const name = numM[1];
      const action = numM[2].toLowerCase() === "permit" ? "permit" : "deny";
      const after = raw.slice(raw.toLowerCase().indexOf(numM[2]) + numM[2].length).trim();
      const body = parseCiscoRuleBody(after.split(/\s+/));
      if (body) {
        rules.push({
          vendor,
          name,
          action,
          ...body,
          line: i + 1,
          raw,
        });
      }
      continue;
    }

    // Inside an `ip access-list` block: `permit ...` / `deny ...`
    if (inAclBlock) {
      const inlineM = raw.match(/^(permit|deny)\s+/i);
      if (inlineM) {
        const action = inlineM[1].toLowerCase() === "permit" ? "permit" : "deny";
        const after = raw.slice(inlineM[0].length).trim();
        const body = parseCiscoRuleBody(after.split(/\s+/));
        if (body) {
          rules.push({
            vendor,
            name: currentAcl,
            action,
            ...body,
            line: i + 1,
            raw,
          });
        }
        continue;
      }
    }
    void lower;
  }
  return rules;
}

// ----- Juniper SRX security policies (set security policies ...) -----

/** Parse Juniper SRX stateful security policies in `set` format:
 *    set security policies [from-zone F] [to-zone T] policy NAME match source-address A
 *    set security policies [from-zone F] [to-zone T] policy NAME match destination-address A
 *    set security policies [from-zone F] [to-zone T] policy NAME match application APP
 *    set security policies [from-zone F] [to-zone T] policy NAME then permit|deny|reject
 *  Also handles global policies (no from-zone/to-zone). Multiple source/destination
 *  addresses become comma-joined in the corresponding field. */
function extractJuniperSrx(
  lines: string[],
  vendor: string,
): FirewallRule[] {
  interface Pol {
    key: string;
    name: string;
    fromZone: string;
    toZone: string;
    srcs: string[];
    dsts: string[];
    apps: string[];
    action: "permit" | "deny";
    line: number;
    raw: string;
  }
  const policies = new Map<string, Pol>();
  const re =
    /^set\s+security\s+policies\s+(?:from-zone\s+(\S+)\s+to-zone\s+(\S+)\s+|global\s+)policy\s+(\S+)\s+(.+)$/i;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const m = raw.match(re);
    if (!m) continue;
    const [, fromZone = "global", toZone = "global", name, rest] = m;
    const key = `${fromZone}->${toZone}::${name}`;
    let p = policies.get(key);
    if (!p) {
      p = {
        key,
        name,
        fromZone,
        toZone,
        srcs: [],
        dsts: [],
        apps: [],
        action: "permit",
        line: i + 1,
        raw,
      };
      policies.set(key, p);
    }
    p.raw = raw;
    const r = rest.trim();
    const srcM = r.match(/^match\s+source-address\s+(.+)$/i);
    if (srcM) {
      const v = srcM[1].trim();
      if (!p.srcs.includes(v)) p.srcs.push(v);
      continue;
    }
    const dstM = r.match(/^match\s+destination-address\s+(.+)$/i);
    if (dstM) {
      const v = dstM[1].trim();
      if (!p.dsts.includes(v)) p.dsts.push(v);
      continue;
    }
    const appM = r.match(/^match\s+(?:application|application-set)\s+(.+)$/i);
    if (appM) {
      const v = appM[1].trim();
      if (!p.apps.includes(v)) p.apps.push(v);
      continue;
    }
    const thenM = r.match(/^then\s+(\S+)/i);
    if (thenM) {
      const a = thenM[1].toLowerCase();
      if (a === "permit") p.action = "permit";
      else if (a === "deny" || a === "reject") p.action = "deny";
      continue;
    }
  }

  const rules: FirewallRule[] = [];
  for (const p of policies.values()) {
    const zoneTag =
      p.fromZone === "global" && p.toZone === "global"
        ? "global"
        : `${p.fromZone}->${p.toZone}`;
    rules.push({
      vendor,
      name: `${p.name} [${zoneTag}]`,
      action: p.action,
      protocol: "any",
      source: p.srcs.length ? p.srcs.join(", ") : "any",
      destination: p.dsts.length ? p.dsts.join(", ") : "any",
      port: p.apps.length ? p.apps.join(", ") : "any",
      line: p.line,
      raw: p.raw,
    });
  }
  return rules;
}

// ----- Juniper Junos firewall filter (set format + bracket format) -----

function extractJuniper(lines: string[], vendor: string): FirewallRule[] {
  const rules: FirewallRule[] = [];
  // Aggregate terms by (filter, term) key.
  interface TermAgg {
    filter: string;
    term: string;
    from: { protocol?: string; src?: string; dst?: string; port?: string };
    action: "permit" | "deny";
    line: number;
    raw: string;
  }
  const terms = new Map<string, TermAgg>();
  let inFirewallBlock = false; // bracket-format tracking
  let currentFilter = "";
  let currentTerm = "";
  let inFrom = false;
  let inThen = false;

  const keyOf = (f: string, t: string) => `${f}::${t}`;
  const ensure = (f: string, t: string, line: number, raw: string): TermAgg => {
    const k = keyOf(f, t);
    let v = terms.get(k);
    if (!v) {
      v = { filter: f, term: t, from: {}, action: "permit", line, raw };
      terms.set(k, v);
    }
    return v;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // set-format
    const setM = trimmed.match(
      /^set\s+firewall\s+filter\s+(\S+)\s+term\s+(\S+)\s+(.*)$/i,
    );
    if (setM) {
      const [, filter, term, rest] = setM;
      const agg = ensure(filter, term, i + 1, trimmed);
      const r = rest.trim();
      const fromM = r.match(/^from\s+(.*)$/i);
      const thenM = r.match(/^then\s+(.*)$/i);
      if (fromM) {
        const f = fromM[1].trim();
        const pm = f.match(/^protocol\s+(\S+)/i);
        if (pm) agg.from.protocol = pm[1];
        const sm = f.match(/^source-address\s+(\S+)/i);
        if (sm) agg.from.src = sm[1];
        const dm = f.match(/^destination-address\s+(\S+)/i);
        if (dm) agg.from.dst = dm[1];
        const dpm = f.match(/^destination-port\s+(\S+)/i);
        if (dpm) agg.from.port = dpm[1].replace(/;$/, "");
        const spm = f.match(/^port\s+(\S+)/i);
        if (spm) agg.from.port = spm[1].replace(/;$/, "");
      } else if (thenM) {
        const a = thenM[1].trim().toLowerCase();
        if (a.startsWith("accept")) agg.action = "permit";
        else if (a.startsWith("discard") || a.startsWith("reject")) agg.action = "deny";
      }
      continue;
    }

    // bracket-format (very rough)
    if (/^firewall\s*\{/i.test(trimmed) || /^\s*filter\s+\S+\s*\{/i.test(raw)) {
      inFirewallBlock = true;
      const fm = trimmed.match(/filter\s+(\S+)/i);
      if (fm) currentFilter = fm[1].replace(/;$/, "");
      continue;
    }
    if (inFirewallBlock) {
      const termM = raw.match(/^\s*term\s+(\S+)\s*\{/i);
      if (termM) {
        currentTerm = termM[1];
        ensure(currentFilter, currentTerm, i + 1, trimmed);
        continue;
      }
      if (/^\s*\}\s*$/.test(raw)) {
        if (inFrom || inThen) {
          inFrom = false;
          inThen = false;
        } else if (currentTerm) {
          currentTerm = "";
        } else {
          inFirewallBlock = false;
          currentFilter = "";
        }
        continue;
      }
      if (/^\s*from\s*\{/i.test(raw)) {
        inFrom = true;
        inThen = false;
        continue;
      }
      if (/^\s*then\s*\{/i.test(raw)) {
        inThen = true;
        inFrom = false;
        continue;
      }
      const agg = terms.get(keyOf(currentFilter, currentTerm));
      if (agg) {
        const pm = raw.match(/^\s*protocol\s+(\S+)\s*;?/i);
        if (pm) agg.from.protocol = pm[1].replace(/;$/, "");
        const sm = raw.match(/^\s*source-address\s+(\S+)\s*;?/i);
        if (sm && inFrom) agg.from.src = sm[1].replace(/;$/, "");
        const dm = raw.match(/^\s*destination-address\s+(\S+)\s*;?/i);
        if (dm && inFrom) agg.from.dst = dm[1].replace(/;$/, "");
        const dpm = raw.match(/^\s*destination-port\s+(\S+)\s*;?/i);
        if (dpm && inFrom) agg.from.port = dpm[1].replace(/;$/, "");
        const am = raw.match(/^\s*(accept|discard|reject)\s*;?/i);
        if (am && inThen) {
          agg.action = am[1].toLowerCase() === "accept" ? "permit" : "deny";
        }
      }
    }
  }

  for (const t of terms.values()) {
    rules.push({
      vendor,
      name: t.filter,
      action: t.action,
      protocol: t.from.protocol ?? "any",
      source: t.from.src ?? "any",
      destination: t.from.dst ?? "any",
      port: t.from.port ?? "any",
      line: t.line,
      raw: t.raw,
    });
  }
  // Also pick up SRX-style `set security policies ...` (stateful zone-based).
  rules.push(...extractJuniperSrx(lines, vendor));
  return rules;
}

// ----- Fortinet FortiOS firewall policy -----

interface FortinetCurrent extends Partial<FirewallRule> {
  line: number;
  raw: string;
}

function cleanFortinetValue(value: string): string {
  return value.replace(/"/g, "").trim();
}

/** Split a FortiGate multi-value (e.g. `set srcaddr "LAN Users" "DMZ"`) into
 *  individual object names, respecting double-quoted tokens that may contain
 *  spaces. Unquoted whitespace-separated tokens are kept as-is. */
function parseFortinetTokens(rawValue: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawValue)) !== null) {
    const token = (m[1] ?? m[2]).trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

/** Merge additional item tokens into an existing list, de-duplicating. */
function mergeItems(existing: string[] | undefined, add: string[]): string[] {
  return existing ? [...new Set([...existing, ...add])] : add;
}

function appendInterface(value: string | undefined, intf: string): string {
  return value ? `${value} (${intf})` : `(${intf})`;
}

function setAddressKeepingInterface(existing: string | undefined, address: string): string {
  if (existing?.startsWith("(")) return `${address} ${existing}`;
  return address;
}

function extractFortinet(lines: string[], vendor: string): FirewallRule[] {
  return [
    ...extractFortinetPolicies(lines, vendor),
    ...extractFortinetDosPolicies(lines, vendor),
  ];
}

function extractFortinetPolicies(lines: string[], vendor: string): FirewallRule[] {
  const rules: FirewallRule[] = [];
  let inPolicy = false;
  let depth = 0;
  let inEdit = false;
  let current: FortinetCurrent | null = null;

  const flush = () => {
    if (!current) return;
    const natEnabled = current.nat?.enabled === true;
    rules.push({
      vendor,
      name: String(current.name ?? "policy"),
      displayName: current.displayName,
      category: natEnabled ? "nat" : "policy",
      action: current.action ?? "permit",
      enabled: current.enabled ?? true,
      protocol: current.protocol ?? "any",
      source: current.source ?? "any",
      destination: current.destination ?? "any",
      port: current.port ?? "any",
      sourceItems: current.sourceItems,
      destinationItems: current.destinationItems,
      serviceItems: current.serviceItems,
      nat: current.nat,
      comments: current.comments,
      attributes: current.attributes,
      line: current.line,
      raw: current.raw,
    });
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;

    if (!inPolicy) {
      if (/^config\s+firewall\s+policy\s*$/i.test(raw)) {
        inPolicy = true;
        depth = 1;
      }
      continue;
    }

    if (/^config\s+/i.test(raw)) {
      depth++;
      continue;
    }

    if (/^end\s*$/i.test(raw)) {
      depth--;
      if (depth === 0) {
        if (inEdit) flush();
        inEdit = false;
        inPolicy = false;
      }
      continue;
    }

    if (depth !== 1) continue;

    const editM = raw.match(/^edit\s+(\d+|"[^"]+")/i);
    if (editM) {
      if (inEdit) flush();
      inEdit = true;
      current = {
        name: cleanFortinetValue(editM[1]),
        action: "permit",
        enabled: true,
        category: "policy",
        line: i + 1,
        raw,
      };
      continue;
    }

    if (/^next\s*$/i.test(raw)) {
      if (inEdit) flush();
      inEdit = false;
      continue;
    }

    if (!current) continue;
    const setM = raw.match(/^set\s+([\w-]+)\s+(.+)$/i);
    if (!setM) continue;
    const [, key, val] = setM;
    const v = cleanFortinetValue(val);
    switch (key.toLowerCase()) {
      case "name":
        current.displayName = v;
        break;
      case "comments":
        current.comments = v;
        break;
      case "srcaddr":
      case "srcaddr6":
        current.sourceItems = mergeItems(current.sourceItems, parseFortinetTokens(val));
        current.source = setAddressKeepingInterface(current.source, v);
        break;
      case "dstaddr":
      case "dstaddr6":
        current.destinationItems = mergeItems(
          current.destinationItems,
          parseFortinetTokens(val),
        );
        current.destination = setAddressKeepingInterface(current.destination, v);
        break;
      case "service":
        current.serviceItems = mergeItems(current.serviceItems, parseFortinetTokens(val));
        current.port = v;
        current.protocol = "service";
        break;
      case "internet-service":
        if (/enable/i.test(v)) {
          current.protocol = "internet-service";
          current.port = current.port ?? "internet-service";
        }
        break;
      case "internet-service-name":
      case "internet-service-id":
      case "internet-service-group":
        current.protocol = "internet-service";
        current.destination = `Internet Service: ${v}`;
        current.destinationItems = mergeItems(
          current.destinationItems,
          parseFortinetTokens(val).map((t) => `Internet Service: ${t}`),
        );
        current.port = v;
        break;
      case "action":
        current.action = /accept|ipsec/i.test(v) ? "permit" : "deny";
        break;
      case "status":
        current.enabled = !/disable/i.test(v);
        break;
      case "nat":
        current.nat = {
          enabled: /enable/i.test(v),
          ippool: current.nat?.ippool,
          poolName: current.nat?.poolName,
        };
        break;
      case "ippool":
        current.nat = {
          enabled: current.nat?.enabled ?? false,
          ippool: /enable/i.test(v),
          poolName: current.nat?.poolName,
        };
        break;
      case "poolname":
        current.nat = {
          enabled: current.nat?.enabled ?? false,
          ippool: current.nat?.ippool,
          poolName: v,
        };
        break;
      case "srcintf":
        current.source = appendInterface(current.source, v);
        break;
      case "dstintf":
        current.destination = appendInterface(current.destination, v);
        break;
    }
  }
  if (inEdit) flush();
  return rules;
}

function extractFortinetDosPolicies(lines: string[], vendor: string): FirewallRule[] {
  const rules: FirewallRule[] = [];
  let inDosPolicy = false;
  let depth = 0;
  let inEdit = false;
  let current: FortinetCurrent | null = null;
  let currentAnomaly = "";
  const anomalies: string[] = [];

  const flush = () => {
    if (!current) return;
    rules.push({
      vendor,
      name: String(current.name ?? "DoS-policy"),
      displayName: current.displayName,
      category: "dos",
      action: current.action ?? "deny",
      enabled: current.enabled ?? true,
      protocol: "dos",
      source: current.source ?? "any",
      destination: current.destination ?? "any",
      port: current.port ?? "any",
      sourceItems: current.sourceItems,
      destinationItems: current.destinationItems,
      serviceItems: current.serviceItems,
      comments: current.comments,
      attributes: anomalies.join("; "),
      line: current.line,
      raw: current.raw,
    });
    current = null;
    anomalies.length = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;

    if (!inDosPolicy) {
      if (/^config\s+firewall\s+DoS-policy\s*$/i.test(raw)) {
        inDosPolicy = true;
        depth = 1;
      }
      continue;
    }

    if (/^config\s+/i.test(raw)) {
      depth++;
      continue;
    }

    if (/^end\s*$/i.test(raw)) {
      depth--;
      if (depth === 1) currentAnomaly = "";
      if (depth === 0) {
        if (inEdit) flush();
        inEdit = false;
        inDosPolicy = false;
      }
      continue;
    }

    if (depth === 1) {
      const editM = raw.match(/^edit\s+(\d+|"[^"]+")/i);
      if (editM) {
        if (inEdit) flush();
        inEdit = true;
        current = {
          name: cleanFortinetValue(editM[1]),
          action: "deny",
          enabled: true,
          category: "dos",
          line: i + 1,
          raw,
        };
        continue;
      }
      if (/^next\s*$/i.test(raw)) {
        if (inEdit) flush();
        inEdit = false;
        continue;
      }
      if (!current) continue;
      const setM = raw.match(/^set\s+([\w-]+)\s+(.+)$/i);
      if (!setM) continue;
      const [, key, val] = setM;
      const v = cleanFortinetValue(val);
      switch (key.toLowerCase()) {
        case "name":
          current.displayName = v;
          break;
        case "comments":
          current.comments = v;
          break;
        case "interface":
          current.source = appendInterface(current.source, v);
          break;
        case "srcaddr":
          current.sourceItems = mergeItems(current.sourceItems, parseFortinetTokens(val));
          current.source = setAddressKeepingInterface(current.source, v);
          break;
        case "dstaddr":
          current.destinationItems = mergeItems(
            current.destinationItems,
            parseFortinetTokens(val),
          );
          current.destination = setAddressKeepingInterface(current.destination, v);
          break;
        case "service":
          current.serviceItems = mergeItems(current.serviceItems, parseFortinetTokens(val));
          current.port = v;
          break;
        case "status":
          current.enabled = !/disable/i.test(v);
          break;
      }
      continue;
    }

    if (depth === 2 && current) {
      const editM = raw.match(/^edit\s+"?([^"]+)"?/i);
      if (editM) {
        currentAnomaly = editM[1];
        continue;
      }
      if (/^next\s*$/i.test(raw)) {
        currentAnomaly = "";
        continue;
      }
      const setM = raw.match(/^set\s+([\w-]+)\s+(.+)$/i);
      if (setM && currentAnomaly) {
        const key = setM[1].toLowerCase();
        const v = cleanFortinetValue(setM[2]);
        if (key === "threshold") {
          anomalies.push(`${currentAnomaly}: threshold ${v}`);
        }
      }
    }
  }
  if (inEdit) flush();
  return rules;
}

// ----- YAMAHA ip filter / SWX access-list -----

/** Classify a Yamaha SWX numeric ACL id by the reserved ranges:
 *    1-2000    IPv4
 *    2001-3000 MAC
 *    3001-4000 IPv6
 *  Returns empty for anything outside those ranges. */
function yamahaSwxAclKind(id: number): "ipv4" | "ipv6" | "mac" | "" {
  if (id >= 1 && id <= 2000) return "ipv4";
  if (id >= 2001 && id <= 3000) return "mac";
  if (id >= 3001 && id <= 4000) return "ipv6";
  return "";
}

/** Parse a Yamaha SWX MAC address token set starting at tokens[i]. Forms:
 *    any | host HHHH.HHHH.HHHH | HHHH.HHHH.HHHH WWWW.WWWW.WWWW */
function parseYamahaMacAddr(
  tokens: string[],
  i: number,
): AddressSpec {
  const t = tokens[i] ?? "";
  if (/^any$/i.test(t)) return { text: "any", consumed: 1 };
  if (/^host$/i.test(t)) {
    return { text: tokens[i + 1] ?? "", consumed: 2 };
  }
  // MAC + wildcard (e.g. 00A0.DE12.3456 0000.0000.0000).
  const next = tokens[i + 1] ?? "";
  if (
    /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i.test(t) &&
    /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i.test(next)
  ) {
    // Exact host (all-zero wildcard) collapses to bare MAC.
    if (/^0000\.0000\.0000$/i.test(next)) return { text: t, consumed: 2 };
    return { text: `${t} ${next}`, consumed: 2 };
  }
  if (/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i.test(t)) {
    return { text: t, consumed: 1 };
  }
  return { text: t, consumed: 1 };
}

/** Collect interface / VLAN bindings for SWX ACLs so the matrix can show
 *  where each list is applied.
 *
 *  Interface form (inside `interface X` blocks):
 *    access-group <acl-id> in|out
 *  VLAN form (global):
 *    vlan access-map NAME
 *      match access-list <acl-id>
 *    vlan filter NAME <vlan-id> [in|out]
 */
function collectYamahaSwxAclBindings(
  lines: string[],
): Map<string, string[]> {
  const bindings = new Map<string, string[]>();
  const push = (aclId: string, label: string) => {
    const list = bindings.get(aclId) ?? [];
    if (!list.includes(label)) list.push(label);
    bindings.set(aclId, list);
  };

  // access-group inside interface blocks. A new top-level directive (or exit)
  // leaves the interface context; blank / `!` lines keep it so indented
  // access-group still binds to the last interface.
  let currentIf = "";
  for (const raw of lines) {
    const l = raw.trim();
    if (!l || l === "!") continue;
    const ifM = l.match(/^interface\s+(\S+)/i);
    if (ifM) {
      currentIf = ifM[1];
      continue;
    }
    if (/^exit\b/i.test(l)) {
      currentIf = "";
      continue;
    }
    const agM = l.match(/^access-group\s+(\d+)\s+(in|out)\b/i);
    if (agM && currentIf) {
      push(agM[1], `${currentIf} ${agM[2].toLowerCase()}`);
      continue;
    }
    // Any other non-indented top-level command ends the interface block.
    if (currentIf && !/^\s/.test(raw) && !/^access-group\b/i.test(l)) {
      currentIf = "";
    }
  }

  // vlan access-map NAME { match access-list ID } + vlan filter NAME VID [dir]
  const mapToAcl = new Map<string, string>();
  let currentMap = "";
  for (const raw of lines) {
    const l = raw.trim();
    const mapM = l.match(/^vlan\s+access-map\s+(\S+)/i);
    if (mapM) {
      currentMap = mapM[1];
      continue;
    }
    if (currentMap) {
      const matchM = l.match(/^match\s+access-list\s+(\d+)\b/i);
      if (matchM) {
        mapToAcl.set(currentMap, matchM[1]);
        continue;
      }
      if (/^(exit|end|vlan\s|access-list|interface|hostname)/i.test(l)) {
        currentMap = "";
      }
    }
  }
  for (const raw of lines) {
    const l = raw.trim();
    const filtM = l.match(
      /^vlan\s+filter\s+(\S+)\s+(\d+)(?:\s+(in|out))?\b/i,
    );
    if (!filtM) continue;
    const [, mapName, vlanId, dir = "in"] = filtM;
    const aclId = mapToAcl.get(mapName);
    if (!aclId) continue;
    push(aclId, `vlan${vlanId}/${mapName} ${dir.toLowerCase()}`);
  }

  return bindings;
}

/** Extract Yamaha SWX data-plane ACLs.
 *
 *  Syntax (command reference for SWX3100 / SWX3200 / SWX23xx):
 *    access-list <1-2000>    [seq] permit|deny PROTO SRC [SPORT] DST [DPORT] [flags]
 *    access-list <2001-3000> [seq] permit|deny SRC-MAC DST-MAC
 *    access-list <3001-4000> [seq] permit|deny SRC-IPv6
 *    access-list <id> description <text>
 *
 *  The optional sequence number is the key difference from Cisco numbered
 *  ACLs; without it, a Cisco-style line body can be reused via
 *  {@link parseCiscoRuleBody}. */
function extractYamahaSwxAccessLists(
  lines: string[],
  vendor: string,
): FirewallRule[] {
  const descriptions = new Map<string, string>();
  const pending: {
    name: string;
    kind: "ipv4" | "ipv6" | "mac";
    action: "permit" | "deny";
    protocol: string;
    source: string;
    destination: string;
    port: string;
    line: number;
    raw: string;
  }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || /^no\s+/i.test(raw)) continue;

    const descM = raw.match(/^access-list\s+(\d+)\s+description\s+(.+)$/i);
    if (descM) {
      descriptions.set(descM[1], descM[2].trim());
      continue;
    }

    // Optional seq number between id and action. Reject non-numeric ids so we
    // never steal Cisco named ACLs if this parser is ever invoked on them.
    const m = raw.match(
      /^access-list\s+(\d+)\s+(?:(\d+)\s+)?(permit|deny)\s+(.+)$/i,
    );
    if (!m) continue;
    const [, idStr, _seq, actKw, rest] = m;
    const id = Number.parseInt(idStr, 10);
    const kind = yamahaSwxAclKind(id);
    if (!kind) continue;
    const action: "permit" | "deny" =
      actKw.toLowerCase() === "permit" ? "permit" : "deny";
    const tokens = rest.trim().split(/\s+/).filter(Boolean);

    if (kind === "ipv4") {
      const body = parseCiscoRuleBody(tokens);
      if (!body) continue;
      pending.push({
        name: idStr,
        kind,
        action,
        ...body,
        line: i + 1,
        raw,
      });
      continue;
    }

    if (kind === "ipv6") {
      // IPv6 ACLs match source only: `deny 3ffe:506::/32` / `permit any`.
      const src = tokens[0] ?? "any";
      pending.push({
        name: idStr,
        kind,
        action,
        protocol: "ipv6",
        source: src,
        destination: "any",
        port: "any",
        line: i + 1,
        raw,
      });
      continue;
    }

    // MAC ACL: src-mac dst-mac.
    const srcMac = parseYamahaMacAddr(tokens, 0);
    const dstMac = parseYamahaMacAddr(tokens, srcMac.consumed);
    pending.push({
      name: idStr,
      kind,
      action,
      protocol: "mac",
      source: srcMac.text || "any",
      destination: dstMac.text || "any",
      port: "any",
      line: i + 1,
      raw,
    });
  }

  if (pending.length === 0) return [];

  const bindings = collectYamahaSwxAclBindings(lines);
  return pending.map((p) => {
    const desc = descriptions.get(p.name);
    const applied = bindings.get(p.name);
    const attrParts: string[] = [p.kind];
    if (applied && applied.length > 0) {
      attrParts.push(`applied: ${applied.join(", ")}`);
    }
    return {
      vendor,
      name: p.name,
      displayName: desc,
      action: p.action,
      protocol: p.protocol,
      source: p.source,
      destination: p.destination,
      port: p.port,
      comments: desc,
      attributes: attrParts.join("; "),
      line: p.line,
      raw: p.raw,
    };
  });
}

function extractYamaha(lines: string[], vendor: string): FirewallRule[] {
  const rules: FirewallRule[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    // `ip filter NAME pass|reject PROTO SRC [DST] [flags]`
    // or  `ip filter NAME pass|reject *`  (any any)
    const m = raw.match(
      /^ip\s+filter\s+(\S+)\s+(pass|reject)\s+(.+)$/i,
    );
    if (!m) continue;
    const [, name, actKw, rest] = m;
    const action: "permit" | "deny" = /pass/i.test(actKw) ? "permit" : "deny";
    const tokens = rest.trim().split(/\s+/);
    let protocol = "any";
    let source = "any";
    let destination = "any";
    let port = "any";
    if (tokens[0] === "*") {
      // `*` alone means any/any/any
    } else {
      protocol = tokens[0];
      if (tokens.length === 1) {
        // e.g. `ip filter N reject tcp` — only protocol
      } else if (tokens[1] === "*") {
        source = "any";
      } else {
        source = tokens[1];
      }
      if (tokens[2]) {
        if (tokens[2] === "*") destination = "any";
        else destination = tokens[2];
      }
      // YAMAHA format `host *port` for src/dst port, e.g. `*80`
      const srcPort = tokens[1]?.match(/^\*(.+)$/);
      const dstPort = tokens[2]?.match(/^\*(.+)$/);
      if (srcPort || dstPort) {
        port = `${srcPort ? srcPort[1] : "?"}/${dstPort ? dstPort[1] : "?"}`;
      }
    }
    rules.push({
      vendor,
      name,
      action,
      protocol,
      source,
      destination,
      port,
      line: i + 1,
      raw,
    });
  }

  // Management-plane access controls. SWX switches restrict management
  // services with `<svc>-server access permit|deny <network>`, and the
  // service itself is bound to SVIs with `<svc>-server interface vlanN`.
  // Surface each permit/deny so the FW view shows who may reach the
  // management plane. protocol carries the service name (http/telnet/ssh),
  // destination is the switch itself.
  const MGMT_SVC_RE =
    /^(http|https|telnet|ssh|snmp)(?:-server|-proxy)?\s+access\s+(permit|deny)\s+(\S+)/i;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    const m = raw.match(MGMT_SVC_RE);
    if (!m) continue;
    const [, svc, actKw, network] = m;
    rules.push({
      vendor,
      name: `${svc.toLowerCase()}-server`,
      action: /permit/i.test(actKw) ? "permit" : "deny",
      protocol: svc.toLowerCase(),
      source: network,
      destination: "self",
      port: svc.toLowerCase(),
      attributes: "management-access",
      line: i + 1,
      raw,
    });
  }

  // Data-plane ACLs used by SWX series switches (SWX3100 / SWX3200 / SWX23xx).
  // Distinct from RT-series `ip filter` and from management-plane access.
  rules.push(...extractYamahaSwxAccessLists(lines, vendor));

  return rules;
}

// ----- Cisco Meraki (Dashboard API JSON dump) -----

/** Scan forward from a `{` or `[` and return the index just past the matching
 *  close bracket, respecting JSON string literals and escapes. Returns -1 if
 *  the value is unbalanced (truncated). */
function scanBalancedJson(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Split a Meraki dump into its embedded JSON blocks. Works on the raw dump
 *  (which carries `! ===== <label> =====` section headers) and on the
 *  normalized body (where all `!` comment lines are stripped and only the JSON
 *  values remain, concatenated). Non-JSON text between blocks is skipped.
 *  Exported so the routing extractor can reuse the same block scanner. */
export function collectMerakiJsonBlocks(
  text: string,
): { label: string; value: unknown }[] {
  const blocks: { label: string; value: unknown }[] = [];
  let currentLabel = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "!") {
      // Comment / section-header line: capture the label if present, skip line.
      let j = text.indexOf("\n", i);
      if (j === -1) j = n;
      const m = text.slice(i, j).match(/^!\s*=+\s*(.+?)\s*=+\s*$/);
      if (m) currentLabel = m[1];
      i = j + 1;
      continue;
    }
    if (ch === "{" || ch === "[") {
      const end = scanBalancedJson(text, i);
      if (end > i) {
        try {
          blocks.push({ label: currentLabel, value: JSON.parse(text.slice(i, end)) });
        } catch {
          // Not valid JSON (should not happen for our dumps); skip.
        }
        i = end;
        continue;
      }
    }
    i++;
  }
  return blocks;
}

/** Meraki CIDR fields use the literal "Any"; normalize to lowercase "any". */
function merakiCidr(v: unknown): string {
  if (typeof v !== "string" || !v) return "any";
  return v.toLowerCase() === "any" ? "any" : v;
}

/** Meraki port fields may be a string ("Any", "443", "1-1024") or number. */
function merakiPort(v: unknown): string {
  if (v === undefined || v === null || v === "") return "any";
  const s = String(v);
  return s.toLowerCase() === "any" ? "any" : s;
}

/** Extract Meraki MX firewall policy (L3 / cellular firewall rules) from a
 *  serialized Dashboard dump. These sections are JSON of the form
 *  `{ "rules": [ { policy, protocol, srcCidr, srcPort, destCidr, destPort,
 *  comment } ] }`. We identify firewall blocks structurally by the presence of
 *  `srcCidr` / `destCidr` on the rule objects, so the same code path works
 *  whether or not the `! ===== ... =====` headers survived normalization. */
function extractMeraki(lines: string[], vendor: string): FirewallRule[] {
  const rules: FirewallRule[] = [];
  const text = lines.join("\n");
  let seq = 0;
  for (const { label, value } of collectMerakiJsonBlocks(text)) {
    const ruleArr: unknown[] | null = Array.isArray(value)
      ? value
      : value &&
          typeof value === "object" &&
          Array.isArray((value as { rules?: unknown }).rules)
        ? ((value as { rules: unknown[] }).rules)
        : null;
    if (!ruleArr) continue;
    // Only L3 / cellular firewall rules carry srcCidr / destCidr. This skips
    // VLANs, static routes, port-forwarding, and other JSON sections.
    const isFirewall = ruleArr.some(
      (r) =>
        r !== null &&
        typeof r === "object" &&
        ("srcCidr" in r || "destCidr" in r),
    );
    if (!isFirewall) continue;
    const name = label || "Meraki L3 Firewall";
    for (const r of ruleArr) {
      if (r === null || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      const policy = String(o.policy ?? "").toLowerCase();
      const action: "permit" | "deny" = policy === "deny" ? "deny" : "permit";
      const srcPort = merakiPort(o.srcPort);
      const destPort = merakiPort(o.destPort);
      const port =
        srcPort !== "any" ? `src ${srcPort} / dst ${destPort}` : destPort;
      const comment = typeof o.comment === "string" ? o.comment : "";
      seq++;
      rules.push({
        vendor,
        name,
        category: "policy",
        action,
        protocol: String(o.protocol ?? "any").toLowerCase() || "any",
        source: merakiCidr(o.srcCidr),
        destination: merakiCidr(o.destCidr),
        port,
        comments: comment || undefined,
        line: seq,
        raw: JSON.stringify(r),
      });
    }
  }
  return rules;
}

// ----- dispatcher -----

/** Quick structural sniff to pick a parser when the vendor is unknown
 *  (e.g. an old record uploaded before auto-detection existed). */
function guessVendorFromConfig(lines: string[]): string {
  const has = (re: RegExp) => lines.some((l) => re.test(l));
  // Meraki dumps carry a fixed header and/or JSON firewall rule objects with
  // srcCidr / destCidr. Detect either so old records (uploaded before vendor
  // detection recognized Meraki) still resolve to the Meraki parser.
  if (
    has(/Meraki Network Configuration Dump/) ||
    has(/"srcCidr"|"destCidr"/)
  ) {
    return "Cisco Meraki";
  }
  if (has(/^set\s+security\s+policies\s+/i) || has(/^set\s+firewall\s+filter\s+/i)) {
    return "Juniper";
  }
  if (has(/^ip\s+filter\s+\S+\s+(pass|reject)\s+/i)) {
    return "YAMAHA";
  }
  // SWX switches: `interface port1.N` + (l2ms | vlan database). Data-plane
  // ACLs are numeric `access-list` entries (optionally with a sequence
  // number) and management services use `<svc>-server access`.
  if (
    has(/^\s*interface\s+port\d+\.\d+/i) &&
    (has(/^\s*l2ms\b/i) || has(/^\s*vlan\s+database\s*$/i))
  ) {
    return "YAMAHA";
  }
  // Bare SWX ACL fragment (change-only uploads without interface/l2ms context).
  // Require the optional sequence number so we don't steal Cisco numbered
  // ACLs (`access-list 101 permit ...`) which lack a seq between id and action.
  if (has(/^access-list\s+\d+\s+\d+\s+(permit|deny)\s+/i)) {
    return "YAMAHA";
  }
  if (has(/^config\s+firewall\s+policy\s*$/i) || has(/^#config-version=/i)) {
    return "Fortinet";
  }
  if (
    has(/^ip\s+access-list\s+(extended|standard)\s+/i) ||
    has(/^access-list\s+\S+\s+(permit|deny)\s+/i) ||
    has(/^access-list\s+\S+\s+extended\s+(permit|deny)\s+/i)
  ) {
    return "Cisco";
  }
  return "";
}

/** Extract firewall/ACL rules from a config body, using the detected
 *  vendor/OS to pick the right parser. If detection is missing or the vendor
 *  is unknown, falls back to a structural guess; if that also fails, tries
 *  every parser and returns whichever yields rules. */
export function extractFirewallRules(
  body: string,
  detection: DeviceDetection | undefined,
): FirewallRule[] {
  if (!body) return [];
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const vendor = detection?.vendor ?? "";

  // First try the detected vendor.
  if (vendor) {
    const r = runForVendor(lines, vendor);
    if (r.length > 0) return r;
  }

  // Fall back to a structural guess based on config keywords.
  const guessed = guessVendorFromConfig(lines);
  if (guessed && guessed !== vendor) {
    const r = runForVendor(lines, guessed);
    if (r.length > 0) return r;
  }

  // Last resort: try every parser, return the one with the most hits.
  let best: FirewallRule[] = [];
  for (const v of ["Cisco Meraki", "Cisco", "Juniper", "Fortinet", "YAMAHA"]) {
    const r = runForVendor(lines, v);
    if (r.length > best.length) best = r;
  }
  return best;
}

function runForVendor(lines: string[], vendor: string): FirewallRule[] {
  switch (vendor) {
    case "Cisco Meraki":
      return extractMeraki(lines, vendor);
    case "Cisco":
      return extractCisco(lines, vendor);
    case "Juniper":
      return extractJuniper(lines, vendor);
    case "Fortinet":
      return extractFortinet(lines, vendor);
    case "YAMAHA":
      return extractYamaha(lines, vendor);
    default:
      return [];
  }
}

// ----- presentation helpers (pure, shared by Web UI and exporters) -----

/** Japanese display label for a rule category. */
export function firewallCategoryLabel(category: FirewallRuleCategory): string {
  switch (category) {
    case "nat":
      return "NATポリシー";
    case "dos":
      return "DoS-policy";
    case "policy":
      return "FWポリシー";
  }
}

/** Expand a rule into the cartesian product of its individual source,
 *  destination and service objects. Rules without per-item lists
 *  (non-Fortinet vendors, or single-value lines) degrade to a single row
 *  using the combined display fields. */
export function expandFirewallRule(
  rule: FirewallRule,
): ExpandedFirewallCombination[] {
  const sources = rule.sourceItems?.length ? rule.sourceItems : [rule.source];
  const destinations = rule.destinationItems?.length
    ? rule.destinationItems
    : [rule.destination];
  const services = rule.serviceItems?.length ? rule.serviceItems : [rule.port];
  const out: ExpandedFirewallCombination[] = [];
  for (const source of sources) {
    for (const destination of destinations) {
      for (const service of services) {
        out.push({ rule, source, destination, service });
      }
    }
  }
  return out;
}

// ----- structural diff -----

/** Build a stable signature for a rule, ignoring position-dependent fields
 *  (line number, raw text) so that re-ordered or reformatted rules compare
 *  as equal. Two rules with the same signature are "the same rule"; their
 *  metadata may still differ and is compared by {@link firewallRulesEqual}. */
function firewallRuleSignature(r: FirewallRule): string {
  return [
    r.vendor,
    r.name,
    r.category ?? "policy",
    r.action,
    r.protocol,
    r.source,
    r.destination,
    r.port,
  ]
    .map((s) => (s ?? "").replace(/\|/g, "||"))
    .join("|");
}

/** Compare two rules for full equality, ignoring only the source line number
 *  and raw text (which are position-dependent, not semantic). */
function firewallRulesEqual(a: FirewallRule, b: FirewallRule): boolean {
  return (
    firewallRuleSignature(a) === firewallRuleSignature(b) &&
    (a.displayName ?? "") === (b.displayName ?? "") &&
    (a.enabled ?? true) === (b.enabled ?? true) &&
    (a.sourceItems?.join(",") ?? "") === (b.sourceItems?.join(",") ?? "") &&
    (a.destinationItems?.join(",") ?? "") ===
      (b.destinationItems?.join(",") ?? "") &&
    (a.serviceItems?.join(",") ?? "") === (b.serviceItems?.join(",") ?? "") &&
    JSON.stringify(a.nat ?? null) === JSON.stringify(b.nat ?? null) &&
    (a.comments ?? "") === (b.comments ?? "") &&
    (a.attributes ?? "") === (b.attributes ?? "")
  );
}

/** Compute a structural diff between two firewall rule sets.
 *  Rules are paired by signature; pairs with metadata differences become
 *  `changed`, rules present only on one side become `added` / `removed`. */
export function diffFirewallRules(
  before: FirewallRule[],
  after: FirewallRule[],
): FirewallRuleDiff {
  const beforeBySig = new Map<string, FirewallRule[]>();
  for (const r of before) {
    const sig = firewallRuleSignature(r);
    const arr = beforeBySig.get(sig);
    if (arr) arr.push(r);
    else beforeBySig.set(sig, [r]);
  }
  const afterBySig = new Map<string, FirewallRule[]>();
  for (const r of after) {
    const sig = firewallRuleSignature(r);
    const arr = afterBySig.get(sig);
    if (arr) arr.push(r);
    else afterBySig.set(sig, [r]);
  }

  const added: FirewallRule[] = [];
  const removed: FirewallRule[] = [];
  const changed: FirewallRuleChange[] = [];
  let unchanged = 0;

  const allSigs = new Set<string>([...beforeBySig.keys(), ...afterBySig.keys()]);
  for (const sig of allSigs) {
    const bs = beforeBySig.get(sig) ?? [];
    const asAfter = afterBySig.get(sig) ?? [];
    const pairCount = Math.min(bs.length, asAfter.length);
    for (let i = 0; i < pairCount; i++) {
      if (firewallRulesEqual(bs[i], asAfter[i])) unchanged++;
      else changed.push({ before: bs[i], after: asAfter[i] });
    }
    for (let i = pairCount; i < asAfter.length; i++) added.push(asAfter[i]);
    for (let i = pairCount; i < bs.length; i++) removed.push(bs[i]);
  }

  return { added, removed, changed, unchanged };
}
