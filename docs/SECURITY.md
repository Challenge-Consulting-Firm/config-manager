# セキュリティ運用ガイド

脆弱性診断フォローアップ（Epic #9）で入れた対策の運用メモです。
デプロイ手順の詳細は [DEPLOY.md](./DEPLOY.md) を参照してください。

## 目次

- [認証・RBAC](#認証rbac)
- [セッション](#セッション)
- [Meraki API キーの暗号化](#meraki-api-キーの暗号化)
- [機器認証情報の引き換え](#機器認証情報の引き換え)
- [ローカルヘルパーの取得コマンド](#ローカルヘルパーの取得コマンド)
- [監査ログと異常検知](#監査ログと異常検知)
- [アクセスログの運用](#アクセスログの運用)
- [依存関係の脆弱性スキャン](#依存関係の脆弱性スキャン)
- [SESSION_SECRET / エラーメッセージ](#session_secret--エラーメッセージ)

---

## 認証・RBAC

| ロール | できること |
| --- | --- |
| viewer | GET 系（一覧・詳細・検索・差分） |
| operator | + upload / promote / meraki import / メタ編集 |
| admin | + 削除 / Meraki 接続情報 CRUD |

Entra グループ ID を env でマッピングします。

```bash
ENTRA_GROUP_ADMIN_IDS=...
ENTRA_GROUP_OPERATOR_IDS=...
ENTRA_GROUP_VIEWER_IDS=...
```

本番（`NODE_ENV=production` かつ `AUTH_MODE=oidc`）は **3 つとも未設定なら起動を拒否** します（Issue #82）。
設定漏れで RBAC が黙って無効化され、全員 admin になる事故を防ぐためです。

```
Error: RBAC role groups are not configured. Set at least one of
ENTRA_GROUP_ADMIN_IDS / ENTRA_GROUP_OPERATOR_IDS / ENTRA_GROUP_VIEWER_IDS ...
```

本番以外（ローカル・検証）では未設定時のみ認証ユーザー全員を admin 扱いとし、起動時に warn を出します。
どのロールグループにも属さないユーザーはログイン時に 403 で拒否されます（fail closed）。

---

## セッション

### 現状

- Cookie: iron-session による sealed cookie（`HttpOnly` + `Secure` + 確立後 `SameSite=Lax`）
- ログイン時に opaque な `sid` を発行
- ログアウト時にプロセス内 denylist へ `sid` を登録 → 以降その cookie は 401
- payload に schema version（`v`）を持ち、**現行バージョン以外の cookie は読み捨てる**

### schema version と fail-closed 判定

`apps/bff/src/session.ts` の `SESSION_SCHEMA_VERSION` が payload の互換性を表します。
`getSession()` は unseal 後に以下を検証し、**いずれかに引っかかった cookie は丸ごと破棄**して未認証として扱います（再ログインが必要）。

| 判定 | 例 | 結果 |
| --- | --- | --- |
| `v` が現行値でない | RBAC 導入前の旧 cookie（`v` なし） | 破棄 → 401 |
| `user.role` が欠落 / 未知の値 | 旧 cookie、改造された payload | 破棄 → 401 |

以前は role 欠落セッションを **admin へ補完** していたため、旧 cookie が管理者権限を得られました。
現在は補完せず fail closed です（Issue #82）。バージョンを上げる際は `SESSION_SCHEMA_VERSION` をインクリメントすれば、旧 cookie は自動的に失効します。

### 旧セッションの失効（移行手順）

1. 通常デプロイで十分です。`SESSION_SCHEMA_VERSION` の変更を含むリリースでは、既存ログイン中のユーザーは次のリクエストで 401 となり、ログイン画面へ戻されます（再ログインすれば復帰）。
2. cookie の seal 自体を無効化して**確実に全セッションを失効**させたい場合（鍵漏洩の疑い等）は `SESSION_SECRET` をローテートします。

```bash
fly secrets set --app config-manager SESSION_SECRET=$(openssl rand -base64 32)
```

`fly secrets set` はマシンを再起動するため、これだけで全 sealed cookie が復号不能になります。

### 限界（単一 fly machine 前提）

| 事象 | 振る舞い |
| --- | --- |
| 同一 machine での logout | 即時 revoke（denylist） |
| machine 再起動 / auto-stop 復帰 | denylist は消える。sealed cookie は自身の TTL（7 日）まで有効 |
| 全セッション強制失効 | `SESSION_SECRET` をローテートして再デプロイ |

### 将来の共有ストア移行

マルチ machine や即時グローバル revoke が必要になったら Upstash Redis 等へ移す。

1. ブラウザには不透明なセッション ID のみ（可能なら `__Host-` + `HttpOnly` + `Secure` + `SameSite=Lax`）
2. サーバー側に user / exp / ロールを保持
3. logout でサーバー側エントリを DELETE
4. ストア障害時は fail-closed（401）を推奨

現状は fly.toml が単一マシン想定のため、cookie + プロセス内 revoke で受け入れています。

---

## Meraki API キーの暗号化

Kintone の Meraki 接続情報アプリに保存する `api_key` は、BFF が **AES-256-GCM** で暗号化してから書き込みます。

### セットアップ

```bash
# 32 バイトの鍵を生成
openssl rand -base64 32

# ローカル
# .env に追記
CREDENTIALS_ENCRYPTION_KEY=<上で生成した値>

# 本番
fly secrets set --app config-manager CREDENTIALS_ENCRYPTION_KEY=<上で生成した値>
```

- 未設定時: 平文のまま保存（ローカル便利さのため）。本番かつ Meraki アプリ設定済みだと起動 warn。
- 形式: `enc:v1:<iv>:<tag>:<ciphertext>`（base64url）
- UI / API レスポンスは従来どおり末尾 4 文字マスク。平文キーは import 実行時のみメモリ上に存在。

### 既存平文データの移行

1. `CREDENTIALS_ENCRYPTION_KEY` を設定してデプロイ
2. 接続情報を **一覧表示または import で 1 度でも読む**と、BFF が平文行を検知して自動で再暗号化（lazy migration）
3. あるいは管理 UI から各行を「編集 → 保存」しても暗号化される
4. Kintone 上で `api_key` が `enc:v1:` で始まっていれば移行完了

### 鍵ローテーション

1. 新鍵を用意する（旧鍵は一時保持）
2. 現状の実装は **単一鍵**のみサポート。ローテ手順:
   - 新鍵を設定する前に、全 credential を UI から再入力するか、一時的に旧鍵のまま全件 read（再暗号化は同一鍵でのみ意味がある）
   - **現実的な手順**: 新鍵デプロイ前に、既存レコードの API キーを手元に退避 → 新鍵デプロイ → UI から再登録
3. 複数世代鍵（`enc:v2:` + key ring）が必要になったら `secretCrypto.ts` を拡張する

> 鍵を紛失すると保存済み API キーは復号不能です。fly secrets のバックアップ運用に従ってください。

---

## 機器認証情報の引き換え

Kintone の顧客情報（ノード管理）アプリに登録された機器のアカウント名・パスワードを、ローカル取得ヘルパーのログインへ適用する機能（Issue #53）の設計根拠です。`KINTONE_CUSTOMER_INFO_APP_ID` / `KINTONE_CUSTOMER_INFO_APP_TOKEN` の両方が設定されたときだけ有効になります。

### なぜ平文をブラウザへ返さないのか

機器へログインする以上、パスワードはどこかで平文になります。素直に作れば BFF → SPA → ヘルパーと流れますが、そうすると平文が React state・DevTools・ブラウザ拡張・画面共有の露出面に載ります。取得後に state を消しても、取得前の中断・通信レスポンス・JS ヒープへの残存は防げません。

そこで SPA には**一回限りの不透明トークン**だけを渡し、平文はヘルパーが BFF から直接引き換えます。

```
SPA  POST /api/node-credentials/:id/issue-token  →  { token, expiresInMs, username }
SPA  POST http://127.0.0.1:<port>/api/fetch      →  { credentialToken: token, ... }
ヘルパー POST /helper/credentials/redeem          →  { username, password }
```

トークンの性質:

- 32 バイトの乱数（`randomBytes(32)`）
- 一回限り（引き換え時に破棄）
- 60 秒で失効（`NODE_CREDENTIAL_TOKEN_TTL_MS`）
- 発行時の利用者・対象機器・レコード ID に束縛

引き換え先 URL はリクエストボディからは受け取らず、ヘルパーが**検証済みの Origin** から組み立てます。ボディで受け取ると、許可 Origin から呼ばれた要求でトークンを外部へ送り出せてしまうためです。リモートホストへの平文 HTTP は拒否します（ループバックのみ開発用に許可）。

### `/helper/credentials/redeem` が `/api/*` の外にある理由

呼び出し元はブラウザではなくユーザー PC 上のヘルパー（Go）で、セッション Cookie も Origin も持ちません。`/api/*` のセッションガードと CSRF Origin ガードのどちらも通れないため、意図的に外へ出しています。保護はトークンそのものが担います。

トークン保管はプロセスローカルの Map です。**複数インスタンスへスケールする場合は共有ストアへ置き換えが必要**です（別インスタンスへ redeem が届くとトークンが見つからず失敗します）。

### ロール制限を設けていない理由

参照元の Kintone アプリが社内全員に公開されているため、config-manager 側でロールを絞っても実効的な保護になりません（Issue #53 決定 B）。代わりに参照は必ず監査ログに残します。

**この前提が崩れる条件**: Kintone 側にレコード単位の閲覧制限や IP 制限をかけた場合です。Kintone の API トークンはレコード単位の権限をバイパスするため、その時点で config-manager 経由の参照が制限を越えることになります。参照元アプリの公開範囲を変更する際は、この機能の権限設計を見直してください。

### 露出範囲の制限

- 候補は**対象機器の IP コンテキスト経由でしか引けません**。機器コンテキスト無しの自由検索 API は提供していません。
- レコード ID を直接指定しても引けません。トークン発行時に候補一覧を引き直し、要求されたレコードが対象機器の IP と一致するかを再検証します。
- `対象` が `削除・管理外` のレコードは候補にも引き換えにも出しません。

> **`システム種別_詳細区分` によるホワイトリスト絞り込みは廃止しました。**
> 当初は「NW 機器だけを候補に出す」露出制限として入れましたが、参照元アプリが社内全員に公開されている前提（決定 B）では実効的な保護になりません。一方で区分はアプリ側で自由に増える値で、区分が未設定の実在機器を軒並み除外してしまい、正しいレコードが候補に出ないという実害が出ました。実質的なゲートは IP 完全一致・トークンの ID 束縛・監査ログであり、区分フィルタはそこに何も足していませんでした。区分は候補一覧に表示するので、利用者が見て選べます。
- 候補一覧の応答に**パスワードは長さも含め一切含めません**。候補取得の Kintone クエリからもパスワードフィールドを外しています。

### DoS 耐性（未認証ルートの多段ガード）

`/helper/credentials/redeem` は**未認証でインターネットから到達できる唯一の POST** です。単一 fly machine（1 GB / shared CPU 1 基）構成のため、安価な判定から順に落とす多段ガードを置いています（Issue #77）。実装は `apps/bff/src/helperCredentials.ts`。

| 段 | ガード | 上限 | 応答 |
| --- | --- | --- | --- |
| 1 | IP 単位の rate limit | 60 req / 分 | `429` + `Retry-After` |
| 2 | route 固有の body 上限 | 1 KiB | `413` |
| 3 | 同時実行上限 | 4 | `503` + `Retry-After` |
| 4 | トークンの長さ・文字種検証 | 43 文字の Base64URL | `401` |

- **body 上限**: アプリ共通の 6 MiB（5 MB のコンフィグアップロード用）はこのルートには適用しません。正規のボディは `{"token":"<43 文字>"}` だけです。`Content-Length` があれば本文を読まずに落ちます。
- **形式検証**: 長さ・文字種が正規トークンとして成立しない入力は、`Buffer` 化・保持中トークンの走査・Kintone 呼び出しのいずれにも進みません。
- **応答の均一性**: 形式不正・未知・期限切れ・使用済みはすべて同じ `401` と同じ本文を返します。総当たりの手掛かりを与えないためです。ログにも token 本文は出しません。
- **クライアント IP の判定**: `Fly-Client-IP`（fly.io プロキシが付与するため詐称不可）を優先し、無ければ `X-Forwarded-For` の**最右**要素を使います。クライアントは左側に任意の値を差し込めますが、最右は信頼できるプロキシが追加した値です。

いずれもプロセスローカルの状態です。複数マシンへスケールする場合は、トークン保管と同様に共有ストアへ移す必要があります。fly.io 側の `hard_limit = 250`（`fly.toml`）はマシン全体の同時接続数であり、ルート単位の保護にはならないため、上記をアプリ側で持っています。

### 監査は fail closed

トークン発行と引き換えの両方で、監査ログの書き込みに失敗したら操作を中止します（HTTP 503）。記録できない参照を許すと追跡不能になるためです。他の操作の `writeAudit` はベストエフォートのままで、この経路だけ `failClosed: true` を渡しています。

**運用上の前提**: 作業履歴アプリの `action` ドロップダウンに `credential` の選択肢が必要です。無いと Kintone が値を拒否し、本機能が 503 で止まります。

```bash
node scripts/setup-kintone.mjs --app audit
```

このスクリプトは既存フィールドを飛ばす作りでしたが、ドロップダウンの選択肢だけは既存フィールドにも同期するようにしています。

### パスワードを正規化しない方針

参照元アプリには Excel からの貼り付けに由来するゼロ幅スペース（`U+200B`）が広範に混入しています（調査時点でパスワード 102/500 件）。しかしパスワードは任意の文字列であり、不可視文字を含む正当なパスワードを壊しうるため、**BFF は既定でパスワードを加工しません**。

除去するのは利用者が取得ダイアログで明示的に選んだときだけです（`stripInvisible`）。認証失敗時に自動で正規化版を再試行することもしません（アカウントロックと監査の曖昧化を招くため）。照合キー（IP・ホスト名・アカウント名）の正規化はこの制約の対象外で、常に行います。

恒久対応は Kintone 側のデータクリーンアップです。

## ローカルヘルパーの取得コマンド

取得ヘルパーは「読み取り専用でコンフィグを取ってくる」機能であり、機器の設定変更経路にしてはいけません。`commandOverride`（取得コマンドの上書き）は入力どおり対話シェルへ 1 行として送られるため、CR / LF を混ぜられると 1 回の取得で複数コマンドを実行させられます（Issue #76）。

**信頼境界はヘルパー側**にあります。SPA にも同じ検証を置いていますが、ヘルパーの HTTP API は SPA を経由せずに叩けるため、UI の検証は UX 補助でしかありません。

- 制御文字（CR / LF / NUL / タブ等）を含むコマンドは、機器へ接続する前に 400 で拒否
- 使える文字は英数字と `- _ . / :` および半角空白のみ。先頭語は `show` / `display` / `get` / `dir` / `more` に限定
- **保存済み認証情報（一回限りトークン）を使う場合は、osHint ごとの定義済み読み取り専用コマンドのみ**。高権限 credential と任意コマンドの組み合わせを断つ
- 送信直前のセッション層でも制御文字を再検査し、通過した場合は `command_invalid` で fail closed（CLI 経路を含む最終防衛線）
- 拒否時、入力されたコマンドはログにも応答にも出さない（誤って貼り付けられた認証情報を漏らさないため）

自由入力が必要な未サポート機種は、都度入力の認証情報で実行します。詳細と一覧は `apps/helper/README.md` の「OS 別コマンドマップ」を参照してください。

---

## 監査ログと異常検知

### 破壊的操作の detail 形式

```
event=<kind> | <summary> | k=v k2=v2
```

| kind | 操作 |
| --- | --- |
| `version.delete` | 世代削除 |
| `device.delete` | 機器一括削除 |
| `credential.create` / `.update` / `.delete` | Meraki 接続情報の変更 |
| `credential.reveal` | 機器認証情報の参照（トークン発行・引き換え） |

### バースト検知

同一アクターが **10 分以内に 5 回以上** の破壊的操作を行うと、Fly ログに次を出します。

```
[audit-alert] burst detected actor=... kind=... count=5/5 windowMs=600000
```

対応ランブック:

1. `fly logs --app config-manager` で `[audit-alert]` を確認
2. Kintone 作業履歴アプリで該当 actor の直近操作を確認
3. 不正が疑われる場合: 対象ユーザーを Entra グループから外す / `SESSION_SECRET` ローテ
4. 正当な大量削除だった場合は記録のみ（誤検知としてクローズ）

### 作業履歴アプリの権限

運用用 API トークンは **閲覧 + 追加** のみ（編集・削除なし）。これによりアプリ上からの改ざん面を縮小します（詳細は README B-4 / DEPLOY.md）。

---

## アクセスログの運用

HTTP アクセスログは `apps/bff/src/accessLog.ts` の `accessLogger()` が出力します。Hono 標準の `logger()` は **query string を値ごと記録する**ため使っていません（Issue #78）。

### 記録する / しない

```
<-- GET /api/search
--> GET /api/search 200 12ms
```

| 項目 | 記録 |
| --- | --- |
| method / pathname / status / 処理時間 | する |
| allowlist の query（`limit` / `maxPerVersion` / `scope` / `regex`） | する |
| 上記以外の query | **しない**（名前ごと落とす） |

**allowlist 方式である点が重要です。** denylist だと、新しい query parameter を足したときに黙って漏れます。ログへ出したい項目ができたら、値が機密でないことを確認したうえで `LOGGED_QUERY_PARAMS` に足してください。以下は入れてはいけません（テストで固定しています）。

- OIDC の `code` / `state` — 認可コードは短命かつ PKCE 前提とはいえ、認証材料をログに残す必要はない
- 検索語 `q`、`customer` / `hostname` / `ip` — 業務データそのもの
- `returnTo` — 利用者の画面遷移

値は制御文字を除去し長さを切り詰めてから出します。改行を含む値で偽のログ行を差し込めないようにするためです。

### 保持期間・転送先・閲覧権限

| 項目 | 現状 |
| --- | --- |
| 出力先 | プロセスの標準出力 → fly.io のログストリーム |
| 保持期間 | fly.io 組み込みのログのみ。直近を `fly logs` で見るための短期保持で、長期保存は保証されない |
| 外部転送 | **なし**（log shipper / SIEM への転送は未設定） |
| 閲覧権限 | fly.io org のメンバー、および org へアクセスできる token の保持者 |

```bash
fly logs --app config-manager
```

**外部へ転送する場合の前提**: 転送先でも保持期間と閲覧権限を明示的に定めてください。アクセスログ自体は上記のとおり機密値を含みませんが、pathname と時刻の組み合わせは利用状況の情報になります。転送を始めたらこの表を更新してください。

なお、業務操作の記録は Kintone の作業履歴アプリ（[監査ログと異常検知](#監査ログと異常検知)）が正本です。アクセスログは運用診断用で、監査証跡としては扱いません。

---

## 依存関係の脆弱性スキャン

| 仕組み | 内容 |
| --- | --- |
| Dependabot | `.github/dependabot.yml` — npm / Go modules / GitHub Actions を平日 9:00 JST に確認し、更新 PR を作成 |
| 日次 audit | `.github/workflows/security-audit.yml` — 土日を含む毎日 9:00 JST に pnpm audit、`govulncheck`、`zizmor` を実行 |
| PR CI | `.github/workflows/ci.yml` — baseline-aware pnpm audit と、helper 変更時の `govulncheck` をマージ前に必須実行 |
| 自動マージ | `.github/workflows/dependabot-auto-merge.yml` — Dependabot の minor / patch のみ、必須 CI 成功後に squash merge |

Dependabot の `daily` は GitHub の仕様上、平日のみ実行されます。土日を含む「毎日」の検知は日次 audit が担い、修正版がある脆弱性は有効化済みの Dependabot security updates でも PR 化します。commit SHA に固定した GitHub Actions は Dependabot alerts の対象外になるため、`zizmor` のオンライン監査で GitHub Advisory Database と照合します。major 更新、分類不能な更新、CI に失敗した更新は自動マージしません。

### 期限付き baseline（2026-11-30 まで）

| パッケージ | Advisory | 深刻度 | 理由 |
| --- | --- | --- | --- |
| `xlsx` | `GHSA-4r6h-8v6p-xvw6` / `CVE-2023-30533` | high (Prototype Pollution) | npm に修正版がなく、任意ファイルの読み込みには使用していない。代替ライブラリ移行を期限までに再評価 |
| `xlsx` | `GHSA-5pgg-2g8v-p4x9` / `CVE-2024-22363` | high (ReDoS) | npm に修正版がなく、任意ファイルの読み込みには使用していない。代替ライブラリ移行を期限までに再評価 |

正本は `.github/security-audit-baseline.json` です。`scripts/check-pnpm-audit.mjs` は package / severity / GHSA / CVE がすべて一致し、かつ期限内の項目だけを許容します。新規 High / Critical、監査エラー、baseline の期限切れは CI と日次 audit を失敗させます。例外が解消した場合は、確認後に baseline から削除してください。

### トリアージ方針

1. **Critical / High**: 原則その PR または当日中に更新。defer する場合は Issue を切り理由・期限を書く
2. **Moderate**: 次回依存更新 PR に含める。悪用条件が自環境に無い場合は defer 可
3. **Low / 情報**: まとめて四半期で対応してよい
4. **例外（fix が無い / 誤検知）**: advisory URL、判断理由、対象識別子、期限を `.github/security-audit-baseline.json` に明示し、レビューを経て追加する
5. **Go**: `govulncheck` が到達可能な脆弱性を検出した場合は深刻度によらず更新または明示的なトリアージを行う

ローカル確認:

```bash
pnpm audit:security
pnpm test:audit-gate
(cd apps/helper && govulncheck ./...)
```

---

## SESSION_SECRET / エラーメッセージ

### SESSION_SECRET

- `AUTH_MODE=oidc` 時は **32 文字以上**の高エントロピー値が必須
- プレースホルダ（`change-me-to-a-long-random-string` 等）は起動失敗
- 生成: `openssl rand -base64 32`

### 本番エラーメッセージ

- `NODE_ENV=production` では API 500/502 応答に内部例外メッセージを載せない
- 詳細はサーバーログ（`[api-error]` / `[unhandled]`）のみ
- 開発時は従来どおり detail を返す
