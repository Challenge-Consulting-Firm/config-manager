/**
 * Meraki Dashboard API クライアント（読み取り系のみ）。
 *
 * ネットワーク ID と API キーを受け取り、MR/MX/MS の設定を取得して
 * {@link MerakiConfigDump} へまとめる。結果は `serializeMerakiConfig()` で
 * テキスト化し、既存の normalizeConfig → createVersion フローに流すことで、
 * 通常の手動アップロードと全く同じ世代管理・Diff・監査ログに乗せられる。
 *
 * 設計上の考慮:
 *  - 認証は `X-Cisco-Meraki-API-Key` ヘッダーのみ。OAuth/OIDC は扱わない。
 *  - 一部エンドポイントが 404/400 を返す（例: Single LAN モードで VLANs を
 *    叩いた場合、Switch 無しネットワークで /switch/* を叩いた場合）ことは
 *    通常運用で起こるため、個別の失敗は `MerakiSection.error` に記録して
 *    全体取得は継続する。ネットワーク自体が取れない場合は全体をエラーにする。
 *  - 429 (rate limit) は Meraki API で頻発する。簡易リトライを入れる。
 *  - BFF は Entra ID 認証済みセッションからのみ到達可能なため、API キーを
 *    ユーザー入力で受け取ってもサーバーログへ漏洩しないよう、エラー文言に
 *    伏せ込まない。
 */

import {
  MERAKI_API_BASE,
  MERAKI_ENDPOINTS,
  type MerakiConfigDump,
  type MerakiDeviceInfo,
  type MerakiNetworkInfo,
  type MerakiProductType,
  type MerakiSection,
} from "@config-manager/shared";

/** Meraki API の呼び出しオプション。 */
export interface MerakiFetchOptions {
  /** API キー（X-Cisco-Meraki-API-Key）。必須。 */
  apiKey: string;
  /** API ベース URL。省略時は既定の https://api.meraki.com/api/v1。 */
  apiBase?: string;
  /** 呼び出し每のタイムアウト (ms)。既定 30 秒。 */
  timeoutMs?: number;
  /** 429 受信時の最大リトライ回数。既定 3。 */
  maxRetries?: number;
  /** セクション取得の最大並列数。既定 5。Meraki は組織単位で概ね毎秒 10
   *  リクエストのレート制限があり、数十エンドポイントを一斉に叩くと 429 が
   *  多発してリトライごと雪崩れるため、並列度を絞って抑制する。 */
  sectionConcurrency?: number;
}

/** Meraki 全体の取得処理の結果。 */
export interface FetchMerakiResult {
  dump: MerakiConfigDump;
  /** Meraki API から受け取った HTTP ステータスコードの内訳（デバッグ用）。 */
  statuses: Record<string, number>;
}

/** ネットワーク ID の形式チェック。Meraki は `L_xxx`（VPN 含むネットワーク）
 *  または `N_xxx` の形式を取る。簡易チェックのみ。 */
export function isValidNetworkId(networkId: string): boolean {
  return /^[LNQ]_[0-9a-zA-Z]+$/.test(networkId.trim());
}

/** API キーの簡易バリデーション。Meraki のキーは 40 文字程度の hex 前提だが、
 *  形式は公式に保証されていないため、空文字列と前後空白のみ弾く。 */
export function isValidApiKey(apiKey: string): boolean {
  return apiKey.trim().length >= 16;
}

/** デバイスの productType を解決する。Meraki API の /devices 応答では
 *  productType は通常 'appliance' / 'switch' / 'wireless' 等の文字列だが、
 *  API バージョンや機種によっては欠損する場合がある。その場合は model
 *  接头辞 (MX/MR/MS) から推測してフォールバックする。推測也不能な場合は
 *  元の productType 文字列をそのまま返す（呼び出し側で MR/MX/MS 以外として扱う）。
 *
 *  このフォールバックは「ネットワーク内に MR/MX/MS デバイスが見つかりません」
 *  という誤エラーを回避するための安全策。Meraki の model 命名規則は安定している
 *  (MX67/MR33/MS120 等) ため、model 推測は実用上十分に信頼できる。 */
export function resolveMerakiProductType(
  productType: string,
  model: string,
): MerakiProductType | string {
  if (
    productType === "appliance" ||
    productType === "switch" ||
    productType === "wireless"
  ) {
    return productType;
  }
  // productType が欠損・未知の場合は model 接头辞から推測する。
  // MG (cellularGateway) / MV (camera) / MT (sensor) は MX/MR/MS と接头辞が
  // 異なるため誤判定は起きない。
  const m = model.toUpperCase();
  if (m.startsWith("MX")) return "appliance";
  if (m.startsWith("MR")) return "wireless";
  if (m.startsWith("MS")) return "switch";
  // 推測不能なら元の productType を返す（空文字含む）。
  return productType;
}

/** 単一エンドポイントを呼び出し、JSON を返す。404 は null を返して呼び出し
 *  側でスキップできるようにする。429 は指数バックオフでリトライ。 */
async function callMeraki<T>(
  path: string,
  opts: MerakiFetchOptions,
): Promise<{ status: number; data: T | null; error?: string }> {
  const base = (opts.apiBase ?? MERAKI_API_BASE).replace(/\/$/, "");
  const url = `${base}${path}`;
  const maxRetries = opts.maxRetries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "X-Cisco-Meraki-API-Key": opts.apiKey,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      if (res.status === 404) {
        return { status: 404, data: null };
      }
      if (res.status === 429) {
        // Retry-After ヘッダがあれば従う（最大 10 秒）。無ければ指数バックオフ。
        const retryAfter = Number.parseInt(res.headers.get("Retry-After") ?? "", 10);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 10_000)
          : Math.min(1000 * Math.pow(2, attempt), 10_000);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        return {
          status: 429,
          data: null,
          error: "Meraki API rate limit exceeded after retries",
        };
      }
      if (!res.ok) {
        // Meraki はエラー本文に { errors: [...] } を返すことが多い。
        let detail = text.slice(0, 200);
        try {
          const j = JSON.parse(text) as { errors?: string[] };
          if (Array.isArray(j.errors) && j.errors.length > 0) {
            detail = j.errors.slice(0, 3).join("; ").slice(0, 200);
          }
        } catch {
          // 本文が JSON でなければ生テキストを使う。
        }
        return { status: res.status, data: null, error: `HTTP ${res.status}: ${detail}` };
      }
      const data = text ? (JSON.parse(text) as T) : null;
      return { status: res.status, data };
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === "AbortError";
      const msg = isAbort
        ? `timeout after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      if (attempt < maxRetries && !isAbort) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      return { status: 0, data: null, error: msg };
    }
  }
  // 念のためのフォールバック（到達不可）。
  return { status: 0, data: null, error: "exhausted retries" };
}

/** 配列の各要素に対し非同期処理を最大 `concurrency` 並列で実行する簡易ワーカー
 *  プール。`Promise.all` で全件を一斉発火させると、Meraki のレート制限
 *  (組織単位で概ね毎秒 10 リクエスト) に容易に抵触し、429 のリトライが再び
 *  一斉に走って雪崩れる。並列度を絞ることでこれを防ぐ。返り値は入力配列の
 *  index に対応した順序を保つ。 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let next = 0;
  const runners = Array.from({ length: limit }, async () => {
    for (;;) {
      const current = next++;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

/** `/networks/{id}` と `/networks/{id}/devices` を取得し、{@link MerakiNetworkInfo}
 *  とデバイス一覧を組み立てる。ネットワーク自体が取れない場合は例外。 */
async function fetchNetworkAndDevices(
  networkId: string,
  opts: MerakiFetchOptions,
): Promise<{ network: MerakiNetworkInfo; devices: MerakiDeviceInfo[] }> {
  const net = await callMeraki<Record<string, unknown>>(
    `/networks/${networkId}`,
    opts,
  );
  if (net.error || !net.data) {
    throw new Error(
      `Meraki ネットワーク情報の取得に失敗しました: ${net.error ?? `HTTP ${net.status}`}`,
    );
  }
  const raw = net.data;
  const productTypes = Array.isArray(raw.productTypes)
    ? (raw.productTypes as string[]).filter((p): p is MerakiProductType =>
        p === "appliance" || p === "switch" || p === "wireless",
      )
    : [];
  if (productTypes.length === 0) {
    // cell/camera/sensor 等のみで NW 機器情報が取れない場合は早期終了の手がかり
    // になるよう例外にする（ユーザーに見えるエラー）。
    throw new Error(
      "このネットワークには appliance/switch/wireless のいずれも含まれていません（MR/MX/MS 以外のみの可能性があります）",
    );
  }
  const network: MerakiNetworkInfo = {
    id: String(raw.id ?? networkId),
    name: String(raw.name ?? ""),
    organizationId: String(raw.organizationId ?? ""),
    productTypes,
    timeZone: String(raw.timeZone ?? ""),
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
    notes: String(raw.notes ?? ""),
    url: typeof raw.url === "string" ? raw.url : undefined,
  };

  // デバイス一覧。失敗時は空配列で続行（設定取得の本筋ではないため）。
  const devRes = await callMeraki<Record<string, unknown>[]>(
    `/networks/${networkId}/devices`,
    opts,
  );
  const devices: MerakiDeviceInfo[] = [];
  if (Array.isArray(devRes.data)) {
    for (const d of devRes.data) {
      const modelStr = String(d.model ?? "");
      // productType は Meraki API 応答から取得するが、欠損する場合は model
      // 接头辞から推測して補完する（resolveMerakiProductType 参照）。
      const rawProductType = String(d.productType ?? "");
      const resolvedProductType = resolveMerakiProductType(rawProductType, modelStr);
      devices.push({
        name: String(d.name ?? ""),
        model: modelStr,
        serial: String(d.serial ?? ""),
        mac: String(d.mac ?? ""),
        productType:
          typeof resolvedProductType === "string" ? resolvedProductType : "",
        firmware: String(d.firmware ?? ""),
        url: typeof d.url === "string" ? d.url : undefined,
        // /devices 応答の lanIp は MX の場合はデフォルト VLAN のゲートウェイ IP。
        // MS の場合は L3 インターフェース IP。MR の場合は設定されている場合のみ。
        lanIp: typeof d.lanIp === "string" ? d.lanIp : undefined,
        publicIp: typeof d.publicIp === "string" ? d.publicIp : undefined,
        lat: typeof d.lat === "number" ? d.lat : undefined,
        lng: typeof d.lng === "number" ? d.lng : undefined,
        status: typeof d.status === "string" ? d.status : undefined,
        raw: d,
      });
    }
  }

  // MR (wireless) 等は /networks/{id}/devices 応答に lanIp を持たないことが
  // 多く、そのままだと「IP が取れないデバイス」として取り込みスキップされて
  // しまう。組織単位の device statuses は MR/MS/MX すべての実行時 IP
  // (lanIp / publicIp) を serial 単位で返すため、これで補完する。
  // networkIds[] で対象ネットワークのみに絞る。失敗時 (404/権限不足等) は
  // 無視して続行する（従来どおりの挙動へフォールバック）。
  if (network.organizationId) {
    const statusesRes = await callMeraki<
      Array<{
        serial?: string;
        lanIp?: string | null;
        publicIp?: string | null;
      }>
    >(
      `/organizations/${network.organizationId}/devices/statuses?networkIds[]=${encodeURIComponent(networkId)}`,
      opts,
    );
    if (Array.isArray(statusesRes.data)) {
      const lanIpBySerial = new Map<string, string>();
      const publicIpBySerial = new Map<string, string>();
      for (const s of statusesRes.data) {
        const serial = typeof s.serial === "string" ? s.serial : "";
        if (!serial) continue;
        if (typeof s.lanIp === "string" && s.lanIp) {
          lanIpBySerial.set(serial, s.lanIp);
        }
        if (typeof s.publicIp === "string" && s.publicIp) {
          publicIpBySerial.set(serial, s.publicIp);
        }
      }
      for (const d of devices) {
        if (!d.lanIp) {
          const lanIp = lanIpBySerial.get(d.serial);
          if (lanIp) d.lanIp = lanIp;
        }
        if (!d.publicIp) {
          const publicIp = publicIpBySerial.get(d.serial);
          if (publicIp) d.publicIp = publicIp;
        }
      }
    }
  }

  // MX (appliance) が実際に在籍する場合、/devices の応答には publicIp が含まれ
  // ないことが多いため、uplinks/statuses から WAN IP を取得して補完する。
  // 複数 uplink (WAN1/WAN2) がある場合は、最初に active なものを優先。
  // network.productTypes ではなく実デバイスで判定するのは、Combined ネットワーク
  // で appliance が productTypes に載っていても実機が居ない場合に不要な呼び出し
  // (とレート制限消費) を避けるため。失敗時 (404 等) は無視して続行。
  if (devices.some((d) => d.productType === "appliance")) {
    const uplinksRes = await callMeraki<
      Array<{ serial?: string; uplinks?: Array<{ configured?: boolean; status?: string; ip?: string }> }>
    >(`/networks/${networkId}/appliance/uplinks/statuses`, opts);
    if (Array.isArray(uplinksRes.data)) {
      const wanIpBySerial = new Map<string, string>();
      for (const u of uplinksRes.data) {
        const serial = typeof u.serial === "string" ? u.serial : "";
        if (!serial) continue;
        if (wanIpBySerial.has(serial)) continue;
        const uplinks = Array.isArray(u.uplinks) ? u.uplinks : [];
        // active かつ configured な uplink の IP を優先。
        const active = uplinks.find(
          (x) => x.status === "active" && x.configured !== false,
        );
        const fallback = uplinks.find((x) => x.configured !== false);
        const ip = active?.ip ?? fallback?.ip;
        if (typeof ip === "string" && ip) {
          wanIpBySerial.set(serial, ip);
        }
      }
      for (const d of devices) {
        if (d.publicIp) continue; // 既に取れていれば上書きしない
        const wanIp = wanIpBySerial.get(d.serial);
        if (wanIp) d.publicIp = wanIp;
      }
    }
  }

  return { network, devices };
}

/** appliance の LAN 側 IP（MX のプライベート管理 IP）をセクションから取得する。
 *  VLAN 構成では各 VLAN の applianceIp のうち、既定 VLAN（id=1）→ 最小 VLAN ID
 *  → 先頭、の優先で 1 つ選ぶ。Single LAN 構成では applianceIp を直接使う。
 *  見つからなければ空文字を返す。 */
function extractApplianceLanIp(sections: MerakiSection[]): string {
  const pick = (label: string) =>
    sections.find((s) => s.label === label && !s.error)?.data;

  // VLANs: [{ id, applianceIp, subnet, ... }]
  const vlans = pick("Appliance / VLANs");
  if (Array.isArray(vlans) && vlans.length > 0) {
    const withIp = vlans.filter(
      (v): v is { id?: unknown; applianceIp: string } =>
        v !== null &&
        typeof v === "object" &&
        typeof (v as { applianceIp?: unknown }).applianceIp === "string" &&
        !!(v as { applianceIp?: string }).applianceIp,
    );
    if (withIp.length > 0) {
      const byId = (id: number) =>
        withIp.find((v) => Number((v as { id?: unknown }).id) === id);
      const chosen =
        byId(1) ??
        [...withIp].sort(
          (a, b) =>
            Number((a as { id?: unknown }).id ?? Infinity) -
            Number((b as { id?: unknown }).id ?? Infinity),
        )[0];
      if (chosen?.applianceIp) return chosen.applianceIp;
    }
  }

  // Single LAN: { applianceIp, subnet, ... }
  const singleLan = pick("Appliance / Single LAN");
  if (
    singleLan !== null &&
    typeof singleLan === "object" &&
    typeof (singleLan as { applianceIp?: unknown }).applianceIp === "string"
  ) {
    const ip = (singleLan as { applianceIp: string }).applianceIp;
    if (ip) return ip;
  }

  return "";
}

/** 指定ネットワークの MR/MX/MS 設定を全取得し、{@link MerakiConfigDump} を
 *  組み立てる。ネットワーク自体の取得に失敗した場合は例外を投げる。 */
export async function fetchMerakiConfig(
  networkId: string,
  apiKey: string,
  opts: Omit<MerakiFetchOptions, "apiKey"> = {},
): Promise<FetchMerakiResult> {
  const trimmedId = networkId.trim();
  if (!isValidNetworkId(trimmedId)) {
    throw new Error(
      `ネットワーク ID の形式が不正です: ${networkId}（L_xxx / N_xxx 形式である必要があります）`,
    );
  }
  if (!isValidApiKey(apiKey)) {
    throw new Error("Meraki API キーが短すぎるか空です");
  }
  const fullOpts: MerakiFetchOptions = { ...opts, apiKey };

  const { network, devices } = await fetchNetworkAndDevices(
    trimmedId,
    fullOpts,
  );

  // 取得対象の製品タイプを決める。network.productTypes はネットワークの
  // 「モード」(例: Combined = appliance/switch/wireless) を表すだけで、実際に
  // その製品のデバイスが在籍しているとは限らない。例えば Combined ネットワーク
  // に wireless (MR) しか無い場合でも productTypes には 3 種すべてが並ぶ。
  // 在籍しない製品のエンドポイントまで叩くと、
  //   1) 全て 400/404/空になるだけで意味が無く、
  //   2) 最大 50 超の並列リクエストで Meraki のレート制限 (429) を誘発し、
  //      肝心の在籍製品 (wireless の SSID/PSK 等) の取得まで巻き込んで失敗
  //      させてしまう（Issue #4: Combined + Wireless のみの構成でエラー）。
  // そのため、実際にデバイスが在籍する製品タイプのみに絞り込む。
  const presentTypes = new Set<MerakiProductType>();
  for (const d of devices) {
    if (
      d.productType === "appliance" ||
      d.productType === "switch" ||
      d.productType === "wireless"
    ) {
      presentTypes.add(d.productType);
    }
  }
  // デバイス一覧が取得できなかった (空) 場合のみ全 productTypes へフォールバック
  // する。デバイスは在籍するが appliance/switch/wireless のいずれにも該当しない
  // (camera/sensor 等のみ) 場合は targetProductTypes を空にして何も取得しない。
  // このケースは呼び出し側 (api.ts) が「MR/MX/MS 未検出」として弾くため、
  // 無駄なエンドポイント取得（＝レート制限消費）を避ける。
  const targetProductTypes =
    devices.length === 0
      ? network.productTypes
      : network.productTypes.filter((pt) => presentTypes.has(pt));

  // 製品タイプ毎にエンドポイントを (並列度を絞って) 取得。各エンドポイントの
  // {id} をネットワーク ID へ置換する。
  const statuses: Record<string, number> = {};
  const defsToFetch: { pt: MerakiProductType; label: string; endpoint: string }[] =
    [];
  for (const pt of targetProductTypes) {
    for (const def of MERAKI_ENDPOINTS[pt] ?? []) {
      defsToFetch.push({ pt, label: def.label, endpoint: def.endpoint });
    }
  }
  const sections = await mapWithConcurrency(
    defsToFetch,
    fullOpts.sectionConcurrency ?? 5,
    async (def): Promise<MerakiSection> => {
      const path = def.endpoint.replace("{id}", trimmedId);
      const r = await callMeraki<unknown>(path, fullOpts);
      statuses[path] = r.status;
      return {
        label: def.label,
        endpoint: def.endpoint,
        productType: def.pt,
        data: r.data ?? undefined,
        error: r.error,
        // HTTP 400 は「対象ネットワークでその機能が有効ではない」仕様上の
        // 正常失敗なので skipped 扱いとする。401/403/429/500 等は実エラー。
        skipped: r.error ? r.status === 400 : undefined,
      };
    },
  );

  // MX (appliance) の「プライベート IP」は /devices や uplinks では取れず、
  // VLAN / Single LAN 設定の applianceIp（＝MX の LAN 側ゲートウェイ IP）が
  // 実質的な管理プライベート IP になる。ここで appliance デバイスの lanIp を
  // その値で補完し、取り込み時に publicIp ではなくプライベート IP が選ばれる
  // ようにする（デバイス単位ループは lanIp を優先する）。
  if (devices.some((d) => d.productType === "appliance")) {
    const applianceIp = extractApplianceLanIp(sections);
    if (applianceIp) {
      for (const d of devices) {
        if (d.productType === "appliance" && !d.lanIp) {
          d.lanIp = applianceIp;
        }
      }
    }
  }

  const dump: MerakiConfigDump = {
    exportedAt: new Date().toISOString(),
    network,
    devices,
    sections,
    apiBase: fullOpts.apiBase ?? MERAKI_API_BASE,
  };
  return { dump, statuses };
}
