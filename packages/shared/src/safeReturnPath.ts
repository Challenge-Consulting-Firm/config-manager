/** アプリ内の戻り先パスを安全化する。`from` / `returnTo` クエリパラメータのような
 *  外部から与えられる値をリンク先や OIDC 後の遷移先に使うと、`//evil.com`
 *  （プロトコル相対）や `http(s):` / `javascript:` / `data:` 等で
 *  オープンリダイレクト・XSS のリスクがある。
 *
 *  単一スラッシュ始まりのアプリ内相対パスのみ許可し、それ以外はルート("/")へ
 *  フォールバックする。BFF（OIDC callback）と Web（ページ内 from リンク）の
 *  両方で同じ規則を使う。 */
export function safeReturnPath(raw: string | null | undefined): string {
  const value = raw ?? "/";
  // 許可: "/devices/foo" など
  // 拒否: "//evil.com", "https://...", "javascript:...", "" , 相対パス
  // backslash 始まり（一部環境で "//" 相当に正規化され得る）も拒否する。
  if (!/^\/(?![\/\\])/.test(value)) return "/";
  // 制御文字・NUL を含む場合は拒否（ヘッダ・HTML 埋め込みの安全策）。
  if (/[\u0000-\u001F\u007F]/.test(value)) return "/";
  return value;
}
