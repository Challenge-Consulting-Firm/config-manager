/**
 * Routing information extraction.
 *
 * Vendor-specific routing syntaxes are parsed into a common
 * {@link RoutingRoute} shape. The extractor focuses on:
 *   - Static routes            (most useful, well-defined syntax)
 *   - Connected interfaces     (interfaces with an IP address)
 *   - OSPF / BGP summary info  (areas, AS, neighbors, networks)
 *
 * Like the firewall extractor, this is best-effort: exotic constructs
 * (route-maps, complex redistribution, BGP VPNv4) are recorded as raw
 * metadata rather than expanded.
 */

import type { DeviceDetection } from "./detect.js";
import { collectMerakiJsonBlocks } from "./firewall.js";
import type {
  RoutingRoute,
  RoutingRouteChange,
  RoutingRouteDiff,
} from "./types.js";

// ----- cache (de)serialization -----

/** Wrapper shape persisted to Kintone. `bodyHash` lets readers verify the
 *  cache is still valid for the current config body. */
export interface RoutingCache {
  bodyHash: string;
  version: number; // schema version of this cache payload
  routes: RoutingRoute[];
}

// v2: added Meraki (Dashboard JSON) route extraction (S2S VPN subnets + static
// routes). Bumping invalidates older caches so Meraki records recompute.
// v3: Yamaha SWX support — fixed CIDR-form static-route next-hop parsing and
// added block-form (`interface vlanN` / `ip address`) connected routes.
// v4: ELECOM EHB support (`ip address ... mask` connected + `ip
// default-gateway` static default route).
// v5: Buffalo BS-GS support (`ip address` space-mask connected + `ip
// default-gateway` / dotted `ip route` static default).
export const ROUTING_CACHE_VERSION = 5;

/** Serialize routes to a compact JSON string for storage. */
export function serializeRoutingRoutes(
  routes: RoutingRoute[],
  bodyHash: string,
): string {
  const cache: RoutingCache = {
    bodyHash,
    version: ROUTING_CACHE_VERSION,
    routes,
  };
  return JSON.stringify(cache);
}

/** Parse a cached JSON string back into routes. Returns null if the cache is
 *  missing, malformed, or belongs to a different body hash / schema version. */
export function parseRoutingCache(
  stored: string,
  expectedBodyHash: string,
): RoutingRoute[] | null {
  if (!stored || !stored.trim()) return null;
  try {
    const cache = JSON.parse(stored) as RoutingCache;
    if (
      cache.version !== ROUTING_CACHE_VERSION ||
      cache.bodyHash !== expectedBodyHash ||
      !Array.isArray(cache.routes)
    ) {
      return null;
    }
    return cache.routes;
  } catch {
    return null;
  }
}

// ----- helpers -----

/** Convert an IPv4 dotted-quad mask (e.g. 255.255.255.0) to a CIDR length.
 *  Returns -1 for an invalid mask. */
function netmaskToCidr(mask: string): number {
  const parts = mask.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return -1;
  }
  let bits = 0;
  for (const p of parts) bits = (bits << 8) | p;
  bits = bits >>> 0;
  // Valid masks are a prefix of 1s followed by 0s.
  if (bits === 0) return 0;
  const inv = ~bits >>> 0;
  if ((inv & (inv + 1)) >>> 0 !== 0) return -1; // non-contiguous
  let n = 0;
  let v = bits;
  while (v !== 0) {
    n++;
    v &= v - 1;
  }
  return n;
}

/** True for strings like "10.0.0.0/24". */
function isCidr(s: string): boolean {
  const m = s.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d+)$/);
  if (!m) return false;
  const prefix = Number.parseInt(m[2], 10);
  return prefix >= 0 && prefix <= 32;
}

/** Normalize "10.0.0.0 255.255.255.0" -> "10.0.0.0/24".\n *  Returns the input unchanged when it cannot be normalized. */
function toCidr(addr: string, mask?: string): string {
  if (!mask) {
    // Already CIDR or bare host.
    if (isCidr(addr)) return addr;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return `${addr}/32`;
    return addr;
  }
  const prefix = netmaskToCidr(mask);
  if (prefix < 0) return `${addr} ${mask}`;
  return `${addr}/${prefix}`;
}

// ----- Cisco (IOS/IOS-XE/NX-OS/ASA) -----

/** Scan interface blocks for `ip address` lines and produce "connected"
 *  pseudo-routes. Yields one route per interface with an IPv4 address. */
function extractCiscoConnected(lines: string[]): RoutingRoute[] {
  const routes: RoutingRoute[] = [];
  let currentIf = "";
  let currentIp: { ip: string; mask: string } | null = null;

  const flush = (line: number) => {
    if (currentIf && currentIp) {
      routes.push({
        vendor: "Cisco",
        protocol: "connected",
        network: toCidr(currentIp.ip, currentIp.mask),
        nextHop: "directly-connected",
        interface: currentIf,
        line,
        raw: `interface ${currentIf} / ip address ${currentIp.ip} ${currentIp.mask}`,
      });
    }
    currentIp = null;
  };

  lines.forEach((raw, idx) => {
    const ifM = raw.match(/^\s*interface\s+(\S+)/i);
    if (ifM) {
      flush(idx + 1);
      currentIf = ifM[1];
      return;
    }
    if (/^\s*!/i.test(raw) || /^\s*end\s*$/i.test(raw)) {
      // Comments don't necessarily end an interface block in IOS, but the
      // next "interface" line will. Leave currentIf set.
      return;
    }
    const ipM = raw.match(/^\s*ip\s+address\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)/i);
    if (ipM && currentIf) {
      currentIp = { ip: ipM[1], mask: ipM[2] };
    }
  });
  flush(lines.length);
  return routes;
}

/** Parse a single Cisco `ip route ...` (IOS/IOS-XE/NX-OS) or
 *  `route <ifname> ...` (ASA) line. */
function parseCiscoStatic(
  raw: string,
  vendor: string,
  asaIf?: string,
): RoutingRoute | null {
  // ASA form: `route OUTSIDE 10.0.0.0 255.255.255.0 192.168.1.1 1`
  // IOS form: `ip route 10.0.0.0 255.255.255.0 192.168.1.1 [110] [tag N] [name X]`
  const tokens = raw.trim().split(/\s+/);
  const startIdx = asaIf ? tokens.indexOf(asaIf) + 1 : tokens.indexOf("route") + 1;
  if (tokens[startIdx - 1] !== "route") return null;
  const rest = tokens.slice(startIdx);
  if (rest.length < 2) return null;

  const dest = rest[0];
  const mask = rest[1];
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(dest)) return null;
  const network = toCidr(dest, /^\d{1,3}(\.\d{1,3}){3}$/.test(mask) ? mask : undefined);

  let nextHop = "";
  let interfaceName: string | undefined;
  let adminDistance: number | undefined;
  let metric: number | undefined;
  let i = 2;

  // Next token can be an interface, an IP, or "Null0"/"dhcp".
  if (i < rest.length) {
    const tok = rest[i];
    if (/^Null0$/i.test(tok) || /^dhcp$/i.test(tok)) {
      nextHop = tok;
      i++;
    } else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tok)) {
      nextHop = `${tok}/32`;
      i++;
    } else {
      // Treat as interface name (e.g. GigabitEthernet0/0) and possibly
      // followed by a next-hop IP.
      interfaceName = tok;
      i++;
      if (i < rest.length && /^\d{1,3}(\.\d{1,3}){3}$/.test(rest[i])) {
        nextHop = `${rest[i]}/32`;
        i++;
      } else {
        nextHop = tok;
      }
    }
  }

  // Trailing numeric = administrative distance (and possibly metric).
  while (i < rest.length) {
    const tok = rest[i];
    if (/^\d+$/.test(tok)) {
      const n = Number.parseInt(tok, 10);
      if (adminDistance === undefined) adminDistance = n;
      else if (metric === undefined) metric = n;
      i++;
      continue;
    }
    // Tags: "tag N", "name X", "permanent", "track N"
    if (/^tag$/i.test(tok)) {
      const t = rest[i + 1];
      if (t) i += 2;
      continue;
    }
    if (/^name$/i.test(tok)) {
      const n = rest[i + 1];
      if (n) i += 2;
      continue;
    }
    i++;
  }

  return {
    vendor,
    protocol: "static",
    network,
    nextHop,
    adminDistance,
    metric,
    interface: interfaceName ?? asaIf,
    line: 0, // filled in by caller
    raw,
  };
}

/** Extract OSPF/BGP summary entries from a Cisco `router <proto>` block. */
function extractCiscoRoutingProtocols(lines: string[]): RoutingRoute[] {
  const routes: RoutingRoute[] = [];
  let proto = "";
  let procId = "";
  let asn = "";

  const flushBlock = (endLine: number) => {
    proto = "";
    procId = "";
    asn = "";
    void endLine;
  };

  lines.forEach((raw, idx) => {
    const routerM = raw.match(/^\s*router\s+(ospf|bgp|eigrp|rip)\s+(\S+)/i);
    if (routerM) {
      flushBlock(idx);
      proto = routerM[1].toLowerCase();
      procId = routerM[2];
      if (proto === "bgp") asn = procId;
      return;
    }
    if (/^\s*!/i.test(raw) || /^\s*end\s*$/i.test(raw) || (/^\s*router\s+\S+/i.test(raw) && !routerM)) {
      flushBlock(idx);
      return;
    }
    if (!proto) return;

    if (proto === "ospf") {
      const netM = raw.match(/^\s*network\s+(\S+)\s+(\S+)\s+area\s+(\S+)/i);
      if (netM) {
        const network = toCidr(netM[1], netM[2]);
        routes.push({
          vendor: "Cisco",
          protocol: "ospf",
          network,
          nextHop: "",
          attributes: `area ${netM[3]} · process ${procId}`,
          line: idx + 1,
          raw,
        });
        return;
      }
      const areaM = raw.match(/^\s*area\s+(\S+)\s+range\s+(\S+)\s+(\S+)/i);
      if (areaM) {
        routes.push({
          vendor: "Cisco",
          protocol: "ospf",
          network: toCidr(areaM[2], areaM[3]),
          nextHop: "",
          attributes: `area ${areaM[1]} · process ${procId} · summary-range`,
          line: idx + 1,
          raw,
        });
      }
    } else if (proto === "bgp") {
      const neighM = raw.match(/^\s*neighbor\s+(\S+)\s+remote-as\s+(\S+)/i);
      if (neighM) {
        routes.push({
          vendor: "Cisco",
          protocol: "bgp",
          network: "",
          nextHop: neighM[1],
          attributes: `AS ${asn} · remote-as ${neighM[2]}`,
          line: idx + 1,
          raw,
        });
        return;
      }
      const netM = raw.match(/^\s*network\s+(\S+)\s+mask\s+(\S+)/i);
      if (netM) {
        routes.push({
          vendor: "Cisco",
          protocol: "bgp",
          network: toCidr(netM[1], netM[2]),
          nextHop: "",
          attributes: `AS ${asn}`,
          line: idx + 1,
          raw,
        });
      }
    } else if (proto === "eigrp" || proto === "rip") {
      const netM = raw.match(/^\s*network\s+(\S+)/i);
      if (netM) {
        routes.push({
          vendor: "Cisco",
          protocol: proto,
          network: netM[1],
          nextHop: "",
          attributes: `process ${procId}`,
          line: idx + 1,
          raw,
        });
      }
    }
  });
  return routes;
}

function extractCisco(lines: string[], vendor: string): RoutingRoute[] {
  const routes: RoutingRoute[] = [];

  // Static + ASA `route OUTSIDE ...` lines.
  lines.forEach((raw, idx) => {
    const iosM = raw.match(/^\s*ip\s+route\s+/i);
    const asaM = raw.match(/^\s*route\s+(?!ospf|bgp|eigrp|rip)(\S+)\s+(\d+\.\d+\.\d+\.\d+)/i);
    if (iosM) {
      const r = parseCiscoStatic(raw, vendor);
      if (r) {
        r.line = idx + 1;
        routes.push(r);
      }
    } else if (asaM) {
      const r = parseCiscoStatic(raw, vendor, asaM[1]);
      if (r) {
        r.line = idx + 1;
        routes.push(r);
      }
    }
  });

  // Connected interfaces.
  routes.push(...extractCiscoConnected(lines));

  // Routing-protocol summary info.
  routes.push(...extractCiscoRoutingProtocols(lines));

  return routes;
}

// ----- Juniper Junos -----

function extractJuniper(lines: string[]): RoutingRoute[] {
  const routes: RoutingRoute[] = [];

  // `set routing-options static route <N>/<prefix> next-hop <IP>` (set form)
  // or `route <N>/<prefix> { next-hop <IP>; }` (bracket form)
  const staticSetRe =
    /set\s+routing-options\s+static\s+route\s+(\S+?)\s+(?:next-hop|discard|reject)(?:\s+(\S+))?/i;
  const qualifiedNextHopRe =
    /set\s+routing-options\s+static\s+route\s+(\S+?)\s+qualified-next-hop\s+(\S+)/i;

  // interface addresses -> "connected"
  const ifAddrSetRe =
    /set\s+interfaces\s+(\S+)\s+unit\s+(\S+)\s+family\s+inet\s+address\s+(\d+\.\d+\.\d+\.\d+\/\d+)/i;

  // protocols
  const ospfSetRe =
    /set\s+protocols\s+ospf\s+area\s+(\S+)\s+interface\s+(\S+)(?:\d+)?/i;
  const bgpSetRe =
    /set\s+protocols\s+bgp\s+group\s+(\S+)\s+neighbor\s+(\S+)/i;
  const bgpGroupRe = /set\s+protocols\s+bgp\s+group\s+(\S+)\s+peer-as\s+(\S+)/i;

  // bracket form tracking (best-effort, shallow)
  let inRoutingOptions = false;
  let inStatic = false;

  lines.forEach((raw, idx) => {
    const trimmed = raw.trim();

    const m1 = trimmed.match(staticSetRe);
    if (m1) {
      routes.push({
        vendor: "Juniper",
        protocol: "static",
        network: m1[1],
        nextHop: m1[2] ? `${m1[2]}/32` : "discard",
        line: idx + 1,
        raw,
      });
      return;
    }
    const m1b = trimmed.match(qualifiedNextHopRe);
    if (m1b) {
      routes.push({
        vendor: "Juniper",
        protocol: "static",
        network: m1b[1],
        nextHop: `${m1b[2]}/32`,
        attributes: "qualified-next-hop",
        line: idx + 1,
        raw,
      });
      return;
    }
    const m2 = trimmed.match(ifAddrSetRe);
    if (m2) {
      routes.push({
        vendor: "Juniper",
        protocol: "connected",
        network: m2[3],
        nextHop: "directly-connected",
        interface: `${m2[1]}.${m2[2]}`,
        line: idx + 1,
        raw,
      });
      return;
    }
    const m3 = trimmed.match(ospfSetRe);
    if (m3) {
      routes.push({
        vendor: "Juniper",
        protocol: "ospf",
        network: "",
        nextHop: "",
        interface: m3[2],
        attributes: `area ${m3[1]}`,
        line: idx + 1,
        raw,
      });
      return;
    }
    const m4 = trimmed.match(bgpGroupRe);
    if (m4) {
      routes.push({
        vendor: "Juniper",
        protocol: "bgp",
        network: "",
        nextHop: "",
        attributes: `group ${m4[1]} · peer-as ${m4[2]}`,
        line: idx + 1,
        raw,
      });
      return;
    }
    const m5 = trimmed.match(bgpSetRe);
    if (m5) {
      routes.push({
        vendor: "Juniper",
        protocol: "bgp",
        network: "",
        nextHop: m5[2],
        attributes: `group ${m5[1]}`,
        line: idx + 1,
        raw,
      });
      return;
    }

    // Bracket-form static routes:
    //   routing-options { static { route 10.0.0.0/24 { next-hop 1.2.3.4; } } }
    if (/^routing-options\s*\{?/i.test(trimmed)) inRoutingOptions = true;
    if (inRoutingOptions && /static\s*\{?/i.test(trimmed)) inStatic = true;
    if (inStatic) {
      const routeM = trimmed.match(/^route\s+(\S+)\s*\{?/);
      if (routeM) {
        // Look ahead for next-hop on subsequent lines.
        const net = routeM[1];
        for (let j = idx + 1; j < Math.min(lines.length, idx + 10); j++) {
          const nh = lines[j].trim().match(/^next-hop\s+(\S+);/);
          if (nh) {
            routes.push({
              vendor: "Juniper",
              protocol: "static",
              network: net,
              nextHop: `${nh[1]}/32`,
              line: idx + 1,
              raw: `${trimmed} ... ${lines[j].trim()}`,
            });
            break;
          }
          if (/^\}/.test(lines[j].trim())) break;
        }
      }
      if (/^\}/.test(trimmed)) {
        inStatic = false;
      }
    }
    if (inRoutingOptions && /^\}/.test(trimmed)) inRoutingOptions = false;
  });
  return routes;
}

// ----- Fortinet FortiOS -----

function extractFortinet(lines: string[]): RoutingRoute[] {
  const routes: RoutingRoute[] = [];
  let inRouterStatic = false;
  let inEdit = false;
  let entry: {
    dst?: string;
    mask?: string;
    gateway?: string;
    device?: string;
    distance?: string;
    weight?: string;
  } | null = null;

  const flush = (idx: number, rawLast: string) => {
    if (entry) {
      const network = entry.dst
        ? toCidr(entry.dst, entry.mask)
        : "";
      routes.push({
        vendor: "Fortinet",
        protocol: "static",
        network,
        nextHop: entry.gateway ? `${entry.gateway}/32` : "",
        interface: entry.device,
        adminDistance: entry.distance ? Number.parseInt(entry.distance, 10) : undefined,
        metric: entry.weight ? Number.parseInt(entry.weight, 10) : undefined,
        line: idx,
        raw: rawLast,
      });
    }
    entry = null;
  };

  lines.forEach((raw, idx) => {
    const trimmed = raw.trim();
    if (/^config\s+router\s+static\s*$/i.test(trimmed)) {
      inRouterStatic = true;
      inEdit = false;
      return;
    }
    if (inRouterStatic && /^config\s+/i.test(trimmed)) {
      // nested sub-config block (e.g. config nat) — skip
      return;
    }
    if (inRouterStatic && /^end\s*$/i.test(trimmed)) {
      flush(idx, raw);
      inRouterStatic = false;
      return;
    }
    if (!inRouterStatic) return;

    const editM = trimmed.match(/^edit\s+(\S+)/i);
    if (editM) {
      flush(idx, raw);
      inEdit = true;
      entry = {};
      return;
    }
    if (/^next\s*$/i.test(trimmed)) {
      flush(idx, raw);
      inEdit = false;
      return;
    }
    if (inEdit && entry) {
      const setM = trimmed.match(/^set\s+(\S+)\s+(.+)$/i);
      if (setM) {
        const key = setM[1].toLowerCase();
        const val = setM[2].replace(/^["']|["']$/g, "").trim();
        if (key === "dst") entry.dst = val;
        else if (key === "gateway") entry.gateway = val;
        else if (key === "device") entry.device = val;
        else if (key === "distance") entry.distance = val;
        else if (key === "weight") entry.weight = val;
        else if (key === "netmask") entry.mask = val;
      }
    }
  });
  flush(lines.length, "");

  // FortiOS connected interface IPs (`set ip A.B.C.D MASK` inside
  // `config system interface`).
  let inSystemInterface = false;
  let curIfName = "";
  lines.forEach((raw, idx) => {
    const trimmed = raw.trim();
    if (/^config\s+system\s+interface\s*$/i.test(trimmed)) {
      inSystemInterface = true;
      return;
    }
    if (inSystemInterface && /^end\s*$/i.test(trimmed)) {
      inSystemInterface = false;
      return;
    }
    if (!inSystemInterface) return;
    const editM = trimmed.match(/^edit\s+(\S+)/i);
    if (editM) {
      curIfName = editM[1].replace(/^["']|["']$/g, "");
      return;
    }
    const ipM = trimmed.match(/^set\s+ip\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)/i);
    if (ipM && curIfName) {
      routes.push({
        vendor: "Fortinet",
        protocol: "connected",
        network: toCidr(ipM[1], ipM[2]),
        nextHop: "directly-connected",
        interface: curIfName,
        line: idx + 1,
        raw,
      });
    }
  });

  // BGP neighbors from `config router bgp`.
  let inBgp = false;
  let inNeighbor = false;
  let bgpAsn = "";
  lines.forEach((raw, idx) => {
    const trimmed = raw.trim();
    const bgpM = trimmed.match(/^config\s+router\s+bgp\s*$/i);
    if (bgpM) {
      inBgp = true;
      return;
    }
    if (inBgp && /^set\s+as\s+(\d+)/i.test(trimmed)) {
      bgpAsn = trimmed.match(/^set\s+as\s+(\d+)/i)?.[1] ?? "";
      return;
    }
    if (inBgp && /^config\s+neighbor\s*$/i.test(trimmed)) {
      inNeighbor = true;
      return;
    }
    if (inNeighbor && /^end\s*$/i.test(trimmed)) {
      inNeighbor = false;
      return;
    }
    if (inBgp && /^end\s*$/i.test(trimmed)) {
      inBgp = false;
      return;
    }
    if (inNeighbor) {
      const editM = trimmed.match(/^edit\s+(\S+)/i);
      if (editM) {
        const ip = editM[1].replace(/^["']|["']$/g, "");
        if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
          routes.push({
            vendor: "Fortinet",
            protocol: "bgp",
            network: "",
            nextHop: `${ip}/32`,
            attributes: bgpAsn ? `AS ${bgpAsn}` : "",
            line: idx + 1,
            raw,
          });
        }
      }
    }
  });

  return routes;
}

// ----- YAMAHA RT -----

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function extractYamaha(lines: string[]): RoutingRoute[] {
  const routes: RoutingRoute[] = [];
  // Static routes. Two syntaxes coexist across the RT and SWX families:
  //   ip route 10.0.0.0/24 192.168.1.1          (dest already CIDR — SWX/RTX)
  //   ip route 0.0.0.0/0 gateway 192.168.1.1    (RTX `gateway` keyword)
  //   ip route 10.0.0.0 255.255.255.0 10.0.0.1  (dotted mask)
  lines.forEach((raw, idx) => {
    const m = raw.match(/^\s*ip\s+route\s+(.+)$/i);
    if (!m) return;
    const tokens = m[1].trim().split(/\s+/);
    if (tokens.length < 2) return;
    const dest = tokens[0];

    let network: string;
    let rest: string[];
    if (!isCidr(dest) && IPV4_RE.test(dest) && IPV4_RE.test(tokens[1])) {
      // Dotted-mask form: `<dest> <mask> <gateway>` (dest is a bare address and
      // the second token is the netmask, not the gateway).
      network = toCidr(dest, tokens[1]);
      rest = tokens.slice(2);
    } else {
      // CIDR (or bare) dest form: `<dest/prefix> [gateway] <next-hop>`.
      network = toCidr(dest);
      rest = tokens.slice(1);
    }
    // Skip the RTX `gateway` keyword when present; the next token is the hop.
    const nextHop = rest.find((t) => t.toLowerCase() !== "gateway") ?? "";
    if (!nextHop) return;
    routes.push({
      vendor: "YAMAHA",
      protocol: "static",
      network,
      nextHop: IPV4_RE.test(nextHop) ? `${nextHop}/32` : nextHop,
      line: idx + 1,
      raw,
    });
  });

  // RT-style single-line connected addresses: `ip lan1 address 192.168.1.1/24`.
  lines.forEach((raw, idx) => {
    const m = raw.match(/^\s*ip\s+(lan\d+|pp|tunnel\d+|vlan\d+)\s+address\s+(\d+\.\d+\.\d+\.\d+\/\d+)/i);
    if (m) {
      routes.push({
        vendor: "YAMAHA",
        protocol: "connected",
        network: m[2],
        nextHop: "directly-connected",
        interface: m[1],
        line: idx + 1,
        raw,
      });
    }
  });

  // SWX-style block form: an `interface vlanN` block containing an
  // `ip address A.B.C.D/prefix` line (Cisco-like indentation). The address
  // may also appear in dotted-mask form.
  routes.push(...extractYamahaSwxConnected(lines));

  return routes;
}

/** Scan `interface <name>` blocks for `ip address` lines (SWX switches use
 *  Cisco-style indented interface blocks rather than RT's single-line
 *  `ip lanN address`). */
function extractYamahaSwxConnected(lines: string[]): RoutingRoute[] {
  const routes: RoutingRoute[] = [];
  let currentIf = "";
  lines.forEach((raw, idx) => {
    const ifM = raw.match(/^\s*interface\s+(\S+)/i);
    if (ifM) {
      currentIf = ifM[1];
      return;
    }
    if (!currentIf) return;
    // CIDR form: `ip address 192.168.100.254/24`.
    const cidrM = raw.match(/^\s*ip\s+address\s+(\d+\.\d+\.\d+\.\d+\/\d+)\b/i);
    if (cidrM) {
      routes.push({
        vendor: "YAMAHA",
        protocol: "connected",
        network: cidrM[1],
        nextHop: "directly-connected",
        interface: currentIf,
        line: idx + 1,
        raw: raw.trim(),
      });
      return;
    }
    // Dotted-mask form: `ip address 192.168.1.1 255.255.255.0`.
    const maskM = raw.match(
      /^\s*ip\s+address\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\b/i,
    );
    if (maskM) {
      routes.push({
        vendor: "YAMAHA",
        protocol: "connected",
        network: toCidr(maskM[1], maskM[2]),
        nextHop: "directly-connected",
        interface: currentIf,
        line: idx + 1,
        raw: raw.trim(),
      });
    }
  });
  return routes;
}

// ----- ELECOM EHB switch -----

/** ELECOM EHB switches expose only a management IP and a default gateway.
 *   - `ip address A.B.C.D mask M.M.M.M`  -> connected (management SVI)
 *   - `ip default-gateway A.B.C.D`       -> static default route (0.0.0.0/0)
 *  There are no dynamic routing protocols or per-interface addresses. */
function extractElecom(lines: string[]): RoutingRoute[] {
  const routes: RoutingRoute[] = [];
  lines.forEach((raw, idx) => {
    const addrM = raw.match(
      /^\s*ip\s+address\s+(\d+\.\d+\.\d+\.\d+)\s+mask\s+(\d+\.\d+\.\d+\.\d+)/i,
    );
    if (addrM) {
      routes.push({
        vendor: "ELECOM",
        protocol: "connected",
        network: toCidr(addrM[1], addrM[2]),
        nextHop: "directly-connected",
        line: idx + 1,
        raw: raw.trim(),
      });
      return;
    }
    const gwM = raw.match(/^\s*ip\s+default-gateway\s+(\d+\.\d+\.\d+\.\d+)/i);
    if (gwM) {
      routes.push({
        vendor: "ELECOM",
        protocol: "static",
        network: "0.0.0.0/0",
        nextHop: `${gwM[1]}/32`,
        line: idx + 1,
        raw: raw.trim(),
      });
    }
  });
  return routes;
}

// ----- Buffalo BS-GS switch -----

/** Buffalo BS-GS switches use a small routing surface:
 *   - `ip address A.B.C.D M.M.M.M`      -> connected (global + `interface vlanN`)
 *   - `ip default-gateway A.B.C.D`       -> static default route
 *   - `ip route 0.0.0.0 0.0.0.0 A.B.C.D` -> static default (Cisco dotted form)
 *  The mask is space-separated (no `mask` keyword, unlike ELECOM). Connected
 *  addresses are de-duplicated because the management address is repeated both
 *  globally and inside `interface vlan1`. */
function extractBuffalo(lines: string[]): RoutingRoute[] {
  const routes: RoutingRoute[] = [];
  let currentIf = "";
  const seenConnected = new Set<string>();

  lines.forEach((raw, idx) => {
    const ifM = raw.match(/^\s*interface\s+(\S+)/i);
    if (ifM) {
      currentIf = ifM[1];
      return;
    }
    const addrM = raw.match(
      /^\s*ip\s+address\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)/i,
    );
    if (addrM) {
      const network = toCidr(addrM[1], addrM[2]);
      if (!seenConnected.has(network)) {
        seenConnected.add(network);
        routes.push({
          vendor: "Buffalo",
          protocol: "connected",
          network,
          nextHop: "directly-connected",
          interface: /^vlan\d+/i.test(currentIf) ? currentIf : undefined,
          line: idx + 1,
          raw: raw.trim(),
        });
      }
      return;
    }
    const gwM = raw.match(/^\s*ip\s+default-gateway\s+(\d+\.\d+\.\d+\.\d+)/i);
    if (gwM) {
      routes.push({
        vendor: "Buffalo",
        protocol: "static",
        network: "0.0.0.0/0",
        nextHop: `${gwM[1]}/32`,
        line: idx + 1,
        raw: raw.trim(),
      });
      return;
    }
    // `ip route <dest> <mask> <gateway>` (Cisco dotted form).
    const routeM = raw.match(
      /^\s*ip\s+route\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)/i,
    );
    if (routeM) {
      routes.push({
        vendor: "Buffalo",
        protocol: "static",
        network: toCidr(routeM[1], routeM[2]),
        nextHop: `${routeM[3]}/32`,
        line: idx + 1,
        raw: raw.trim(),
      });
    }
  });
  // `ip default-gateway` and `ip route 0.0.0.0 0.0.0.0 ...` often coexist and
  // express the same default route; collapse identical (network, nextHop) pairs.
  const seen = new Set<string>();
  return routes.filter((r) => {
    const key = `${r.protocol}|${r.network}|${r.nextHop}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ----- dispatcher -----

/** Quick structural sniff to pick a parser when the vendor is unknown. */
// ----- Cisco Meraki (Dashboard API JSON dump) -----

/** Extract routing info from a Meraki dump. Two sources:
 *   - Static Routes: `[{ name, subnet, gatewayIp, enabled }]` (routed mode only)
 *   - Site-to-site VPN: `{ mode, hubs, subnets: [{ localSubnet, useVpn }] }`.
 *     Each `useVpn: true` local subnet is an advertised VPN route; in spoke
 *     mode the hub is the effective next hop for remote networks. We surface
 *     the advertised subnets as protocol="vpn" so the routing view shows what
 *     the appliance participates in even without a classic routing table
 *     (e.g. passthrough / bridge mode MX). */
function extractMeraki(lines: string[], vendor: string): RoutingRoute[] {
  const routes: RoutingRoute[] = [];
  const text = lines.join("\n");
  let seq = 0;
  for (const { value } of collectMerakiJsonBlocks(text)) {
    // Static routes: array of { subnet, gatewayIp, ... }.
    if (Array.isArray(value)) {
      const isStatic = value.some(
        (r) =>
          r !== null &&
          typeof r === "object" &&
          "subnet" in r &&
          "gatewayIp" in r,
      );
      if (isStatic) {
        for (const r of value) {
          if (r === null || typeof r !== "object") continue;
          const o = r as Record<string, unknown>;
          seq++;
          routes.push({
            vendor,
            protocol: "static",
            network: String(o.subnet ?? ""),
            nextHop: String(o.gatewayIp ?? ""),
            attributes:
              [
                typeof o.name === "string" && o.name ? `name=${o.name}` : "",
                o.enabled === false ? "disabled" : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined,
            line: seq,
            raw: JSON.stringify(r),
          });
        }
      }
      continue;
    }
    // Site-to-site VPN object: { mode, hubs, subnets }.
    if (value !== null && typeof value === "object") {
      const o = value as Record<string, unknown>;
      if ("mode" in o && Array.isArray(o.subnets)) {
        const mode = String(o.mode ?? "");
        const hubs = Array.isArray(o.hubs) ? o.hubs : [];
        const hubId =
          hubs.length > 0 &&
          hubs[0] !== null &&
          typeof hubs[0] === "object"
            ? String((hubs[0] as Record<string, unknown>).hubId ?? "")
            : "";
        for (const s of o.subnets as unknown[]) {
          if (s === null || typeof s !== "object") continue;
          const sub = s as Record<string, unknown>;
          if (sub.useVpn !== true) continue; // only VPN-advertised subnets
          const local = String(sub.localSubnet ?? "");
          if (!local) continue;
          seq++;
          routes.push({
            vendor,
            protocol: "vpn",
            network: local,
            nextHop: mode === "spoke" && hubId ? `hub:${hubId}` : "site-to-site VPN",
            attributes: `mode=${mode || "?"}`,
            line: seq,
            raw: JSON.stringify(s),
          });
        }
      }
    }
  }
  return routes;
}

function guessVendorFromConfig(lines: string[]): string {
  const has = (re: RegExp) => lines.some((l) => re.test(l));
  // Meraki: fixed dump header, or S2S VPN localSubnet / static-route JSON keys.
  if (
    has(/Meraki Network Configuration Dump/) ||
    has(/"localSubnet"/) ||
    has(/"gatewayIp"/)
  ) {
    return "Cisco Meraki";
  }
  if (has(/^set\s+routing-options\s+/i) || has(/^routing-options\s*\{?/i)) return "Juniper";
  if (has(/^config\s+router\s+(static|bgp|ospf)/i) || has(/^#config-version=/i)) return "Fortinet";
  // Buffalo BS-GS: fixed start banner, or `interface vlanN` + `member N`.
  if (
    has(/^!\s*--\s*start of\s+BS-\S+\s+config/i) ||
    has(/^\s*member\s+[\d,\s-]+$/i) ||
    has(/^\s*PVID\s+\d+/i)
  ) {
    return "Buffalo";
  }
  // ELECOM EHB: fixed banner or `ip address ... mask ...` + default-gateway.
  if (
    has(/^SYSTEM\s+CONFIG\s+FILE\s*::=\s*BEGIN/i) ||
    has(/^!\s*System Description:.*EHB-/i) ||
    (has(/^\s*ip\s+address\s+\d+\.\d+\.\d+\.\d+\s+mask\s+/i) &&
      has(/^\s*ip\s+default-gateway\s+/i))
  ) {
    return "ELECOM";
  }
  if (has(/^\s*ip\s+lan\d+\s+address\s+/i)) return "YAMAHA";
  // SWX switches: `interface port1.N` + (l2ms | vlan database). Checked before
  // the Cisco `ip route` catch-all so a SWX config isn't misread as Cisco.
  if (
    has(/^\s*interface\s+port\d+\.\d+/i) &&
    (has(/^\s*l2ms\b/i) || has(/^\s*vlan\s+database\s*$/i))
  ) {
    return "YAMAHA";
  }
  if (
    has(/^\s*ip\s+route\s+/i) ||
    has(/^\s*route\s+\S+\s+\d+\.\d+\.\d+\.\d+\s+/i) ||
    has(/^\s*router\s+(ospf|bgp|eigrp|rip)\s+/i)
  ) {
    return "Cisco";
  }
  return "";
}

/** Extract routing info from a config body, using the detected vendor/OS
 *  to pick the right parser. Same fallback strategy as the firewall
 *  extractor: detected vendor -> structural guess -> try every parser. */
export function extractRoutingRoutes(
  body: string,
  detection: DeviceDetection | undefined,
): RoutingRoute[] {
  if (!body) return [];
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const vendor = detection?.vendor ?? "";

  if (vendor) {
    const r = runForVendor(lines, vendor);
    if (r.length > 0) return r;
  }

  const guessed = guessVendorFromConfig(lines);
  if (guessed && guessed !== vendor) {
    const r = runForVendor(lines, guessed);
    if (r.length > 0) return r;
  }

  let best: RoutingRoute[] = [];
  for (const v of ["Cisco Meraki", "Cisco", "Juniper", "Fortinet", "YAMAHA", "ELECOM", "Buffalo"]) {
    const r = runForVendor(lines, v);
    if (r.length > best.length) best = r;
  }
  return best;
}

function runForVendor(lines: string[], vendor: string): RoutingRoute[] {
  switch (vendor) {
    case "Cisco Meraki":
      return extractMeraki(lines, vendor);
    case "Cisco":
      return extractCisco(lines, vendor);
    case "Juniper":
      return extractJuniper(lines);
    case "Fortinet":
      return extractFortinet(lines);
    case "YAMAHA":
      return extractYamaha(lines);
    case "ELECOM":
      return extractElecom(lines);
    case "Buffalo":
      return extractBuffalo(lines);
    default:
      return [];
  }
}

// ----- structural diff -----

/** Build a stable signature for a route, ignoring position-dependent fields. */
function routingRouteSignature(r: RoutingRoute): string {
  return [
    r.vendor,
    r.protocol,
    r.network,
    r.nextHop,
    r.interface ?? "",
  ]
    .map((s) => (s ?? "").replace(/\|/g, "||"))
    .join("|");
}

/** Compare two routes for full equality, ignoring only source line / raw. */
function routingRoutesEqual(a: RoutingRoute, b: RoutingRoute): boolean {
  return (
    routingRouteSignature(a) === routingRouteSignature(b) &&
    (a.adminDistance ?? "") === (b.adminDistance ?? "") &&
    (a.metric ?? "") === (b.metric ?? "") &&
    (a.attributes ?? "") === (b.attributes ?? "")
  );
}

/** Compute a structural diff between two routing tables. */
export function diffRoutingRoutes(
  before: RoutingRoute[],
  after: RoutingRoute[],
): RoutingRouteDiff {
  const beforeBySig = new Map<string, RoutingRoute[]>();
  for (const r of before) {
    const sig = routingRouteSignature(r);
    const arr = beforeBySig.get(sig);
    if (arr) arr.push(r);
    else beforeBySig.set(sig, [r]);
  }
  const afterBySig = new Map<string, RoutingRoute[]>();
  for (const r of after) {
    const sig = routingRouteSignature(r);
    const arr = afterBySig.get(sig);
    if (arr) arr.push(r);
    else afterBySig.set(sig, [r]);
  }

  const added: RoutingRoute[] = [];
  const removed: RoutingRoute[] = [];
  const changed: RoutingRouteChange[] = [];
  let unchanged = 0;

  const allSigs = new Set<string>([...beforeBySig.keys(), ...afterBySig.keys()]);
  for (const sig of allSigs) {
    const bs = beforeBySig.get(sig) ?? [];
    const asAfter = afterBySig.get(sig) ?? [];
    const pairCount = Math.min(bs.length, asAfter.length);
    for (let i = 0; i < pairCount; i++) {
      if (routingRoutesEqual(bs[i], asAfter[i])) unchanged++;
      else changed.push({ before: bs[i], after: asAfter[i] });
    }
    for (let i = pairCount; i < asAfter.length; i++) added.push(asAfter[i]);
    for (let i = pairCount; i < bs.length; i++) removed.push(bs[i]);
  }

  return { added, removed, changed, unchanged };
}
