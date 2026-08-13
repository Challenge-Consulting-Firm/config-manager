/**
 * Shared domain types used by both the BFF and the React frontend.
 */

import type { HelperOsHint, HelperProtocol } from "./helper.js";

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
  | "edit"
  /** 顧客情報アプリの機器認証情報を参照した（候補一覧・トークン発行・redeem）。 */
  | "credential";

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

/** Application RBAC role. Higher privilege includes lower ones. */
export type AppRole = "viewer" | "operator" | "admin";

/** Japanese labels for AppRole (UI / docs). */
export const APP_ROLE_LABELS: Record<AppRole, string> = {
  viewer: "閲覧者",
  operator: "作業者",
  admin: "管理者",
};

/** Numeric rank for comparing roles (admin > operator > viewer). */
export const APP_ROLE_RANK: Record<AppRole, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

/** True when `actual` is at least as privileged as `required`. */
export function hasMinRole(actual: AppRole, required: AppRole): boolean {
  return APP_ROLE_RANK[actual] >= APP_ROLE_RANK[required];
}

/** Shape of the authenticated user surfaced to the frontend. */
export interface AuthUser {
  displayName: string;
  email: string;
  tenantId?: string;
  objectId?: string;
  /** App-level RBAC role resolved at login (default admin when role groups unset). */
  role: AppRole;
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

// ===== Wireless (SSID / access point) =====

/** A wireless SSID extracted from a Meraki dump (`/wireless/ssids`).
 *  This is a "static point" snapshot of the SSID configuration, mapped to a
 *  common shape so it can be listed, exported and diffed like FW/routing. */
export interface WirelessSsid {
  /** Source vendor (currently always "Cisco Meraki"). */
  vendor: string;
  /** SSID slot number (0-14 for Meraki). */
  number: number;
  /** SSID name. */
  name: string;
  /** Whether the SSID is enabled/broadcasting. */
  enabled: boolean;
  /** Authentication mode: "open", "psk", "8021x-radius", etc. */
  authMode: string;
  /** Encryption mode when applicable ("wpa", "wpa-eap", ...). Empty if none. */
  encryptionMode: string;
  /** WPA encryption mode ("WPA2 only", "WPA3 Transition Mode", ...). Empty if n/a. */
  wpaEncryptionMode: string;
  /** IP assignment mode ("NAT mode", "Bridge mode", "Layer 3 roaming", ...). */
  ipAssignmentMode: string;
  /** VLAN tag when the SSID is bridged/tagged. Undefined when not applicable. */
  vlanId?: number;
  /** Whether VLAN tagging is used. */
  useVlanTagging: boolean;
  /** Band selection ("Dual band operation", "5 GHz band only", ...). Empty if default. */
  bandSelection: string;
  /** Per-client bandwidth limit down (Kbps, 0 = unlimited). */
  perClientBandwidthLimitDown?: number;
  /** Per-client bandwidth limit up (Kbps, 0 = unlimited). */
  perClientBandwidthLimitUp?: number;
  /** Whether the SSID is visible (advertised) vs hidden. */
  visible: boolean;
  /** RADIUS server hosts (host:port), joined for display. Empty if none. */
  radiusServers: string;
  /** Splash page type ("None", "Click-through splash page", ...). Empty if none. */
  splashPage: string;
  /** Additional attributes for display (free-form). */
  attributes?: string;
  /** Original raw JSON of this SSID entry. */
  raw: string;
}

/** A wireless access point (MR device) extracted from a Meraki dump's
 *  Devices block. Snapshot of the physical AP inventory. */
export interface WirelessAccessPoint {
  /** Source vendor (currently always "Cisco Meraki"). */
  vendor: string;
  /** Device name. */
  name: string;
  /** Model (e.g. "MR33"). */
  model: string;
  /** Serial number (stable identity across generations). */
  serial: string;
  /** MAC address. */
  mac: string;
  /** Firmware version string. */
  firmware: string;
  /** LAN-side (private) IP when known. */
  lanIp: string;
  /** Public / WAN-side IP when known. */
  publicIp: string;
  /** Original raw device line / info. */
  raw: string;
}

// ===== Wireless diff =====

export interface WirelessSsidChange {
  before: WirelessSsid;
  after: WirelessSsid;
}

export interface WirelessAccessPointChange {
  before: WirelessAccessPoint;
  after: WirelessAccessPoint;
}

/** Structural diff between two generations' wireless SSID + AP snapshots. */
export interface WirelessDiff {
  ssids: {
    added: WirelessSsid[];
    removed: WirelessSsid[];
    changed: WirelessSsidChange[];
    unchanged: number;
  };
  accessPoints: {
    added: WirelessAccessPoint[];
    removed: WirelessAccessPoint[];
    changed: WirelessAccessPointChange[];
    unchanged: number;
  };
}

// ===== VLAN configuration =====

/** A VLAN definition extracted from a switch config. Vendor-neutral: Cisco
 *  IOS (`vlan N` / `name`), YAMAHA SWX (`vlan database` / `vlan N name`),
 *  and ELECOM (`vlan N` / `vlan A-B`) all map to this shape. */
export interface VlanDefinition {
  /** Source vendor (informational). */
  vendor: string;
  /** VLAN ID (1-4094). */
  id: number;
  /** VLAN name/label when declared. Empty when the config only lists the ID. */
  name: string;
  /** Access ports assigned to this VLAN (untagged members). */
  accessPorts: string[];
  /** Trunk ports that carry this VLAN tagged. */
  taggedPorts: string[];
  /** Ports for which this VLAN is the native/untagged VLAN on a trunk. */
  nativePorts: string[];
  /** Additional attributes for display (free-form). */
  attributes?: string;
}

/** A physical switch port and its VLAN membership, extracted from an
 *  `interface <port>` block. Vendor-neutral. */
export interface VlanPort {
  /** Source vendor (informational). */
  vendor: string;
  /** Interface / port name (e.g. "port1.3", "xgi2", "GigabitEthernet0/1"). */
  name: string;
  /** switchport mode: "access", "trunk", or "" when not declared. */
  mode: string;
  /** Access VLAN ID when the port is in access mode. Undefined otherwise. */
  accessVlan?: number;
  /** Native (untagged) VLAN ID on a trunk. Undefined when not set. */
  nativeVlan?: number;
  /** Tagged VLAN IDs allowed on a trunk. */
  allowedVlans: number[];
  /** Port description when present. */
  description: string;
  /** 1-based source line of the interface block. */
  line: number;
}

/** The parsed VLAN extraction result (definitions + ports together). */
export interface VlanExtraction {
  vlans: VlanDefinition[];
  ports: VlanPort[];
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

// ===== 機器認証情報（顧客情報アプリ）=====
// 社内の Kintone「ノード管理」アプリに登録済みのアカウント名 / パスワードを
// ローカル取得ヘルパーのログインへ適用するための型。設計は Issue #53 を参照。
//
// 重要: パスワードはこの型に一切載せない。SPA へ渡すのは候補のメタ情報と
// 一回限りのトークンだけで、平文はヘルパーが BFF から redeem して受け取る。

/** 候補レコードのうち、不可視文字の混入を検出しうるフィールド。 */
export type NodeCredentialField =
  | "nodeName"
  | "ipAddress"
  | "accountName"
  | "password";

/**
 * `備考` の自由記述から推定した接続ヒント。**初期値の提案にのみ使う**。
 * 推定は当たらないことがあるため UI で上書きでき、永続化もしない。
 */
export interface NodeCredentialHint {
  /** 推定プロトコル。判断材料が無ければ null（Telnet へは倒さない）。 */
  protocol: HelperProtocol | null;
  /** 推定機種。判断材料が無ければ null。 */
  osHint: HelperOsHint | null;
  /** UI に表示する推定根拠（例: `備考に「SSH接続」`）。 */
  reason: string;
}

/**
 * 取得ダイアログに提示する認証情報の候補。
 *
 * 検索は IP アドレスの正規化後の完全一致で行い、同一 IP が複数顧客に存在
 * しうるため候補が 1 件でも自動選択はしない。`customerName` と `nodeName`
 * を利用者に見せて選ばせる前提の型。
 */
export interface NodeCredentialCandidate {
  /** Kintone レコード ID。トークン発行時に指定する。 */
  id: string;
  /** 顧客名（`1004 野原ホールディングス` 形式）。 */
  customerName: string;
  /** 機器名。Kintone 上のフィールド名は `名前`。 */
  nodeName: string;
  /** IP アドレス（照合用に正規化済み）。 */
  ipAddress: string;
  /** ログインアカウント名（照合用に正規化済み）。 */
  accountName: string;
  /** システム種別の詳細区分（`Router` / `L2 Switch` など）。 */
  systemType: string;
  /** 備考の自由記述。機種や接続方法の手掛かりが書かれていることが多い。 */
  note: string;
  /** 対象機器の `customer` と一致したか。並び順と UI の強調に使う。 */
  matchesCustomer: boolean;
  /** 対象機器の `hostname` と一致したか。 */
  matchesHostname: boolean;
  /**
   * 元レコードに不可視文字（`U+200B` 等）が混入しているフィールド。
   * パスワードが含まれる場合は、そのまま使うか除去するかを利用者に選ばせる。
   */
  invisibleCharFields: NodeCredentialField[];
  /** 備考から推定した接続ヒント。 */
  hint: NodeCredentialHint;
}

/** `GET /api/node-credentials` の応答。 */
export interface NodeCredentialListResponse {
  /** 顧客情報アプリが env で有効化されているか。false なら候補は空。 */
  enabled: boolean;
  candidates: NodeCredentialCandidate[];
}

/** `POST /api/node-credentials/:id/issue-token` の要求本体。 */
export interface NodeCredentialTokenRequest {
  /** 対象機器の識別子。発行するトークンをこの機器に束縛する。 */
  customer: string;
  hostname: string;
  ipAddress: string;
  /**
   * パスワードに含まれる不可視文字を除去してから機器へ送るか。
   * 既定は false（Kintone に入っている値をそのまま使う）。
   */
  stripInvisible?: boolean;
}

/** `POST /api/node-credentials/:id/issue-token` の応答。 */
export interface NodeCredentialTokenResponse {
  /** 一回限り・短命の不透明トークン。ヘルパーへ渡す。 */
  token: string;
  /** 有効期限（ミリ秒）。 */
  expiresInMs: number;
  /** ログインアカウント名。機密ではないので UI 表示に使ってよい。 */
  username: string;
}

/**
 * `POST /helper/credentials/redeem` の応答（ヘルパーが受け取る）。
 *
 * このエンドポイントは `/api/*` の外に置かれ、セッション Cookie を要求しない。
 * トークン自体が唯一の資格情報であり、単回・短命であることで保護する。
 */
export interface NodeCredentialRedeemResponse {
  username: string;
  password: string;
  /** Cisco 機器の特権モードパスワード。app 55 には専用欄が無いため通常は空。 */
  enablePassword?: string;
}
