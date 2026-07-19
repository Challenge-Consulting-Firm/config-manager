/**
 * Meraki Dashboard API 関連の共有ロジック・型定義。
 *
 * 設計思想:
 *  - Meraki MR/MX/MS の設定を Dashboard API から取得し、1 つの可読テキスト
 *    （show run 相当のダンプ）へシリアライズする。これにより既存の世代管理
 *    （normalizeConfig → createVersion → Diff）にそのまま乗せられる。
 *  - Meraki は「コンフィグファイル」を持たず、すべてクラウド上の JSON で
 *    設定を保持する。本システムでは JSON をそのまま保存するのではなく、各
 *    セクションごとに「! ===== セクション名 =====」コメントヘッダ + JSON
 *    本体へ整形する。コメント行は normalize で除去されるため、SHA-256 の
 *    安定化と人間の目視確認を両立できる。
 *  - Meraki 固有のメタ情報（networkId, productTypes, エンドポイント毎の
 *    取得成否）はメタデータブロックとして先頭に付与し、UI 側や audit から
 *    追跡できるようにする。
 */

/** Meraki Dashboard API のベース URL。
 *  中国など一部リージョンでは異なるが、通常は api.meraki.com。 */
export const MERAKI_API_BASE = "https://api.meraki.com/api/v1";

/** Meraki の製品タイプ（MR/MX/MS に対応）。
 *  Meraki API 上の productTypes 文字列に合わせる。 */
export type MerakiProductType = "appliance" | "switch" | "wireless";

/** Meraki ネットワークのメタ情報。 */
export interface MerakiNetworkInfo {
  id: string;
  name: string;
  organizationId: string;
  productTypes: MerakiProductType[];
  timeZone: string;
  tags: string[];
  notes: string;
  url?: string;
}

/** Meraki ネットワークに所属する端末のサマリ。 */
export interface MerakiDeviceInfo {
  name: string;
  model: string;
  serial: string;
  mac: string;
  productType: string;
  firmware: string;
  url?: string;
  /** インベントリ上の公開 IP (WAN 側) 。 */
  publicIp?: string;
  /** デバイスの LAN 側 IP (プライベート IP)。
   *  MX の場合は VLAN のデフォルトゲートウェイ IP。MS の場合は
   *  L3 インターフェースの IP。MR の場合は設定されている場合のみ。 */
  lanIp?: string;
  /** LAT/LONG（任意）。 */
  lat?: number;
  lng?: number;
  /** 各種ステータス文字列（任意）。 */
  status?: string;
  /** 生の JSON をそのまま残す（将来拡張用）。 */
  raw?: unknown;
}

/** Meraki セクション（取得した API エンドポイント毎の結果）。 */
export interface MerakiSection {
  /** セクション表示名。例: "Appliance / VLANs"。 */
  label: string;
  /** エンドポイントパス。例: "/networks/{id}/appliance/vlans"。 */
  endpoint: string;
  /** 製品タイプ。例: "appliance"。 */
  productType: MerakiProductType;
  /** 取得した JSON 本体（配列 or オブジェクト）。失敗時は undefined。 */
  data?: unknown;
  /** 取得失敗時のエラー理由。成功時は undefined。 */
  error?: string;
  /** 対象機器・ネットワーク構成上 "取る必要のない設定" としてスキップ
   *  されたか (HTTP 400 等)。UI ではエラーではなく情報として扱う。 */
  skipped?: boolean;
}

/** Meraki 設定ダンプの構造化表現。これをテキストへシリアライズする。 */
export interface MerakiConfigDump {
  /** 取得日時（ISO 8601）。 */
  exportedAt: string;
  /** ネットワーク情報。 */
  network: MerakiNetworkInfo;
  /** 所属デバイス一覧。 */
  devices: MerakiDeviceInfo[];
  /** 製品別に取得したセクション群。 */
  sections: MerakiSection[];
  /** コンフィグ生成に使った Meraki API のベース URL。 */
  apiBase: string;
}

/** 取得する製品タイプとエンドポイントの定義。
 *  Meraki ネットワークが appliance / switch / wireless のいずれを持つかは
 *  network.productTypes で決まるため、存在しない製品タイプのエンドポイント
 *  は呼び出さない。各エンドポイントは失敗（404/400 等）しても全体の取得は
 *  継続し、該当セクションは error 付きで記録される。 */
export const MERAKI_ENDPOINTS: Record<
  MerakiProductType,
  { label: string; endpoint: string }[]
> = {
  // ===== MX (Security Appliance) =====
  appliance: [
    { label: "Appliance / Single LAN", endpoint: "/networks/{id}/appliance/singleLan" },
    { label: "Appliance / VLANs", endpoint: "/networks/{id}/appliance/vlans" },
    { label: "Appliance / Ports", endpoint: "/networks/{id}/appliance/ports" },
    { label: "Appliance / Settings", endpoint: "/networks/{id}/appliance/settings" },
    { label: "Appliance / L3 Firewall Rules", endpoint: "/networks/{id}/appliance/firewall/l3FirewallRules" },
    { label: "Appliance / L7 Firewall Rules", endpoint: "/networks/{id}/appliance/firewall/l7FirewallRules" },
    { label: "Appliance / Cellular Firewall Rules", endpoint: "/networks/{id}/appliance/firewall/cellularFirewallRules" },
    { label: "Appliance / Firewalled Services", endpoint: "/networks/{id}/appliance/firewalledServices" },
    { label: "Appliance / Static Routes", endpoint: "/networks/{id}/appliance/staticRoutes" },
    { label: "Appliance / Port Forwarding Rules", endpoint: "/networks/{id}/appliance/portForwardingRules" },
    { label: "Appliance / 1:1 NAT Rules", endpoint: "/networks/{id}/appliance/oneToOneNatRules" },
    { label: "Appliance / 1:Many NAT Rules", endpoint: "/networks/{id}/appliance/oneToManyNatRules" },
    { label: "Appliance / Site-to-site VPN", endpoint: "/networks/{id}/appliance/vpn/siteToSiteVpn" },
    { label: "Appliance / VPN Traffic Shaping", endpoint: "/networks/{id}/appliance/trafficShaping" },
    { label: "Appliance / Traffic Shaping Rules", endpoint: "/networks/{id}/appliance/trafficShaping/rules" },
    { label: "Appliance / Uplinks Configuration", endpoint: "/networks/{id}/appliance/uplinks/configure" },
    { label: "Appliance / SSIDs", endpoint: "/networks/{id}/appliance/ssids" },
    { label: "Appliance / Content Filtering", endpoint: "/networks/{id}/appliance/contentFiltering" },
    { label: "Appliance / Intrusion Settings", endpoint: "/networks/{id}/appliance/intrusion" },
    { label: "Appliance / Malware Settings", endpoint: "/networks/{id}/appliance/malware" },
    // BGP は VPN 配下 (/appliance/vpn/bgp)。旧 /appliance/routing/bgp と
    // /appliance/routing/ospf は MX に存在せず常に 404 を返していたため、
    // OSPF は削除し BGP のみ正しいパスへ修正した。routed モード無効時は 400
    // (skipped) になる。
    { label: "Appliance / BGP", endpoint: "/networks/{id}/appliance/vpn/bgp" },
  ],
  // ===== MS (Switch) =====
  switch: [
    { label: "Switch / Ports", endpoint: "/networks/{id}/switch/ports" },
    { label: "Switch / Routing Interfaces", endpoint: "/networks/{id}/switch/routing/interfaces" },
    { label: "Switch / Routing Static Routes", endpoint: "/networks/{id}/switch/routing/staticRoutes" },
    { label: "Switch / Routing OSPF", endpoint: "/networks/{id}/switch/routing/ospf" },
    { label: "Switch / Routing Multicast", endpoint: "/networks/{id}/switch/routing/multicast" },
    { label: "Switch / Access Policies", endpoint: "/networks/{id}/switch/accessPolicies" },
    { label: "Switch / STP", endpoint: "/networks/{id}/switch/stp" },
    { label: "Switch / Storm Control", endpoint: "/networks/{id}/switch/stormControl" },
    { label: "Switch / DHCP Servers", endpoint: "/networks/{id}/switch/dhcpServers" },
    { label: "Switch / DHCP Server Policy", endpoint: "/networks/{id}/switch/dhcpServerPolicy" },
    { label: "Switch / Link Aggregations", endpoint: "/networks/{id}/switch/linkAggregations" },
    { label: "Switch / Stacks", endpoint: "/networks/{id}/switch/stacks" },
    { label: "Switch / QoS Rules", endpoint: "/networks/{id}/switch/qosRules" },
    { label: "Switch / DSCP to CoS", endpoint: "/networks/{id}/switch/dscpToCosMappings" },
    { label: "Switch / MTU", endpoint: "/networks/{id}/switch/mtu" },
    { label: "Switch / Multicast", endpoint: "/networks/{id}/switch/multicast" },
    { label: "Switch / Port Schedules", endpoint: "/networks/{id}/switch/portSchedules" },
    { label: "Switch / Settings", endpoint: "/networks/{id}/switch/settings" },
    { label: "Switch / Warm Spare", endpoint: "/networks/{id}/switch/warmSpare" },
    { label: "Switch / ACLs", endpoint: "/networks/{id}/switch/accessControlLists" },
    { label: "Switch / Alternate Management Interface", endpoint: "/networks/{id}/switch/alternateManagementInterface" },
  ],
  // ===== MR (Wireless) =====
  wireless: [
    { label: "Wireless / SSIDs", endpoint: "/networks/{id}/wireless/ssids" },
    { label: "Wireless / Settings", endpoint: "/networks/{id}/wireless/settings" },
    { label: "Wireless / RF Profiles", endpoint: "/networks/{id}/wireless/rfProfiles" },
    // ※ Air Marshal (/wireless/airMarshal) は取得しない。これは「設定」ではなく
    //   周辺で検知した不正 AP のスキャン結果（bssid/rssi/firstSeen/lastSeen を
    //   持つ運用時系列データ）で、数 MB・数十万行に膨れ上がり、取得の度に内容が
    //   変わるため毎回新世代が作られる。コンフィグ世代管理の対象外。
    { label: "Wireless / Bluetooth", endpoint: "/networks/{id}/wireless/bluetooth/settings" },
    { label: "Wireless / Bonjour Forwarding", endpoint: "/networks/{id}/wireless/bonjourForwarding" },
    { label: "Wireless / Splash Settings", endpoint: "/networks/{id}/wireless/splash/settings" },
    { label: "Wireless / Billing", endpoint: "/networks/{id}/wireless/billing" },
    { label: "Wireless / Syslog", endpoint: "/networks/{id}/wireless/syslog" },
    { label: "Wireless / SNMP", endpoint: "/networks/{id}/wireless/snmp" },
    { label: "Wireless / Traffic Shaping", endpoint: "/networks/{id}/wireless/trafficShaping" },
    // ※ L3/L7 Firewall Rules は /wireless/ssids/{number}/l3FirewallRules のように
    //   SSID 番号を指定する必要があり、/wireless/ssids の一覧応答に各 SSID の
    //   FW ルールが含まれるため個別取得は不要。当初の実装はパスを誤って
    //   "SSID number must be an integer" の 400 になっていた。
    { label: "Wireless / Identity PSKs", endpoint: "/networks/{id}/wireless/identityPsks" },
  ],
};

/** Meraki ダンプの先頭に付く固定ヘッダ。detect.ts がこの文字列から
 *  vendor="Cisco Meraki" を識別する。normalize でコメント行として除去
 *  されるため、ハッシュの安定性を損なわない。 */
export const MERAKI_DUMP_HEADER = "! Meraki Network Configuration Dump";

/** {@link serializeMerakiConfig} のオプション。省略時は従来どおりネットワーク
 *  全体を1テキストへ出力する（後方互換）。 デバイス単位レコード分割時は
 *  `productType` でその製品のセクションのみに絞り込み、`focusDevice` で
 *  ヘッダにデバイス強調行を追加する。 */
export interface SerializeMerakiConfigOptions {
  /** 出力対象にする製品タイプ。指定時はその productType に属するセクション
   *  のみを出力し、他製品のセクションは取り込まない。省略時は全 productType
   *  を出力（従来挙動）。Meraki の設定はネットワーク単位で保持されるため、
   *  デバイス単位レコードを作る場合は「そのデバイスの製品に属する設定」を
   *  代表値として採用する。 */
  productType?: MerakiProductType;
  /** ヘッダに強調表示するデバイス。デバイス単位レコード生成時に指定すると、
   *  `! Focus Device:` 行を追加して哪个のデバイスへ向けたダンプかを明示する。
   *  また Devices ブロックの先頭へ対象デバイスを移動する。 */
  focusDevice?: MerakiDeviceInfo;
}

/**
 * {@link MerakiConfigDump} を show-run 相当のテキストへシリアライズする。
 *
 * 出力形式:
 * ```
 * ! Meraki Network Configuration Dump
 * ! Network: <name> (<id>)
 * ! Organization: <orgId>
 * ! Products: appliance, switch, wireless
 * ! Focus Device: serial=<serial> model=<model> name=<name> product=<pt>
 * ! Exported: <ISO8601>
 * !
 * ! ===== Devices =====
 * device serial=<serial> model=<model> name=<name> firmware=<fw>
 * ...
 * !
 * ! ===== <section.label> =====
 * ! endpoint: <endpoint>
 * <pretty JSON>
 * ```
 *
 * `!` で始まる行は normalize で除去されるため、JSON 本体のみが SHA-256 計算
 * 対象となる。JSON は `JSON.stringify(value, null, 2)` で整形するため、同一
 * 設定なら常に同一テキストが得られる（key 順序は Meraki API 応答に依存する
 * ため、実運用上は API 側の安定性に依存する）。
 *
 * `options.productType` 指定時は、その製品のセクションのみを出力する
 * （デバイス単位レコード向け）。省略時は全製品のセクションを出力する
 * （従来挙動、ネットワーク単位レコード向け）。
 */
export function serializeMerakiConfig(
  dump: MerakiConfigDump,
  options?: SerializeMerakiConfigOptions,
): string {
  const lines: string[] = [];
  const focusDevice = options?.focusDevice;
  const productType = options?.productType;
  lines.push(MERAKI_DUMP_HEADER);
  lines.push(`! Network: ${dump.network.name} (${dump.network.id})`);
  lines.push(`! Organization: ${dump.network.organizationId}`);
  lines.push(
    `! Products: ${dump.network.productTypes.join(", ") || "(none)"}`,
  );
  if (dump.network.timeZone) {
    lines.push(`! Timezone: ${dump.network.timeZone}`);
  }
  if (dump.network.tags.length > 0) {
    lines.push(`! Tags: ${dump.network.tags.join(" ")}`);
  }
  if (dump.network.notes) {
    // 複数行にならないよう最初の行だけ採録。
    const first = dump.network.notes.split(/\r?\n/)[0];
    lines.push(`! Notes: ${first}`);
  }
  if (focusDevice) {
    // デバイス単位レコード向けに、対象デバイスをヘッダへ強調表示する。
    // 正規化で除去されるコメント行のため、ハッシュ計算へは影響しない。
    const parts = [
      `serial=${focusDevice.serial || "-"}`,
      `model=${focusDevice.model || "-"}`,
      `name=${focusDevice.name || "-"}`,
    ];
    if (focusDevice.productType) {
      parts.push(`product=${focusDevice.productType}`);
    }
    if (focusDevice.mac) parts.push(`mac=${focusDevice.mac}`);
    if (focusDevice.lanIp) parts.push(`lanIp=${focusDevice.lanIp}`);
    if (focusDevice.publicIp) parts.push(`publicIp=${focusDevice.publicIp}`);
    lines.push(`! Focus Device: ${parts.join(" ")}`);
  }
  lines.push(`! Exported: ${dump.exportedAt}`);
  lines.push(`! API Base: ${dump.apiBase}`);
  lines.push("!");

  // ----- Devices -----
  // focusDevice 指定時は、対象デバイスを一覧の先頭へ移動して目視性を上げる。
  const orderedDevices = focusDevice
    ? [focusDevice, ...dump.devices.filter((d) => d !== focusDevice)]
    : dump.devices;
  if (orderedDevices.length > 0) {
    lines.push("! ===== Devices =====");
    for (const d of orderedDevices) {
      const parts = [
        `serial=${d.serial || "-"}`,
        `model=${d.model || "-"}`,
        `name=${d.name || "-"}`,
      ];
      if (d.productType) parts.push(`product=${d.productType}`);
      if (d.mac) parts.push(`mac=${d.mac}`);
      if (d.firmware) parts.push(`firmware=${d.firmware}`);
      if (d.lanIp) parts.push(`lanIp=${d.lanIp}`);
      if (d.publicIp) parts.push(`publicIp=${d.publicIp}`);
      lines.push(`device ${parts.join(" ")}`);
    }
    lines.push("!");
  }

  // ----- Sections (per product type) -----
  // 出力順序を固定するため productTypes の順 → endpoint 定義順に並べる。
  // productType 指定時はその製品のセクションのみ残す（デバイス単位レコード）。
  const productFilter = productType;
  const ordered: MerakiSection[] = [];
  const candidateTypes = productFilter
    ? [productFilter]
    : dump.network.productTypes;
  for (const pt of candidateTypes) {
    for (const s of dump.sections.filter((x) => x.productType === pt)) {
      ordered.push(s);
    }
  }
  // productType 指定時は他製品のセクションを混入させない（従来は安全策として
  // ネットワーク productTypes に無いセクションも並べていたが、デバイス単位
  // 出力ではノイズになるため除外する）。
  if (!productFilter) {
    for (const s of dump.sections) {
      if (!dump.network.productTypes.includes(s.productType)) ordered.push(s);
    }
  }

  for (const s of ordered) {
    lines.push(`! ===== ${s.label} =====`);
    lines.push(`! endpoint: ${s.endpoint}`);
    if (s.error) {
      lines.push(`! ERROR: ${s.error}`);
      lines.push("!");
      continue;
    }
    if (s.data === undefined || s.data === null) {
      lines.push("! (empty)");
    } else if (Array.isArray(s.data) && s.data.length === 0) {
      lines.push("! (empty array)");
    } else {
      lines.push(JSON.stringify(s.data, null, 2));
    }
    lines.push("!");
  }

  return lines.join("\n");
}

/** 取得した Meraki ダンプから、FW/ルーティング相当の構成を簡易サマライズ
 *  する。BFF のレスポンス（import 結果表示）や audit 詳細で使う。
 *  あくまで「何を取得したか」の目安であり、抽出ロジック本体は含まない。 */
export interface MerakiImportSummary {
  deviceCount: number;
  /** 製品タイプ毎のセクション数。 */
  sectionsByProduct: Record<MerakiProductType, number>;
  /** 機器仕様上スキップされたエンドポイント数 (HTTP 400 等)。
   *  対象ネットワークでその機能が使われていないだけであり、エラーではない。 */
  skippedSections: number;
  /** スキップされたエンドポイントの (ラベル, 理由) リスト。最大 20 件。 */
  skipped: { label: string; error: string }[];
  /** 取得に実際に失敗したエンドポイント数 (401/403/429/500 等)。 */
  failedSections: number;
  /** 失敗したエンドポイントの (ラベル, 理由) リスト。最大 20 件。 */
  failures: { label: string; error: string }[];
}

/** {@link MerakiConfigDump} からインポート結果サマリを生成する。 */
export function summarizeMerakiImport(
  dump: MerakiConfigDump,
): MerakiImportSummary {
  const sectionsByProduct: Record<MerakiProductType, number> = {
    appliance: 0,
    switch: 0,
    wireless: 0,
  };
  let skippedSections = 0;
  const skipped: { label: string; error: string }[] = [];
  let failedSections = 0;
  const failures: { label: string; error: string }[] = [];
  for (const s of dump.sections) {
    sectionsByProduct[s.productType]++;
    if (!s.error) continue;
    if (s.skipped) {
      skippedSections++;
      if (skipped.length < 20) {
        skipped.push({ label: s.label, error: s.error });
      }
    } else {
      failedSections++;
      if (failures.length < 20) {
        failures.push({ label: s.label, error: s.error });
      }
    }
  }
  return {
    deviceCount: dump.devices.length,
    sectionsByProduct,
    skippedSections,
    skipped,
    failedSections,
    failures,
  };
}
