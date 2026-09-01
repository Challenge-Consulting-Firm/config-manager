/**
 * HTTP アクセスログ（Issue #78）。
 *
 * Hono 標準の `logger()` は request URL の path を query string ごと出力する。
 * その結果、OIDC callback の `code` / `state`、検索語 `q`、顧客名・ホスト名・
 * IP アドレスといった認証材料や業務データが fly のログ（および転送先）に
 * 残り得る。運用に必要なのは「どの経路が・どんな結果で・どれだけかかったか」
 * であって、値そのものではない。
 *
 * そこでこの logger は **pathname と最小限のメタデータだけ**を出す。
 * query は denylist ではなく allowlist 方式で、{@link LOGGED_QUERY_PARAMS} に
 * 挙げた構造的なパラメータだけを残し、それ以外は名前ごと落とす。
 * 新しい項目をログへ出したくなったら、値が機密でないことを確認したうえで
 * allowlist に足すこと。
 *
 * 出力形式は標準 logger に合わせてある（既存の grep 手順を壊さないため）:
 *
 *   <-- GET /api/search
 *   --> GET /api/search 200 12ms
 */

import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./api.js";

/**
 * ログに値を残してよい query parameter。
 *
 * いずれも取り得る値が構造的（数値・固定語）で、業務データも認証材料も
 * 含まない。検索語・顧客名・ホスト名・IP・`code` / `state` / `returnTo` は
 * ここに入れてはならない。
 */
export const LOGGED_QUERY_PARAMS: readonly string[] = [
  "limit",
  "maxPerVersion",
  "scope",
  "regex",
];

/** ログ 1 行に載せる値の長さ上限。 */
const MAX_VALUE_LENGTH = 32;

/** pathname の長さ上限。SPA fallback は任意のパスを受けるため頭打ちにする。 */
const MAX_PATH_LENGTH = 256;

/** 制御文字（C0 と DEL）。ログ行の偽造に使われる改行もここに含まれる。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * ログ行への注入を防ぐ。
 *
 * 値は利用者が自由に決められるため、改行や制御文字をそのまま出すと偽の
 * ログ行を差し込める。制御文字を落としたうえで長さも切り詰める。
 */
export function sanitizeLogValue(
  value: string,
  maxLength = MAX_VALUE_LENGTH,
): string {
  const stripped = value.replace(CONTROL_CHARS, "");
  return stripped.length > maxLength
    ? `${stripped.slice(0, maxLength)}…`
    : stripped;
}

/**
 * ログに出す path を組み立てる。pathname と allowlist 済み query だけを返す。
 */
export function formatLoggedPath(rawUrl: string): string {
  let pathname: string;
  let search: string;
  try {
    const url = new URL(rawUrl);
    pathname = url.pathname;
    search = url.search;
  } catch {
    // URL として解釈できない要求。pathname も信用できないので固定値にする。
    return "(unparsable)";
  }

  const safePath = sanitizeLogValue(pathname, MAX_PATH_LENGTH);
  if (!search) return safePath;

  const params = new URLSearchParams(search);
  const kept: string[] = [];
  for (const name of LOGGED_QUERY_PARAMS) {
    const value = params.get(name);
    if (value === null) continue;
    kept.push(`${name}=${sanitizeLogValue(value)}`);
  }
  // allowlist 外は名前ごと落とす。名前だけでも経路と組み合わせると
  // 「何を検索したか」の手掛かりになりうるため。
  return kept.length > 0 ? `${safePath}?${kept.join("&")}` : safePath;
}

/** 経過時間の表示。1 秒未満は ms、それ以上は秒。 */
function elapsed(startMs: number): string {
  const delta = Date.now() - startMs;
  return delta < 1000 ? `${delta}ms` : `${Math.round(delta / 1000)}s`;
}

/**
 * incoming / outgoing の 2 行を出すアクセスログ。
 * `fn` はテストから差し替えるためだけの引数。
 */
export function accessLogger(
  fn: (message: string) => void = console.log,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method;
    const path = formatLoggedPath(c.req.url);
    fn(`<-- ${method} ${path}`);
    const start = Date.now();
    await next();
    fn(`--> ${method} ${path} ${c.res.status} ${elapsed(start)}`);
  };
}
