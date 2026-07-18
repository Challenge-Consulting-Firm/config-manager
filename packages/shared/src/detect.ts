/**
 * Best-effort automatic detection of vendor / OS / model from a network-device
 * config body. Detection runs on the *raw* uploaded body (before
 * normalization) so that banners and comment headers — which carry the most
 * reliable signals — are available.
 *
 * The result is informational. User-entered identifiers (hostname etc.) stay
 * authoritative; detection only supplements metadata.
 */

export interface DeviceDetection {
  /** Vendor name, e.g. "Cisco", "Juniper", "YAMAHA". Empty if unknown. */
  vendor: string;
  /** OS/product name, e.g. "IOS", "IOS-XE", "NX-OS", "Junos". */
  os: string;
  /** OS version string, e.g. "15.1", "9.3(2)", "12.3R6.6". */
  osVersion: string;
  /** Device model if extractable, e.g. "ISR4321/K9", "RTX5000". */
  model: string;
  /** Hostname extracted from the config (best-effort). */
  hostname: string;
  /** Management IPv4 address extracted from the config (best-effort). */
  ipAddress: string;
  /** Detection confidence in [0, 1]. 0 means "no signal / unknown". */
  confidence: number;
}

export const EMPTY_DETECTION: DeviceDetection = {
  vendor: "",
  os: "",
  osVersion: "",
  model: "",
  hostname: "",
  ipAddress: "",
  confidence: 0,
};

interface Rule {
  name: string;
  detect: (lines: string[]) => DeviceDetection | null;
}

// Cisco IOS/IOS-XE interface names — distinctive of the IOS family.
const CISCO_IOS_INTERFACE_RE =
  /^\s*interface\s+(GigabitEthernet|FastEthernet|TenGigabitEthernet|FiveGigabitEthernet|TwentyFiveGigE|FortyGigabitEthernet|HundredGigE|AppGigabitEthernet|Cellular)\d/i;

// IPv4 address that is not a reserved/loopback/broadcast value.
const IP_RE = /\b((?:\d{1,3}\.){3}\d{1,3})\b/;
const RESERVED_IPS = new Set([
  "0.0.0.0",
  "127.0.0.1",
  "255.255.255.255",
]);

/** Pick the first non-reserved IPv4 from a list of candidates. */
function pickFirstIp(candidates: string[]): string {
  for (const c of candidates) {
    if (!c) continue;
    const m = c.match(IP_RE);
    if (m && !RESERVED_IPS.has(m[1])) return m[1];
  }
  return "";
}

/** Extract a Cisco-style management IP. Prefers Vlan/Management/Loopback
 *  interfaces, then falls back to the first physical interface's address. */
function extractCiscoIp(lines: string[]): string {
  const MGMT_IFACE = /interface\s+(Vlan|Management|Loopback|mgmt)\d/i;
  const PHYS_IFACE = /^\s*interface\s+\S+/i;
  const IP_LINE = /^\s*ip\s+address\s+(\S+)/i;

  let currentIf = "";
  let mgmtIp = "";
  let firstPhysIp = "";
  for (const l of lines) {
    const ifM = l.match(/^\s*interface\s+(\S+)/i);
    if (ifM) {
      currentIf = ifM[1];
      continue;
    }
    const ipM = l.match(IP_LINE);
    if (!ipM) continue;
    const ip = ipM[1];
    if (!mgmtIp && MGMT_IFACE.test(`interface ${currentIf}`)) mgmtIp = ip;
    if (!firstPhysIp && PHYS_IFACE.test(`interface ${currentIf}`)) firstPhysIp = ip;
  }
  return pickFirstIp([mgmtIp, firstPhysIp]);
}

function firstMatch(lines: string[], re: RegExp): string | undefined {
  for (const l of lines) {
    const m = l.match(re);
    if (m) return m[1];
  }
  return undefined;
}

/** Like firstMatch, but skips reserved/zero IPv4 values (0.0.0.0, 127.0.0.1,
 *  255.255.255.255). Used for interface-IP extraction where some interfaces
 *  report `0.0.0.0` (e.g. FortiGate's unused ports). */
function firstNonZeroIp(lines: string[], re: RegExp): string {
  for (const l of lines) {
    const m = l.match(re);
    if (!m) continue;
    const ip = m[1];
    if (!RESERVED_IPS.has(ip)) return ip;
  }
  return "";
}

const rules: Rule[] = [
  // ----- Cisco IOS / IOS-XE -----
  {
    name: "cisco-ios",
    detect: (lines) => {
      const banner = lines.find((l) =>
        /Cisco IOS XE Software|Cisco IOS Software/i.test(l),
      );
      const versionLine = lines.find((l) =>
        /^\s*version\s+\d+\.\d+/.test(l),
      );
      const ciscoInterface = lines.find((l) => CISCO_IOS_INTERFACE_RE.test(l));
      const hasEnd = lines.some((l) => /^\s*end\s*$/.test(l));

      // Require at least one reasonably strong signal.
      if (!banner && !(versionLine && (ciscoInterface || hasEnd))) return null;

      let osVersion =
        firstMatch(lines, /Version\s+([\d][^\s,)]*)/i) ??
        firstMatch(lines, /^\s*version\s+(\d+\.\d+[^\s]*)/i) ??
        "";

      const major = Number.parseInt(osVersion, 10);
      const hasIosxeMarker = /IOS\s*XE/i.test(banner ?? "") ||
        lines.some((l) => /IOSXE|iosxe/i.test(l));
      const os = Number.isNaN(major)
        ? "IOS"
        : hasIosxeMarker || major >= 16
          ? "IOS-XE"
          : "IOS";

      const hostname =
        firstMatch(lines, /^\s*hostname\s+(\S+)/i) ?? "";
      // Model from banner: "cisco ISR4321/K9", "Cisco C9200L-24P-4G". Require a
      // digit so we don't capture "IOS" / "IOSXE" from the software name.
      const model =
        firstMatch(
          lines,
          /cisco\s+([A-Z0-9]{2,}[\w-]*\d[\w-]*(?:\/K9)?)/i,
        ) ?? "";

      const score =
        (banner ? 0.5 : 0) +
        (ciscoInterface ? 0.3 : 0) +
        (versionLine ? 0.1 : 0) +
        (hasEnd ? 0.1 : 0);
      return {
        vendor: "Cisco",
        os,
        osVersion,
        model,
        hostname,
        ipAddress: extractCiscoIp(lines),
        confidence: Math.min(score, 1),
      };
    },
  },
  // ----- Cisco NX-OS -----
  {
    name: "cisco-nxos",
    detect: (lines) => {
      const hasNxos = lines.some((l) => /NX-OS/i.test(l));
      const hasFeature = lines.some((l) => /^\s*feature\s+\w+/i.test(l));
      const hasNoStrength = lines.some((l) =>
        /no password strength-check/i.test(l),
      );
      if (!hasNxos && !hasFeature && !hasNoStrength) return null;
      const osVersion =
        firstMatch(lines, /version\s+(\d+\.\d+\([^)]+\)|\d+\.\d+)/i) ?? "";
      const hostname =
        firstMatch(lines, /^\s*(?:hostname|switchname)\s+(\S+)/i) ?? "";
      const score =
        (hasNxos ? 0.5 : 0) +
        (hasFeature ? 0.3 : 0) +
        (hasNoStrength ? 0.2 : 0);
      return {
        vendor: "Cisco",
        os: "NX-OS",
        osVersion,
        model: "",
        hostname,
        ipAddress: extractCiscoIp(lines),
        confidence: Math.min(score, 1),
      };
    },
  },
  // ----- Cisco ASA -----
  {
    name: "cisco-asa",
    detect: (lines) => {
      const hasAsa = lines.some((l) => /ASA\s+Version/i.test(l));
      const hasSecurityLevel = lines.some((l) =>
        /^\s*security-level\s+\d+/i.test(l),
      );
      const hasNameif = lines.some((l) => /^\s*nameif\s+\S+/i.test(l));
      if (!hasAsa && !hasSecurityLevel) return null;
      const osVersion =
        firstMatch(lines, /ASA\s+Version\s+([\d.()]+)/i) ?? "";
      const hostname =
        firstMatch(lines, /^\s*hostname\s+(\S+)/i) ?? "";
      const score =
        (hasAsa ? 0.5 : 0) +
        (hasSecurityLevel ? 0.3 : 0) +
        (hasNameif ? 0.2 : 0);
      return {
        vendor: "Cisco",
        os: "ASA",
        osVersion,
        model: "",
        hostname,
        ipAddress: extractCiscoIp(lines),
        confidence: Math.min(score, 1),
      };
    },
  },
  // ----- Fortinet FortiOS -----
  // NOTE: evaluated before Juniper because FortiGate's `set ...` syntax can
  // otherwise be mis-detected as Junos. The `#config-version=` header and the
  // `config system global` block are strong FortiOS signals.
  {
    name: "fortinet-fortios",
    detect: (lines) => {
      const hasConfigVersion = lines.some((l) =>
        /^#config-version=/i.test(l),
      );
      const hasFortios = lines.some((l) => /FortiOS|FortiGate/i.test(l));
      const hasConfigSystem = lines.some((l) =>
        /^config\s+system\s+/i.test(l),
      );
      if (!hasConfigVersion && !hasFortios && !hasConfigSystem) return null;

      // Version + model from the header: #config-version=FGT50E-6.2.16-FW-...
      const headerLine = lines.find((l) => /^#config-version=/i.test(l)) ?? "";
      const headerM = headerLine.match(
        /#config-version=([A-Z0-9]+)-([\d.]+)/i,
      );
      const osVersion = headerM?.[2] ?? "";
      const model = headerM?.[1] ?? "";

      // hostname: `set hostname "NAME"` (indented, quoted) inside
      // `config system global`.
      const hostnameRaw =
        firstMatch(lines, /^\s*set\s+hostname\s+(\S+)/i) ?? "";
      const hostname = hostnameRaw.replace(/^["']|["']$/g, "");

      // First non-zero IPv4 from a `set ip A.B.C.D MASK` line inside
      // `config system interface`.
      const ipAddress = firstNonZeroIp(lines, /^\s*set\s+ip\s+(\d+\.\d+\.\d+\.\d+)/i);

      const score =
        (hasConfigVersion ? 0.5 : 0) +
        (hasConfigSystem ? 0.3 : 0) +
        (hasFortios ? 0.2 : 0);
      return {
        vendor: "Fortinet",
        os: "FortiOS",
        osVersion,
        model,
        hostname,
        ipAddress,
        confidence: Math.min(score, 1),
      };
    },
  },
  // ----- Juniper Junos (set-format and bracket-format) -----
  {
    name: "juniper-junos",
    detect: (lines) => {
      const hasJunos = lines.some((l) => /junos/i.test(l));
      const hasCommit = lines.some((l) =>
        /^#+\s*(Last commit|last changed)/i.test(l),
      );
      // `set version VALUE` — but skip FortiGate's empty `set version ''`
      // lines (which otherwise falsely trigger this rule).
      const setVersion = lines.find((l) => {
        const m = l.match(/^\s*set\s+version\s+(\S+)/i);
        if (!m) return false;
        // reject pure-quote values like `''` or `""`
        return !/^['"]{2}$/.test(m[1]);
      });
      const bracketVersion = lines.find((l) =>
        /^\s*version\s+\S+;/.test(l),
      );
      const hasSetHostname = lines.some((l) =>
        /^\s*set\s+system\s+host-name\s+/i.test(l),
      );
      if (!hasJunos && !setVersion && !bracketVersion && !hasCommit) return null;

      let osVersion = "";
      const svm = (setVersion ?? "").match(/set\s+version\s+(\S+)/i);
      if (svm) osVersion = svm[1].replace(/^["']|["']$/g, "");
      if (!osVersion && bracketVersion) {
        const bvm = bracketVersion.match(/version\s+(\S+);/);
        if (bvm) osVersion = bvm[1].replace(/^["']|["']$/g, "");
      }
      const hostname = firstMatch(lines, /host-name\s+(\S+)\s*;?/i) ?? "";
      const score =
        (hasJunos ? 0.4 : 0) +
        (setVersion || bracketVersion ? 0.3 : 0) +
        (hasSetHostname ? 0.2 : 0) +
        (hasCommit ? 0.1 : 0);
      return {
        vendor: "Juniper",
        os: "Junos",
        osVersion,
        model: "",
        hostname: hostname.replace(/;$/, ""),
        // Prefer loopback/vlan; else first family-inet address.
        ipAddress:
          firstMatch(
            lines,
            /set\s+interfaces\s+\S*(?:lo0|vlan|fxp0)\S*\s+unit\s+\d+\s+family\s+inet\s+address\s+(\d+\.\d+\.\d+\.\d+)/i,
          ) ??
          firstMatch(
            lines,
            /set\s+interfaces\s+\S+\s+unit\s+\d+\s+family\s+inet\s+address\s+(\d+\.\d+\.\d+\.\d+)/i,
          ) ??
          "",
        confidence: Math.min(score, 1),
      };
    },
  },
  // ----- YAMAHA RT -----
  {
    name: "yamaha-rt",
    detect: (lines) => {
      // Header line: "# RTX5000 Rev.14.00.25 (Mon Mar 15 ...)"
      const header = lines.find((l) => /^#\s*RT[A-Z]+\d+/i.test(l));
      if (!header) return null;
      const model = header.match(/RT[A-Z]+\d+/i)?.[0] ?? "";
      const osVersion = header.match(/Rev\.?\s*([\d.]+)/i)?.[1] ?? "";
      return {
        vendor: "YAMAHA",
        os: "RT-OS",
        osVersion,
        model,
        hostname: "",
        // ip lan1/lan2/pp address X.X.X.X/X — prefer lan1.
        ipAddress:
          firstMatch(lines, /^\s*ip\s+lan1\s+address\s+(\d+\.\d+\.\d+\.\d+)/i) ??
          firstMatch(lines, /^\s*ip\s+lan\d+\s+address\s+(\d+\.\d+\.\d+\.\d+)/i) ??
          "",
        confidence: 0.9,
      };
    },
  },
  // ----- Arista EOS -----
  {
    name: "arista-eos",
    detect: (lines) => {
      const hasEos = lines.some((l) => /\bEOS[-\s]/i.test(l));
      const hasArista = lines.some((l) => /Arista/i.test(l));
      if (!hasEos && !hasArista) return null;
      const osVersion =
        firstMatch(lines, /version\s+EOS-([\d.]+)/i) ??
        firstMatch(lines, /EOS-([\d.]+)/i) ??
        "";
      const hostname =
        firstMatch(lines, /^\s*hostname\s+(\S+)/i) ?? "";
      return {
        vendor: "Arista",
        os: "EOS",
        osVersion,
        model: "",
        hostname,
        ipAddress: extractCiscoIp(lines),
        confidence: 0.7,
      };
    },
  },
  // ----- Mikrotik RouterOS -----
  {
    name: "mikrotik-routeros",
    detect: (lines) => {
      const hasRouteros = lines.some((l) => /RouterOS/i.test(l));
      const hasSystemIdentity = lines.some((l) =>
        /^\/system\s+identity/i.test(l),
      );
      if (!hasRouteros && !hasSystemIdentity) return null;
      const osVersion =
        firstMatch(lines, /RouterOS\s+v?([\d.]+)/i) ?? "";
      const hostname =
        firstMatch(lines, /set\s+name=["']?([^"'\s]+)/i) ?? "";
      return {
        vendor: "Mikrotik",
        os: "RouterOS",
        osVersion,
        model: "",
        hostname,
        // /ip address \n add address=X.X.X.X/X ...
        ipAddress:
          firstMatch(lines, /add\s+address=(\d+\.\d+\.\d+\.\d+)/i) ?? "",
        confidence: 0.7,
      };
    },
  },
  // ----- Cisco Meraki (Dashboard API ダンプ) -----
  // apps/bff/src/meraki.ts が Meraki Dashboard API から取得した結果を
  // テキストへシリアライズしたもの。先頭行の固定ヘッダ
  // `! Meraki Network Configuration Dump` で確実に識別できる。
  {
    name: "cisco-meraki",
    detect: (lines) => {
      const header = lines.find((l) =>
        /^!\s*Meraki Network Configuration Dump/i.test(l),
      );
      if (!header) return null;
      const nameLine = lines.find((l) =>
        /^!\s*Network:\s+(.+)\s+\(([^)]+)\)/i.test(l),
      );
      const hostname = nameLine
        ? (nameLine.match(/^!\s*Network:\s+(.+?)\s+\(([^)]+)\)/i)?.[1] ??
          "")
        : "";
      const productsLine = lines.find((l) =>
        /^!\s*Products:/i.test(l),
      );
      const products = productsLine
        ? (productsLine.match(/^!\s*Products:\s*(.+)$/i)?.[1] ?? "").trim()
        : "";
      // device 行から管理 IP を拾う。lanIp (プライベート IP) を優先し、
      // 無ければ publicIp (WAN IP) にフォールバックする。
      const lanIpLine = lines.find((l) =>
        /^device\s+.*lanIp=(\d+\.\d+\.\d+\.\d+)/i.test(l),
      );
      const publicIpLine = lines.find((l) =>
        /^device\s+.*publicIp=(\d+\.\d+\.\d+\.\d+)/i.test(l),
      );
      const ipAddress = lanIpLine
        ? (lanIpLine.match(/lanIp=(\d+\.\d+\.\d+\.\d+)/i)?.[1] ?? "")
        : publicIpLine
          ? (publicIpLine.match(/publicIp=(\d+\.\d+\.\d+\.\d+)/i)?.[1] ?? "")
          : "";
      return {
        vendor: "Cisco Meraki",
        // 製品タイプも OS 欄に含めておく（MX+MS+MR 等）。
        os: products ? `Meraki (${products})` : "Meraki",
        osVersion: "",
        // ダンプに単一の機種は無い（ネットワーク全体）ので model は空。
        model: "",
        hostname,
        ipAddress,
        confidence: 0.95,
      };
    },
  },
];

/** Detect vendor/OS/model from a raw config body. Returns EMPTY_DETECTION
 *  (confidence 0) if nothing matches. */
export function detectDeviceInfo(body: string): DeviceDetection {
  if (!body || body.trim().length === 0) return EMPTY_DETECTION;
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  for (const rule of rules) {
    try {
      const r = rule.detect(lines);
      if (r && r.confidence > 0) return r;
    } catch {
      // A buggy rule must never break the upload flow.
    }
  }
  return EMPTY_DETECTION;
}
