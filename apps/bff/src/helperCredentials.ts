/**
 * ローカル取得ヘルパー専用の引き換えルート（Issue #53）。
 *
 * このルートを `/api/*` の外に置いているのは意図的。呼び出し元はブラウザでは
 * なくユーザー PC 上のヘルパー（Go）で、セッション Cookie も Origin も持たない
 * ため、`/api/*` のセッションガードと CSRF Origin ガードのどちらも通れない。
 *
 * 代わりの保護は引き換えトークンそのものが担う。32 バイトの乱数・一回限り・
 * 数十秒で失効し、発行時の利用者と対象機器に束縛される。平文パスワードが
 * ブラウザを一切通らないことと引き換えに、この経路を開けている。
 *
 * 未認証でインターネットから到達できる唯一の POST であるため、DoS 耐性の
 * ための多段ガードを重ねている（Issue #77）。上から順に安価な判定で落とす:
 *
 *   1. IP 単位の rate limit（429）
 *   2. route 固有の body 上限 1 KiB（413）— アプリ共通の 6 MiB は適用しない
 *   3. 同時実行上限（503）— 単一 fly machine の CPU / メモリを守る
 *   4. トークンの長さ・文字種の検証（401）— Map 走査や Kintone 呼び出しの前
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppConfig } from "./config.js";
import type { AppEnv } from "./api.js";
import { getNodeCredentialSecret, writeAudit } from "./kintone.js";
import {
  consumeNodeCredentialToken,
  isWellFormedNodeCredentialToken,
} from "./nodeCredentialTokens.js";
import { formatDestructiveDetail } from "./auditGuard.js";
import { concurrencyLimit, rateLimit } from "./rateLimit.js";

/**
 * 正規トークンは 43 文字。JSON の包み分を足しても 1 KiB あれば十分で、
 * これを超える body は読み切らずに 413 で落とす。
 */
export const REDEEM_MAX_BODY_BYTES = 1024;

/** 同一 IP からの引き換え要求の上限（分あたり）。 */
export const REDEEM_RATE_LIMIT_PER_MIN = 60;

/** 引き換えハンドラを同時に実行できる本数。 */
export const REDEEM_MAX_CONCURRENCY = 4;

/**
 * Kintone 依存の差し替え口。既定は本番実装で、テストだけが差し替える。
 */
export interface HelperCredentialsDeps {
  loadSecret: typeof getNodeCredentialSecret;
  writeAudit: typeof writeAudit;
}

const defaultDeps: HelperCredentialsDeps = {
  loadSecret: getNodeCredentialSecret,
  writeAudit,
};

/** `/helper` 配下へマウントするルータを組み立てる。 */
export function createHelperCredentialsApp(
  cfg: AppConfig,
  deps: HelperCredentialsDeps = defaultDeps,
): Hono<AppEnv> {
  const helper = new Hono<AppEnv>();

  helper.post(
    "/credentials/redeem",
    // 1. まず IP 単位で絞る。未認証ルートなので keyBy は "ip" 固定。
    rateLimit({
      name: "credentials-redeem",
      limit: REDEEM_RATE_LIMIT_PER_MIN,
      windowMs: 60_000,
      keyBy: "ip",
    }),
    // 2. body 上限。Content-Length があればボディを読まずに 413 で落ちる。
    bodyLimit({
      maxSize: REDEEM_MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          { error: "request body too large", maxBytes: REDEEM_MAX_BODY_BYTES },
          413,
        ),
    }),
    // 3. 同時実行上限。溢れた分はキューイングせず即座に落とす。
    concurrencyLimit({
      name: "credentials-redeem",
      max: REDEEM_MAX_CONCURRENCY,
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const payload = await c.req.json<{ token?: string }>().catch(() => null);
      const token = payload?.token?.trim();
      if (!token) {
        return c.json({ error: "token is required" }, 400);
      }

      // 形式が正規トークンとして成立しない入力は、Map 走査にも監査にも進ませない。
      // 応答は未知・期限切れ・使用済みと同じにして手掛かりを与えない（Issue #77）。
      if (!isWellFormedNodeCredentialToken(token)) {
        console.warn("[node-credentials] redeem rejected: malformed token");
        return c.json({ error: "token is invalid or expired" }, 401);
      }

      const ctx = consumeNodeCredentialToken(token);
      if (!ctx) {
        // 期限切れ・使用済み・未知のいずれか。理由は区別せず返す（総当たりの
        // 手掛かりを与えないため）。ログ側にも token は残さない。
        console.warn("[node-credentials] redeem rejected: unknown or expired token");
        return c.json({ error: "token is invalid or expired" }, 401);
      }

      try {
        const secret = await deps.loadSecret(cfg, ctx.credentialId, {
          stripInvisible: ctx.stripInvisible,
        });
        if (!secret) {
          await deps.writeAudit(cfg, {
            operator: ctx.operator,
            operatorEmail: ctx.operatorEmail,
            action: "credential",
            customer: ctx.target.customer,
            hostname: ctx.target.hostname,
            detail: formatDestructiveDetail({
              kind: "credential.reveal",
              summary: "機器認証情報の引き換えに失敗（レコードが対象外または削除済み）",
              attrs: {
                id: ctx.credentialId,
                ip: ctx.target.ipAddress,
                result: "not_found",
              },
            }),
          });
          return c.json({ error: "credential not found" }, 404);
        }

        // 【監査】平文を渡す直前に fail closed で記録する。監査を書けないなら
        // 平文は出さない（記録できない参照を許すと追跡不能になるため）。
        // 監査アプリの action ドロップダウンに `credential` の選択肢が無いと
        // ここで失敗する。`node scripts/setup-kintone.mjs --app audit` で同期すること。
        try {
          await deps.writeAudit(
            cfg,
            {
              operator: ctx.operator,
              operatorEmail: ctx.operatorEmail,
              action: "credential",
              customer: ctx.target.customer,
              hostname: ctx.target.hostname,
              detail: formatDestructiveDetail({
                kind: "credential.reveal",
                summary: `機器認証情報をヘルパーへ引き換え: ${secret.nodeName}`,
                attrs: {
                  id: ctx.credentialId,
                  ip: ctx.target.ipAddress,
                  account: secret.username,
                  customerRecord: secret.customerName,
                  result: "redeemed",
                },
              }),
            },
            { failClosed: true },
          );
        } catch {
          // writeAudit 側で既にログ出力済み。平文は返さない。
          return c.json(
            {
              error:
                "監査ログを記録できなかったため、認証情報の引き換えを中止しました",
            },
            503,
          );
        }

        // 【機密】この応答だけが平文を運ぶ。ログには絶対に出さない。
        return c.json({ username: secret.username, password: secret.password });
      } catch (err) {
        console.error("[node-credentials] redeem failed:", err);
        return c.json({ error: "failed to load credential" }, 500);
      }
    },
  );

  return helper;
}
