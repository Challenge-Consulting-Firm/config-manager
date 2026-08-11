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
 * 各候補ポートへ並列で status ポーリングを行い、最初に応答したポートを返す。
 * タイムアウト（既定 800ms）以内に応答がなければ null。
 *
 * ポートは最大 5 つだが、接続できないポートは即 ECONNREFUSED になるため、
 * Promise.race ではなく全件並列で投げて最初の成功を採用する。
 */
export async function detectHelper(
  timeoutMs = 800,
): Promise<{ port: HelperPort; status: HelperStatusResponse } | null> {
  const controllers = HELPER_PORT_CANDIDATES.map(() => new AbortController());
  const timeout = setTimeout(() => {
    for (const c of controllers) c.abort();
  }, timeoutMs);

  const probes = HELPER_PORT_CANDIDATES.map(async (port, i) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
        method: "GET",
        signal: controllers[i].signal,
        // Private Network Access のため、明示的に credentialed にしない。
      });
      if (!res.ok) return null;
      const json = (await res.json()) as HelperStatusResponse;
      if (!json.ok) return null;
      // 最初に成功したら他の probe を中止。
      for (const c of controllers) {
        if (c !== controllers[i]) c.abort();
      }
      // HelperPort は number のエイリアスなので、port（联合型のリテラル）は
      // そのまま代入可能。
      return { port: port as number, status: json };
    } catch {
      return null;
    }
  });

  try {
    const results = await Promise.all(probes);
    return (
      results.find(
        (r): r is { port: number; status: HelperStatusResponse } => r !== null,
      ) ?? null
    );
  } finally {
    clearTimeout(timeout);
  }
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
 * ヘルパーへ Telnet 取得を要求する（POST /api/fetch）。
 *
 * パスワード・enablePassword はこのリクエストにのみ乗せ、BFF には送らない
 * （設計上、BFF への upload は SPA が取得した本文のみで行う）。
 * レスポンスに応じて成功・失敗を返す。
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
