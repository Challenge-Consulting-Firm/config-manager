/**
 * Firewall / ACL rule extraction.
 *
 * Vendor-specific syntaxes (Cisco IOS/IOS-XE/NX-OS ACLs, Cisco ASA access-lists,
 * Juniper Junos firewall filters, Fortinet FortiOS policies, YAMAHA ip filter)
 * are parsed into a common {@link FirewallRule} shape.
 *
 * Extraction is best-effort: complex constructs (object-groups, address books,
 * nested policies) are kept as-is (the group name appears literally in the
 * source/destination field) rather than expanded.
 */

import type { DeviceDetection } from "./detect.js";
import type { FirewallRule } from "./types.js";

// ----- cache (de)serialization -----

/** Wrapper shape persisted to Kintone. `bodyHash` lets readers verify the
 *  cache is still valid for the current config body. */
export interface FirewallCache {
  bodyHash: string;
  version: number; // schema version of this cache payload
  rules: FirewallRule[];
}

export const FIREWALL_CACHE_VERSION = 1;

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

function extractFortinet(lines: string[], vendor: string): FirewallRule[] {
  const rules: FirewallRule[] = [];
  let inPolicy = false;
  let inEdit = false;
  let current: Partial<FirewallRule> & { line: number; raw: string } | null = null;

  const flush = () => {
    if (!current) return;
    rules.push({
      vendor,
      name: String(current.name ?? "policy"),
      action: current.action ?? "permit",
      protocol: current.protocol ?? "any",
      source: current.source ?? "any",
      destination: current.destination ?? "any",
      port: current.port ?? "any",
      line: current.line,
      raw: current.raw,
    });
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    if (/^config\s+firewall\s+(policy|addrgrp|service)\b/i.test(raw)) {
      if (/policy/i.test(raw)) inPolicy = true;
      continue;
    }
    if (/^end\s*$/i.test(raw)) {
      if (inEdit) {
        flush();
        inEdit = false;
      }
      inPolicy = false;
      continue;
    }
    if (!inPolicy) continue;
    const editM = raw.match(/^edit\s+(\d+|"[^"]+")/i);
    if (editM) {
      if (inEdit) flush();
      inEdit = true;
      current = {
        name: editM[1].replace(/"/g, ""),
        action: "permit",
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
    const setM = raw.match(/^set\s+(\w+)\s+(.+)$/i);
    if (!setM) continue;
    const [, key, val] = setM;
    const v = val.replace(/"/g, "").trim();
    switch (key.toLowerCase()) {
      case "srcaddr":
      case "srcaddr6":
        current.source = v;
        break;
      case "dstaddr":
      case "dstaddr6":
        current.destination = v;
        break;
      case "service":
        current.port = v;
        current.protocol = "";
        break;
      case "action":
        current.action = /accept/i.test(v) ? "permit" : "deny";
        break;
      case "srcintf":
        current.source = current.source
          ? `${current.source} (${v})`
          : `(${v})`;
        break;
      case "dstintf":
        current.destination = current.destination
          ? `${current.destination} (${v})`
          : `(${v})`;
        break;
    }
  }
  flush();
  return rules;
}

// ----- YAMAHA ip filter -----

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
  return rules;
}

// ----- dispatcher -----

/** Quick structural sniff to pick a parser when the vendor is unknown
 *  (e.g. an old record uploaded before auto-detection existed). */
function guessVendorFromConfig(lines: string[]): string {
  const has = (re: RegExp) => lines.some((l) => re.test(l));
  if (has(/^set\s+security\s+policies\s+/i) || has(/^set\s+firewall\s+filter\s+/i)) {
    return "Juniper";
  }
  if (has(/^ip\s+filter\s+\S+\s+(pass|reject)\s+/i)) {
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
  for (const v of ["Cisco", "Juniper", "Fortinet", "YAMAHA"]) {
    const r = runForVendor(lines, v);
    if (r.length > best.length) best = r;
  }
  return best;
}

function runForVendor(lines: string[], vendor: string): FirewallRule[] {
  switch (vendor) {
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
