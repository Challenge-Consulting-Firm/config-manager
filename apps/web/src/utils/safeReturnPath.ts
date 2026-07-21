/** アプリ内の戻り先パスを安全化する。`from` クエリパラメータのような
 *  外部から与えられる値をリンク先に使うと、`//evil.com`（プロトコル相対）や
 *  `http(s):` / `javascript:` / `data:` 等でオープンリダイレクト・XSS の
 *  リスクがある。単一スラッシュ始まりのアプリ内相対パスのみ許可し、それ以外は
 *  ルート("/")へフォールバックする。 */
export function safeReturnPath(raw: string | null | undefined): string {
  const value = raw ?? "/";
  return /^\/(?!\/)/.test(value) ? value : "/";
}
