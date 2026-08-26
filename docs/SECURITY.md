# セキュリティ運用ガイド

脆弱性診断フォローアップ（Epic #9）で入れた対策の運用メモです。
デプロイ手順の詳細は [DEPLOY.md](./DEPLOY.md) を参照してください。

## 目次

- [認証・RBAC](#認証rbac)
- [セッション](#セッション)
- [Meraki API キーの暗号化](#meraki-api-キーの暗号化)
- [機器認証情報の引き換え](#機器認証情報の引き換え)
- [監査ログと異常検知](#監査ログと異常検知)
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

未設定時は認証ユーザー全員を **admin** 扱い（後方互換）。本番では必ず設定してください。起動時に warn が出ます。

---

## セッション

### 現状

- Cookie: iron-session による sealed cookie（`HttpOnly` + `Secure` + 確立後 `SameSite=Lax`）
- ログイン時に opaque な `sid` を発行
- ログアウト時にプロセス内 denylist へ `sid` を登録 → 以降その cookie は 401

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
