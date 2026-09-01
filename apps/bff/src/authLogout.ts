/**
 * ログアウト経路（Issue #80）。
 *
 * かつては `GET /auth/logout` がセッションの revoke と cookie 破棄という
 * 状態変更を行っていた。GET は CSRF Origin guard の対象外（`security.ts` の
 * STATE_CHANGING）なので、外部サイトはリンク遷移や `<img>` ひとつでログイン中の
 * 利用者を強制ログアウトさせられた。実害は作業中断だが、再認証を装った
 * フィッシングの起点にもなり得るし、そもそも GET は副作用を持たないという
 * HTTP の前提に反する。
 *
 * そこで状態変更は `POST /auth/logout` に限定し、既存の Origin/Referer guard を
 * そのまま効かせる。`GET /auth/logout` は副作用を持たず、確認ページを返すだけに
 * した（既存のブックマークやリンクを 404 にしないため）。
 */

import { Hono } from "hono";
import type { AppConfig } from "./config.js";
import type { AppEnv } from "./api.js";
import { getSession, type SessionOptions } from "./session.js";
import { revokeSession } from "./sessionRegistry.js";

/**
 * Entra 側のサインアウト URL。ローカルのセッションを消しただけでは IdP の
 * セッションが残り、次のログインが素通りしてしまう。
 */
export function buildEntraLogoutUrl(cfg: AppConfig): string {
  const postLogoutUri = `${cfg.publicBaseUrl}/`;
  return (
    `https://login.microsoftonline.com/${cfg.entra.tenantId}/oauth2/v2.0/logout` +
    `?post_logout_redirect_uri=${encodeURIComponent(postLogoutUri)}`
  );
}

/** 確認ページ。スクリプトは使わない（CSP の script-src は 'self' のみ）。 */
const CONFIRM_PAGE = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ログアウト</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #f8fafc; color: #0f172a; }
  main { background: #fff; padding: 2rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); text-align: center; }
  button { font: inherit; padding: .5rem 1.25rem; border: 0; border-radius: 6px; background: #0f172a; color: #fff; cursor: pointer; }
  a { display: inline-block; margin-left: 1rem; color: #475569; }
</style>
</head>
<body>
<main>
  <h1>ログアウトしますか?</h1>
  <form method="post" action="/auth/logout">
    <button type="submit">ログアウト</button>
    <a href="/">キャンセル</a>
  </form>
</main>
</body>
</html>
`;

/**
 * `/auth` 配下へマウントするログアウトルータ。
 *
 * `sessionOpts` は確立済みセッション用の設定（SameSite=Lax）を渡すこと。
 */
export function createAuthLogoutApp(
  cfg: AppConfig,
  sessionOpts: SessionOptions,
): Hono<AppEnv> {
  const logout = new Hono<AppEnv>();

  // 副作用なし。状態変更は POST 側だけが行う。
  logout.get("/logout", (c) => {
    if (cfg.authMode === "disabled") return c.redirect("/");
    return c.html(CONFIRM_PAGE);
  });

  logout.post("/logout", async (c) => {
    if (cfg.authMode === "disabled") {
      return c.json({ ok: true, redirectTo: "/" });
    }

    const session = await getSession(c, sessionOpts);
    // revoke を destroy より先に行う。cookie の複製を持ち出されていても、
    // このプロセスが生きている間は再利用させない。
    const user = session.get("user");
    revokeSession(session.get("sid"), { email: user?.email });
    session.destroy();

    const redirectTo = buildEntraLogoutUrl(cfg);

    // 確認ページの `<form>` から来た要求は、fetch ではなく通常のナビゲーション
    // なので JSON を見せても仕方がない。そのまま IdP へ 303 で送る。
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.startsWith("application/x-www-form-urlencoded")) {
      return c.redirect(redirectTo, 303);
    }

    // SPA は fetch で呼ぶ。リダイレクトを返すと fetch が IdP を追いかけて
    // CORS で失敗するため、遷移先は本文で渡して画面側に任せる。
    return c.json({ ok: true, redirectTo });
  });

  return logout;
}
