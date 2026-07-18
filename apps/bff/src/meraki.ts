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
      devices.push({
        name: String(d.name ?? ""),
        model: String(d.model ?? ""),
        serial: String(d.serial ?? ""),
        mac: String(d.mac ?? ""),
        productType: String(d.productType ?? ""),
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

  // MX (appliance) が含まれる場合、/devices の応答には publicIp が含まれない
  // ことが多いため、uplinks/statuses から WAN IP を取得して補完する。
  // 複数 uplink (WAN1/WAN2) がある場合は、最初に active なものを優先。
  // 失敗時 (404 等) は無視して続行。
  if (network.productTypes.includes("appliance")) {
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

  // 製品タイプ毎にエンドポイントを並列取得。各エンドポイントの {id} を
  // ネットワーク ID へ置換する。
  const sections: MerakiSection[] = [];
  const statuses: Record<string, number> = {};
  const tasks: Promise<MerakiSection>[] = [];
  for (const pt of network.productTypes) {
    const defs = MERAKI_ENDPOINTS[pt] ?? [];
    for (const def of defs) {
      const path = def.endpoint.replace("{id}", trimmedId);
      tasks.push(
        (async (): Promise<MerakiSection> => {
          const r = await callMeraki<unknown>(path, fullOpts);
          statuses[path] = r.status;
          return {
            label: def.label,
            endpoint: def.endpoint,
            productType: pt,
            data: r.data ?? undefined,
            error: r.error,
            // HTTP 400 は「対象ネットワークでその機能が有効ではない」仕様上の
            // 正常失敗なので skipped 扱いとする。401/403/429/500 等は実エラー。
            skipped: r.error ? r.status === 400 : undefined,
          };
        })(),
      );
    }
  }
  // 全件待つ（個別失敗はセクションに記録済み）。
  const results = await Promise.all(tasks);
  for (const s of results) sections.push(s);

  const dump: MerakiConfigDump = {
    exportedAt: new Date().toISOString(),
    network,
    devices,
    sections,
    apiBase: fullOpts.apiBase ?? MERAKI_API_BASE,
  };
  return { dump, statuses };
}
