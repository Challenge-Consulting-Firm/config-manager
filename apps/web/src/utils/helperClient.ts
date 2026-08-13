/**
 * ローカル取得ヘルパー（Go 製ポータブルアプリ）と通信するクライアント。
 *
 * ヘルパーは 127.0.0.1 の候補ポート（53712〜53716）のいずれかで待ち受ける。
 * SPA は各ポートへ GET /api/status を撃って最初に応答があったポートを採用し、
 * その後 POST /api/fetch / POST /api/shutdown を呼ぶ。
 *
 * ヘルパーの応答スキーマは @config-manager/shared（helper.ts）と同一。
 */

import {
  HELPER_PORT_CANDIDATES,
  type HelperFetchRequest,
  type HelperFetchResponse,
  type HelperShutdownResponse,
  type HelperStatusResponse,
} from "@config-manager/shared";

/** ヘルパーが見つかったポート番号。見つからなければ null。 */
export type HelperPort = number;

/**
 * ユーザー操作起点（「接続テスト」ボタン等）の検出タイムアウト。
 *
 * Local Network Access の権限プロンプトへ応答する時間を確保するため長めに取る。
 * 背景の自動ポーリングで使う 800ms とは用途が異なる。
 */
export const HELPER_DETECT_TIMEOUT_INTERACTIVE_MS = 60_000;

/** 前回ヘルパーを見つけたポートの記憶に使う localStorage キー。 */
const LAST_PORT_STORAGE_KEY = "config-manager:helper-port";

function readLastPort(): number | null {
  try {
    const v = Number(localStorage.getItem(LAST_PORT_STORAGE_KEY));
    return (HELPER_PORT_CANDIDATES as readonly number[]).includes(v) ? v : null;
  } catch {
    // localStorage が使えない環境（プライベートモード等）では記憶しない。
    return null;
  }
}

function writeLastPort(port: number | null): void {
  try {
    if (port === null) localStorage.removeItem(LAST_PORT_STORAGE_KEY);
    else localStorage.setItem(LAST_PORT_STORAGE_KEY, String(port));
  } catch {
    // 保存できなくても検出自体は動くので無視する。
  }
}

/** 単一ポートへ status を撃つ。応答がヘルパーでなければ null。 */
async function probePort(
  port: number,
  timeoutMs: number,
): Promise<{ port: HelperPort; status: HelperStatusResponse } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      method: "GET",
      signal: ctrl.signal,
      // Local Network Access のため、明示的に credentialed にしない。
    });
    if (!res.ok) return null;
    const json = (await res.json()) as HelperStatusResponse;
    if (!json.ok) return null;
    return { port, status: json };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 候補ポートを順に叩き、最初に応答したポートを返す。
 * タイムアウト以内にどのポートも応答しなければ null。
 *
 * **逐次探索にしている理由**: 全ポートを並列で叩くと、ヘルパーが使っていない
 * 4 ポート分の `net::ERR_CONNECTION_REFUSED` が毎回 DevTools コンソールに
 * 出る。これはブラウザがネットワーク層で直接出力するもので、fetch を
 * try/catch しても抑制できない。接続拒否は即座に返るため、逐次でも実測の
 * 所要時間はほぼ変わらない。
 *
 * 前回見つけたポートを localStorage に記憶して最初に試すので、通常は 1 回の
 * リクエストで検出が終わり、コンソールは綺麗なままになる。
 *
 * **タイムアウトの注意**: Chrome 138 以降の Local Network Access では、
 * 公開サイトから 127.0.0.1 への初回アクセス時に権限プロンプトが表示され、
 * ユーザーが応答するまで fetch は解決しない。短いタイムアウトで abort すると
 * プロンプトが消えて権限が記録されないため、ユーザー操作起点の検出では
 * HELPER_DETECT_TIMEOUT_INTERACTIVE_MS を使うこと。
 */
export async function detectHelper(
  timeoutMs = 800,
): Promise<{ port: HelperPort; status: HelperStatusResponse } | null> {
  const lastPort = readLastPort();
  const order = lastPort
    ? [lastPort, ...HELPER_PORT_CANDIDATES.filter((p) => p !== lastPort)]
    : [...HELPER_PORT_CANDIDATES];

  const deadline = Date.now() + timeoutMs;
  for (const port of order) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const found = await probePort(port, remaining);
    if (found) {
      writeLastPort(found.port);
      return found;
    }
  }
  writeLastPort(null);
  return null;
}

/**
 * 単一ポートのヘルパーへ GET /api/status を撃ち、稼働中なら status を返す。
 * セットアップ画面の「接続テスト」ボタンや、ヘルパー検出後の定期ポーリングで使う。
 */
export async function checkHelperStatus(
  port: HelperPort,
  timeoutMs = 1500,
): Promise<HelperStatusResponse> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      method: "GET",
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`ヘルパーが応答しません (HTTP ${res.status})`);
    }
    const json = (await res.json()) as HelperStatusResponse;
    if (!json.ok) {
      throw new Error("ヘルパーの応答が不正です");
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * ヘルパーへ取得を要求する（POST /api/fetch）。
 *
 * 認証情報の渡し方は 2 通りある。
 *   1. 都度入力: password / enablePassword をこのリクエストに乗せる。BFF には
 *      送らない（BFF への upload は取得した本文のみ）。
 *   2. 保存済み認証情報: credentialToken だけを乗せる。平文はヘルパーが BFF
 *      から引き換えるため、SPA は一度もパスワードを保持しない（Issue #53）。
 */
export async function fetchConfigViaHelper(
  port: HelperPort,
  req: HelperFetchRequest,
  timeoutMs = 200_000,
): Promise<HelperFetchResponse> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // バリデーションエラー等（400 系）。本文は { error: string } の想定。
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) detail = body.error;
      } catch {
        // JSON 以外ならステータスのみ。
      }
      return {
        ok: false,
        code: "connect_failed",
        message: `ヘルパーとの通信に失敗しました: ${detail}`,
      };
    }
    return (await res.json()) as HelperFetchResponse;
  } catch (e) {
    // 中断（タイムアウト）かネットワークエラー。
    return {
      ok: false,
      code: "timeout",
      message:
        e instanceof Error && e.name === "AbortError"
          ? "ヘルパーからの応答がタイムアウトしました"
          : `ヘルパーとの通信に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * ヘルパーへ終了を要求する（POST /api/shutdown）。
 * 200 を返してからプロセスを終了する。画面の「ヘルパーを停止」ボタンから呼ぶ。
 */
export async function shutdownHelper(
  port: HelperPort,
  timeoutMs = 3000,
): Promise<HelperShutdownResponse | null> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as HelperShutdownResponse;
  } catch {
    // プロセスが即座に終了して接続が切れることがあるため、エラーは無視。
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** latest.json（BFF が配信するヘルパー配布メタデータ）の形状。 */
export interface HelperLatestManifest {
  version: string;
  releasedAt?: string;
  note?: string;
  assets: Partial<Record<HelperAssetKey, HelperAssetEntry>>;
}

/** 配布アセットの OS 判定キー。SPA は navigator から対応するキーを選ぶ。 */
export type HelperAssetKey =
  | "windows-x64"
  | "darwin-universal"
  | "darwin-arm64"
  | "darwin-amd64"
  | "linux-x64";

export interface HelperAssetEntry {
  /** ダウンロード URL（相対パス or 絶対 URL）。GitHub Releases の場合は外部 URL。 */
  url: string;
  /** SHA-256 チェックサム（省略可）。 */
  sha256?: string;
}

/** BFF から latest.json を取得する。未配信時は null。 */
export async function fetchHelperManifest(
  timeoutMs = 5000,
): Promise<HelperLatestManifest | null> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("/downloads/helper/latest.json", {
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as HelperLatestManifest;
    return json;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** ブラウザの navigator から配布アセットキーを推定する。 */
export function detectHelperAssetKey(): HelperAssetKey | null {
  const ua = navigator.userAgent;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? "";
  // macOS (Intel / Apple Silicon)。universal があれば優先、なければ後続で個別判定。
  if (/Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(ua)) {
    // universal がある環境では universal を優先するため、呼び出し側で解決する。
    return "darwin-universal";
  }
  if (/Win/i.test(platform) || /Windows/i.test(ua)) {
    return "windows-x64";
  }
  if (/Linux/i.test(platform) || /Linux/i.test(ua)) {
    return "linux-x64";
  }
  return null;
}

/**
 * 推定アセットキーを最新マニフェストの実在するアセットへ解決する。
 * universal が無ければアーキテクチャ別、それも無ければ null。
 * アーキテクチャの判定は UA の heuristic（Apple Silicon の明確な合図がないため
 * 最終手段）。ユーザーが手動で別リンクを選べるよう、セットアップ画面では
 * 全アセットのリンクを併記する。
 */
export function resolveHelperAsset(
  manifest: HelperLatestManifest | null,
  preferred: HelperAssetKey | null,
): HelperAssetEntry | null {
  if (!manifest || !preferred) return null;
  // 1. 推定キーがそのまま存在すれば採用。
  if (manifest.assets[preferred]) return manifest.assets[preferred]!;
  // 2. macOS universal を選んだが universal が無い場合、アーキを推定して個別へ。
  if (preferred === "darwin-universal") {
    // Apple Silicon のヒューリスティック（Arm 用バイナリを少しでも優先）。
    // 正確なアーキ判定はブラウザから困難なため、arm64 → amd64 の順で試す。
    return manifest.assets["darwin-arm64"] ?? manifest.assets["darwin-amd64"] ?? null;
  }
  return null;
}
