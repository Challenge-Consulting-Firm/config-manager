/**
 * Shared domain types used by both the BFF and the React frontend.
 */

/** Role tag distinguishing production devices from spare (cold-standby)
 *  devices. Spares are swapped in to replace a failed production device. */
export type Role = "production" | "spare";

/** Japanese labels shown in the UI and stored as the Kintone dropdown value. */
export const ROLE_LABELS: Record<Role, string> = {
  production: "本番",
  spare: "予備",
};

import type { DeviceDetection } from "./detect.js";

/** A normalized routing entry extracted from a device config.
 *  Vendor-specific syntax (Cisco ip route, Juniper routing-options static,
 *  Fortinet router static, YAMAHA ip route) is mapped to this common shape.
 *
 *  Both static routes and summarized dynamic-protocol info (OSPF/BGP
 *  areas, AS numbers, networks) are represented here. */
export interface RoutingRoute {
  /** Source vendor that produced this rule (informational). */
  vendor: string;
  /** Protocol: "static", "connected", "ospf", "bgp", "rip", "eigrp". */
  protocol: string;
  /** Destination network in CIDR notation (e.g. "10.0.0.0/24").
   *  For summary entries without a single network, the raw target. */
  network: string;
  /** Next-hop IP, interface name, or "Null0" / "discard". */
  nextHop: string;
  /** Administrative distance (Cisco-style). Empty when not specified. */
  adminDistance?: number;
  /** Route metric. Empty when not specified. */
  metric?: number;
  /** Outgoing interface when specified directly. */
  interface?: string;
  /** Additional attributes: OSPF area, BGP AS, route tag, etc. */
  attributes?: string;
  /** 1-based source line number, for reference. */
  line: number;
  /** Original raw line text. */
  raw: string;
}

/** A normalized firewall/ACL rule extracted from a device config.
 *  Vendor-specific syntax (Cisco ACL, Juniper filter, Fortinet policy,
 *  YAMAHA ip filter) is mapped to this common shape. */
export interface FirewallRule {
  /** Source vendor that produced this rule (informational). */
  vendor: string;
  /** ACL / filter / policy id the rule belongs to. */
  name: string;
  /** Optional human-friendly policy name (FortiGate `set name`, etc.). */
  displayName?: string;
  /** Rule category. FortiGate NAT / DoS policies are shown separately. */
  category?: "policy" | "nat" | "dos";
  /** Permit/accept or deny/reject. */
  action: "permit" | "deny";
  /** Whether the policy is enabled. Undefined means the vendor syntax does not expose status. */
  enabled?: boolean;
  /** Protocol: tcp, udp, icmp, ip (=any), internet-service, dos, etc. */
  protocol: string;
  /** Source address spec: "any", "1.2.3.4", "10.0.0.0/24", or an
   *  object-group / address-book name in quotes. */
  source: string;
  /** Destination address spec (same shape as source). */
  destination: string;
  /** Destination port(s): "80", "80,443", "1024-65535", service name, or "any". */
  port: string;
  /** Individual source address objects, when a single policy references
   *  multiple (FortiGate `set srcaddr "a" "b"`). Used by the expansion view
   *  to break a policy into srcaddr × dstaddr × service combinations.
   *  Undefined for vendors/lines that carry a single value. */
  sourceItems?: string[];
  /** Individual destination address objects (same shape as sourceItems). */
  destinationItems?: string[];
  /** Individual service objects (same shape as sourceItems). */
  serviceItems?: string[];
  /** Optional NAT metadata for FortiGate NAT policies. */
  nat?: {
    enabled: boolean;
    ippool?: boolean;
    poolName?: string;
  };
  /** Optional memo/comment from the config. */
  comments?: string;
  /** Additional vendor-specific attributes, e.g. DoS anomalies. */
  attributes?: string;
  /** 1-based source line number, for reference. */
  line: number;
  /** Original raw line text. */
  raw: string;
}

/** Rule category value (FortiGate policy / NAT / DoS). Extracted as a named
 *  type so call sites don't need `NonNullable<FirewallRule["category"]>`. */
export type FirewallRuleCategory = "policy" | "nat" | "dos";

/** A single srcaddr × dstaddr × service combination produced by expanding
 *  one {@link FirewallRule}. The rule is referenced by pointer so callers can
 *  reach shared metadata (policy id, status, line number, ...). */
export interface ExpandedFirewallCombination {
  rule: FirewallRule;
  source: string;
  destination: string;
  service: string;
}

/** Identifier fields attached to every config generation. */
export interface DeviceIdentifiers {
  /** Customer / tenant name. */
  customer: string;
  /** Device hostname. */
  hostname: string;
  /** Management IP address (or subnet) of the device. */
  ipAddress: string;
  /** Free-form purpose / role, e.g. "edge-router", "core-switch". */
  purpose: string;
  /** Hardware serial number of the physical device. Per-version so that
   *  hardware swaps (e.g. spare promoted to production) are trackable. */
  serialNumber: string;
  /** 本番 / 予備 tag. Production and spare are distinct devices. */
  role: Role;
}

/** A single generation (revision) of a device config. */
export interface ConfigVersion {
  /** Kintone record id. */
  id: string;
  /** Revision number assigned within the (customer, hostname, role) series. */
  generation: number;
  /** Normalized config body (comments / blank lines removed). */
  body: string;
  /** SHA-256 hash of the normalized body, used for change detection. */
  hash: string;
  /** Display name of the operator who uploaded this revision. */
  operator: string;
  /** Operator email (from Entra ID), used as a stable key. */
  operatorEmail: string;
  /** Upload timestamp in milliseconds since epoch. */
  createdAt: number;
  /** Optional upload note. */
  note?: string;
  /** Size of the normalized body in bytes. */
  size: number;
  /** Line count of the normalized body. */
  lines: number;
  /** 本番 / 予備 tag of the owning device. */
  role: Role;
  /** Auto-detected vendor/OS/model from the config body (informational). */
  detected?: DeviceDetection;
}

/** A logical device groups all its config generations together.
 *  Production and spare are separate devices even if they share a hostname. */
export interface Device {
  id: string;
  identifiers: DeviceIdentifiers;
  latestGeneration: number;
  latestHash: string;
  /** Kintone record id of the latest generation (for diff deep-links). */
  latestVersionId: string;
  lastUpdatedAt: number;
  lastOperator: string;
  versionCount: number;
}

/** A diff result between two config generations. */
export interface ConfigDiff {
  before: { generation: number; hash: string };
  after: { generation: number; hash: string };
  /** Unified-diff formatted string. */
  patch: string;
  /** Per-line structured diff for rendering. */
  lines: DiffLine[];
  /** Aggregate counts. */
  stats: { added: number; removed: number; unchanged: number };
}

export interface DiffLine {
  type: "added" | "removed" | "unchanged" | "context";
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
}

/** Kinds of operations recorded in the audit log. */
export type AuditAction =
  | "upload"
  | "view"
  | "diff"
  | "download"
  | "delete"
  | "edit";

export interface AuditLogEntry {
  id: string;
  operator: string;
  operatorEmail: string;
  action: AuditAction;
  customer?: string;
  hostname?: string;
  generation?: number;
  detail?: string;
  createdAt: number;
}

/** Shape of the authenticated user surfaced to the frontend. */
export interface AuthUser {
  displayName: string;
  email: string;
  tenantId?: string;
  objectId?: string;
}

// ===== Full-text search =====

/** A single line-level match produced by the config full-text search.
 *  `before` / `after` carry one line of context when available. */
export interface ConfigSearchHit {
  versionId: string;
  generation: number;
  customer: string;
  hostname: string;
  ipAddress: string;
  role: Role;
  /** 1-based line number in the normalized body. */
  line: number;
  /** Matched line text. */
  text: string;
  /** One line of context before the match, when available. */
  before?: string;
  /** One line of context after the match, when available. */
  after?: string;
}

/** Aggregate result of a config full-text search. */
export interface ConfigSearchResult {
  query: string;
  isRegex: boolean;
  scope: "latest" | "all";
  hits: ConfigSearchHit[];
  /** Number of distinct devices scanned. */
  scannedDevices: number;
  /** Number of config versions scanned. */
  scannedVersions: number;
}

// ===== Firewall rule diff =====

/** A pair of rules that share the same logical signature but differ in
 *  metadata (status, comments, NAT, ...). Ordering-independent: the diff is
 *  computed by signature so re-ordered rules do not appear as changes. */
export interface FirewallRuleChange {
  before: FirewallRule;
  after: FirewallRule;
}

/** Structural diff between two generations' firewall rule sets. */
export interface FirewallRuleDiff {
  added: FirewallRule[];
  removed: FirewallRule[];
  changed: FirewallRuleChange[];
  /** Count of rules with identical signature and content in both sides. */
  unchanged: number;
}

// ===== Routing route diff =====

/** A pair of routes that share the same logical signature but differ in
 *  metadata (next-hop, admin distance, metric, ...). */
export interface RoutingRouteChange {
  before: RoutingRoute;
  after: RoutingRoute;
}

/** Structural diff between two generations' routing tables. */
export interface RoutingRouteDiff {
  added: RoutingRoute[];
  removed: RoutingRoute[];
  changed: RoutingRouteChange[];
  unchanged: number;
}

// ===== Meraki credentials =====

/** 登録済みの Meraki 接続情報（ネットワーク ID + API キーのセット）。
 *  Kintone の任意アプリ（nw_meraki_credentials）に保存され、Meraki 取得
 *  画面から選択して再利用できる。API キーは平文で保存されるため、取扱に
 *  ついては README の「Meraki 連携」を参照のこと。 */
export interface MerakiCredential {
  /** Kintone レコード ID。 */
  id: string;
  /** 一覧表示用の名前。 */
  label: string;
  /** Meraki ネットワーク ID（L_xxx / N_xxx）。 */
  networkId: string;
  /** Meraki API キー。レスポンスに含めるかは BFF 設定に委ねる。 */
  apiKey: string;
  /** デフォルト顧客名（任意）。取得画面で補完に使う。 */
  defaultCustomer?: string;
  /** デフォルトホスト名（任意）。 */
  defaultHostname?: string;
  /** 自由メモ。 */
  memo?: string;
  /** 最終更新日時 (ms)。 */
  updatedAt: number;
}
