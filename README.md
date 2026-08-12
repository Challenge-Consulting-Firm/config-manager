# NW Config Manager

NW 機器のコンフィグを世代管理するシステム。

- **フロントエンド**: React + Vite + Tailwind（fly.io の BFF から配信）
- **BFF**: Node.js + Hono（fly.io にデプロイ）
- **バックエンド**: Kintone（REST API トークン認証）
- **認証**: Entra ID（OIDC Authorization Code + PKCE）

## アーキテクチャ

```
Browser ──(OIDC)──> Entra ID
   │  (sealed cookie session)
   ▼
BFF on fly.io (Hono)  ──(API token)──>  Kintone
   │
   └── serves React SPA build assets
```

Kintone の API トークンをブラウザに晒さないため、fly.io 上の BFF が API キーを保持して Kintone REST API を呼び出します。Entra ID 認証（OIDC）も BFF で完結し、ログイン後に取得したユーザー情報を作業履歴（Kintone 監査アプリ）の記録に使います。

## 機能

- Entra ID でログイン（SSO）。ログインユーザーを作業履歴に自動記録。
- コンフィグの世代管理（同一デバイス・同一内容の重複アップロードはスキップ）。
- ドラッグ & ドロップでアップロード（`.conf` / `.cfg` / `.txt` / `.log`）。
- アップロード時に **コメント行・空白行・末尾空白** を除去して SHA-256 を計算し、実質的な変更だけを世代として残す。
- Web 上で任意の 2 世代を Diff 表示（サイドバイサイド、`+/-` 表示、パッチ形式でダウンロード可）。
- **FWポリシー / ACL マトリクス**：コンフィグからFWルール・ACLを抽出し、一覧表示・送信元×宛先マトリクス表示・Excel/CSV出力が可能（Cisco IOS/IOS-XE/NX-OS/ASA、Juniper、Fortinet、YAMAHA RT `ip filter` / SWX `access-list` に対応）。
- **ルーティングテーブル可視化**：コンフィグからスタティックルート・接続インターフェース・OSPF/BGP サマリを抽出し、ルート一覧・プロトコル别マトリクス表示・Excel/CSV出力が可能。Excel出力には「Routes」「Matrix」「Protocol Summary」の 3 シートが含まれます。
- **Meraki 設定の取得（MR/MX/MS）**：Meraki Dashboard API からネットワーク単位で設定を取得し、既存の世代管理に保存します。ネットワーク ID と API キーを入力するだけで、MX（appliance）/ MS（switch）/ MR（wireless）の VLAN・FW・ポート・SSID・ルーティング等を一括取得してテキスト化し、手動アップロードと同じく世代比較・FW抽出・履歴管理が利用できます。**接続情報（ネットワーク ID + API キー）は複数登録して再利用可能**。
- 識別子として **顧客・IPアドレス・ホスト名・用途・シリアル番号・稼働区分（本番/予備）** を持つ。
- **本番/予備のタグ管理**。予備機は「本番への昇格」アクションで、最新コンフィグを本番新世代として登録可能（故障時差し替えを想定）。
- **予備機の登録**：本番機の詳細画面の「予備機を登録」から、対象機器（顧客・ホスト名）を引き継いで予備機を登録できる。予備機は**シリアル番号のみ必須**で、ホスト名・IPアドレス・コンフィグは任意（コンフィグは後から「新世代アップロード」で追加してもDiff可能）。
- **本番↔予備比較**：同じ顧客・ホスト名の本番機と予備機の最新コンフィグを1クリックで Diff 表示。
- **OS／機種の自動識別**：アップロード時にコンフィグからベンダー・OS・バージョン・機種を自動抽出（Cisco IOS/IOS-XE/NX-OS/ASA、Juniper Junos、YAMAHA、Arista EOS、Fortinet FortiOS、Mikrotik RouterOS に対応）。
- 機器一覧は **スペース区切りAND検索**（顧客・ホスト名・IP・用途・シリアルが対象）。
- Kintone 監査アプリに「誰がいつ何をしたか」を記録。

## Kintone アプリ定義

3 つのアプリ（**コンフィグ管理** / **作業履歴** / **Meraki 接続情報（任意）**）を使います。各フィールドの定義（フィールド種類・フィールドコード・ラベル）は `scripts/kintone/config-app-fields.json`・`audit-app-fields.json`・`meraki-app-fields.json` に正則として持っています。フィールドコードはプログラム（`apps/bff/src/kintone.ts`）が読み書きに使うため、**JSON 定義と完全一致させる必要**があります。作成手順は後述の「セットアップ手順 > B」を参照してください。

Meraki 接続情報アプリは任意です。未設定の場合でも「Meraki 取得」画面で都度入力により機能します（ただし接続情報の保存・再利用はできません）。

本システムは **API トークン** で Kintone REST API を呼ぶため、Kintone 側のログイン方法（パスワード / SAML・Entra ID）は問いません。

## セットアップ手順

> ローカル検証を先行する場合は「A → B → C」の順で進め、Entra ID（手順 D・E）は後回しで OK です。

### A. リポジトリの依存を入れる

```bash
pnpm install
```

### B. Kintone アプリとフィールドを作る

#### B-1. 空のアプリを 2〜3 つ作る

Kintone ポータルから、**フィールド未定義の空アプリ**を作成します（アプリ名は自由）。

1. 「NW コンフィグ管理」アプリを作成 → アプリ ID をメモ
2. 「NW 作業履歴」アプリを作成 → アプリ ID をメモ
3. （Meraki 連携時）「Meraki 接続情報」アプリを作成 → アプリ ID をメモ

> 既存アプリ（例: コンフィグ管理 = 338）を流用する場合、そのアプリ ID を使ってください。ただし既存フィールドとコードが重複するとエラーになることがあります。

#### B-2. フィールドコードを一括作成する（推奨）

`scripts/kintone/*.json` にフィールド定義があります（コード・種類・ラベル）。これを Kintone に反映するスクリプトを用意しています。

**認証:** スクリプトは各アプリの **API トークン**（`X-Cybozu-API-Token`）でフィールド作成を実行します。Kintone ユーザーの ID/パスワードは不要です。ただしフォーム設定（preview API）を呼ぶため、対象アプリの **API トークンで「アプリ管理」権限を有効** にする必要があります（「設定 > APIトークン」で生成後に「アプリを更新」を忘れないこと）。

`.env` に以下を設定します（B-1 でメモしたアプリ ID と、各アプリで発行した API トークン）:

```env
KINTONE_DOMAIN=xxx.cybozu.com
KINTONE_CONFIG_APP_ID=338
KINTONE_CONFIG_APP_TOKEN=（コンフィグ管理アプリの API トークン）
KINTONE_AUDIT_APP_ID=339
KINTONE_AUDIT_APP_TOKEN=（作業履歴アプリの API トークン）
# 以下は Meraki 連携時のみ:
KINTONE_MERAKI_APP_ID=340
KINTONE_MERAKI_APP_TOKEN=（Meraki 接続情報アプリの API トークン）
```

実行:

```bash
node scripts/setup-kintone.mjs --app all      # 全アプリ（Meraki 含む）
# または個別:
node scripts/setup-kintone.mjs --app config
node scripts/setup-kintone.mjs --app audit
node scripts/setup-kintone.mjs --app meraki
```

スクリプトはプレビュー環境にフィールドを追加し、運用環境へ反映します。

#### B-3. 手動で作る場合（SAML 専用ドメインなど）

各アプリの「フォーム」設定で、下表の **フィールド種類** でフィールドを追加し、**フィールドコード** を正確に入力してください（コードはプログラムがこの名前で読み書きします）。

**コンフィグ管理アプリ:**

| フィールド名 | 種類 | フィールドコード |
| --- | --- | --- |
| 顧客 | 文字列(1行) | `customer` |
| ホスト名 | 文字列(1行) | `hostname` |
| IPアドレス | 文字列(1行) | `ip_address` |
| 用途 | 文字列(1行) | `purpose` |
| 世代番号 | 数値 | `generation` |
| コンフィグ本文 | 文字列(複数行) | `body` |
| ハッシュ | 文字列(1行) | `hash` |
| 作業者 | 文字列(1行) | `operator` |
| 作業者メール | 文字列(1行) | `operator_email` |
| メモ | 文字列(複数行) | `note` |
| サイズ | 数値 | `size` |
| 行数 | 数値 | `lines` |
| FWポリシー抽出結果（JSON） | 文字列(複数行) | `fw_rules_json` |
| ルーティング抽出結果（JSON） | 文字列(複数行) | `routing_routes_json` |
| 無線SSID/AP抽出結果（JSON） | 文字列(複数行) | `wireless_json` |

**作業履歴アプリ:**

| フィールド名 | 種類 | フィールドコード |
| --- | --- | --- |
| 作業者 | 文字列(1行) | `operator` |
| 作業者メール | 文字列(1行) | `operator_email` |
| 操作 | ドロップダウン | `action` |
| 顧客 | 文字列(1行) | `customer` |
| ホスト名 | 文字列(1行) | `hostname` |
| 世代番号 | 数値 | `generation` |
| 詳細 | 文字列(複数行) | `detail` |

`action` ドロップダウンの選択肢は **6 つすべて** を追加してください（値＝ラベル）:
`upload`, `view`, `diff`, `download`, `delete`, `edit`

**Meraki 接続情報アプリ**（任意・Meraki 連携時のみ）:

| フィールド名 | 種類 | フィールドコード |
| --- | --- | --- |
| 表示名 | 文字列(1行) | `label` |
| ネットワークID | 文字列(1行) | `network_id` |
| APIキー | 文字列(1行) | `api_key` |
| デフォルト顧客 | 文字列(1行) | `default_customer` |
| デフォルトホスト名 | 文字列(1行) | `default_hostname` |
| メモ | 文字列(複数行) | `memo` |

> **APIキーは `CREDENTIALS_ENCRYPTION_KEY` 設定時に AES-256-GCM で暗号化して保存されます**（未設定時のみ平文）。詳細は [`docs/SECURITY.md`](docs/SECURITY.md#meraki-api-キーの暗号化)。

#### B-4. API トークンの権限設計

Kintone では API トークンごとに権限を設定します。本システムでは **運用用** と **セットアップ用** の 2 種類に分けて運用します。

> **「アプリ作成者」や他ユーザーへの権限付与は不要です**。Kintone のアクセス制御のうち、API 経由では **API トークンの権限設定のみ** が効きます（アプリのアクセス権・レコードのアクセス権は無関係）。API トークンを生成したユーザーがアプリ作成者でなくても、トークンに付与した権限だけで動作します。

##### 運用用トークン（BFF が常時使用）

各アプリで以下の権限を持つ API トークンを生成し、`.env` に設定します。

| アプリ | レコード閲覧 | レコード追加 | レコード編集 | レコード削除 | 必要な env 変数 |
| --- | :---: | :---: | :---: | :---: | --- |
| **コンフィグ管理** | ✅ | ✅ | ✅ | — | `KINTONE_CONFIG_APP_TOKEN` |
| **作業履歴** | ✅ | ✅ | — | — | `KINTONE_AUDIT_APP_TOKEN` |
| **Meraki 接続情報** | ✅ | ✅ | ✅ | ✅ | `KINTONE_MERAKI_APP_TOKEN` |

> 各アプリで **「アプリ管理」権限は付けないでください**。運用用トークンはレコード操作のみ可能で十分です。後述のように、セットアップ時だけ別途「アプリ管理」権限付きのトークンを一時的に使います。

> Meraki 接続情報アプリだけ **レコード削除権限** が必要です（接続情報の削除機能が存在するため）。コンフィグ管理・作業履歴はレコードを削除しないため不要です。

```env
KINTONE_CONFIG_APP_TOKEN=（コンフィグ管理の運用用トークン）
KINTONE_AUDIT_APP_TOKEN=（作業履歴の運用用トークン）
KINTONE_MERAKI_APP_TOKEN=（Meraki 接続情報の運用用トークン・Meraki 連携時のみ）
```

##### セットアップ用トークン（フィールド定義作成時のみ一時使用）

`scripts/setup-kintone.mjs` でフィールドを一括作成する際は、**対象アプリで「アプリ管理」権限** を持つ API トークンが必要です（フォーム設定 = preview API の呼び出しに必要）。

```bash
# 1. 各アプリの「設定 > APIトークン」で: 生成 →「アプリ管理」にチェック → アプリを更新
# 2. .env をセットアップ用トークンに一時的に書き換え
# 3. スクリプト実行
node scripts/setup-kintone.mjs --app all
# 4. 完了後、すぐに Kintone 側でこのトークンを削除（重要）
# 5. .env を運用用トークンに戻す
```

> 「アプリ管理」権限はフィールド定義の変更・アプリの運用環境反映までできる強力な権限です。漏洩時の被害を最小化するため、セットアップ完了後は即座に削除してください。

##### トークンのローテーション

詳細な手順は [`docs/DEPLOY.md` の「Kintone API トークンのローテーション」](docs/DEPLOY.md#kintone-api-トークンのローテーション) を参照してください。主なポイント:

- **四半期に 1 回程度** の定期ローテーションを推奨
- ローテーションは「新トークン生成 → .env 更新 → `fly secrets set` → 旧トークン削除」の手順
- 旧トークンの削除を忘れると、漏洩時に無効化できません

### C. 環境変数とローカル検証

`.env.example` をコピーして `.env` を作り、値を埋めます。

```bash
cp .env.example .env
```

主要な変数:

| 変数 | 説明 |
| --- | --- |
| `AUTH_MODE` | `disabled` で Entra ID をバイパス（**ローカル検証専用**）。`NODE_ENV=production` では起動失敗する。本番は必ず `oidc` |
| `LOCAL_DEV_USER_NAME` / `LOCAL_DEV_USER_EMAIL` | `AUTH_MODE=disabled` 時に記録されるダミー作業者 |
| `KINTONE_DOMAIN` | `xxx.cybozu.com` |
| `KINTONE_CONFIG_APP_ID` / `KINTONE_CONFIG_APP_TOKEN` | コンフィグ管理アプリ |
| `KINTONE_AUDIT_APP_ID` / `KINTONE_AUDIT_APP_TOKEN` | 作業履歴アプリ |
| `KINTONE_MERAKI_APP_ID` / `KINTONE_MERAKI_APP_TOKEN` | Meraki 接続情報アプリ（任意・未設定時は都度入力のみ） |
| `CONFIG_COMMENT_PREFIXES` | コメント行接頭辞。既定 `!`（Cisco）。Juniper は `#` など |
| `MERAKI_API_KEY` | Meraki Dashboard API キー（省略可）。未設定時は取得画面で都度入力 |
| `MERAKI_API_BASE` | Meraki API のベース URL。既定 `https://api.meraki.com/api/v1`。中国リージョン等では要変更 |
| `MERAKI_TIMEOUT_MS` / `MERAKI_MAX_RETRIES` | Meraki API 呼び出しのタイムアウトと 429 時のリトライ回数 |
| `ENTRA_*` / `SESSION_SECRET` | `AUTH_MODE=oidc` の時のみ必須。`SESSION_SECRET` は 32 文字以上の高エントロピー値 |
| `ENTRA_GROUP_ADMIN_IDS` / `ENTRA_GROUP_OPERATOR_IDS` / `ENTRA_GROUP_VIEWER_IDS` | 任意。Entra グループ ID による RBAC（admin/operator/viewer）。未設定時は認証ユーザー全員を admin 扱い |
| `LOCAL_DEV_USER_ROLE` | `AUTH_MODE=disabled` 時のダミーユーザー権限。`viewer` / `operator` / `admin`（既定 `admin`） |
| `CREDENTIALS_ENCRYPTION_KEY` | 任意（本番 + Meraki 接続情報アプリ利用時は推奨）。Meraki API キーを Kintone 保存時に AES-256-GCM 暗号化。`openssl rand -base64 32` |

#### C-1. ローカルコンテナで検証（推奨）

```bash
# イメージをビルド
docker build -t cm-local .

# コンテナを起動（.env を読み込ませる）
docker run --rm -p 3000:3000 --env-file .env cm-local
```

ブラウザで http://localhost:3000 を開きます。`AUTH_MODE=disabled` ならログイン不要で、ダミーユーザーとして操作できます（**本番では使用禁止**。`NODE_ENV=production` と同時指定すると BFF は起動しません）。コンフィグのアップロード・Diff 表示を試せます。

#### C-2. 開発サーバで検証（HMR を使う場合）

```bash
pnpm dev   # BFF(3000) + Vite(5173) が並列起動
```

ブラウザで http://localhost:5173 を開きます。

### D. Entra ID 側のアプリ登録（本番認証時に実施）

1. Entra ID > App registrations > New registration。
2. リダイレクト URI: Web プラットフォームで `http://localhost:3000/auth/callback`（開発）と `https://<your-fly-app>.fly.dev/auth/callback`（本番）を追加。
3. Client credentials からクライアントシークレットを生成 → `ENTRA_CLIENT_SECRET`。
4. API のアクセス許可: `Microsoft Graph` の `GroupMember.Read.All`（グループ制限をする場合）、`openid`/`profile`/`email`/`offline_access`。
5. （任意）特定グループに制限する場合、グループの Object ID を `ENTRA_REQUIRED_GROUP_IDS` に。
6. `.env` の `AUTH_MODE` を `oidc` に戻し、`ENTRA_*` と `SESSION_SECRET`（`openssl rand -base64 32`）を埋める。

### E. fly.io へのデプロイ（本番認証時に実施）

標準手順は **[`docs/DEPLOY.md`](docs/DEPLOY.md)** に切り出しています。以下は最小限の早見表です。

```bash
# 1. 初回のみ: fly アプリ作成 (fly.toml を維持)
fly launch --no-deploy --name config-manager

# 2. シークレットを個別設定 (詳細は docs/DEPLOY.md)
fly secrets set --app config-manager AUTH_MODE=oidc
fly secrets set --app config-manager NODE_ENV=production
fly secrets set --app config-manager PUBLIC_BASE_URL=https://config-manager.fly.dev
fly secrets set --app config-manager SESSION_SECRET=$(openssl rand -base64 32)
fly secrets set --app config-manager CREDENTIALS_ENCRYPTION_KEY=$(openssl rand -base64 32)  # Meraki 接続情報利用時
fly secrets set --app config-manager ENTRA_TENANT_ID=...
fly secrets set --app config-manager ENTRA_CLIENT_ID=...
fly secrets set --app config-manager ENTRA_CLIENT_SECRET=...
fly secrets set --app config-manager ENTRA_REDIRECT_URI=https://config-manager.fly.dev/auth/callback
fly secrets set --app config-manager KINTONE_DOMAIN=...
fly secrets set --app config-manager KINTONE_CONFIG_APP_ID=...
fly secrets set --app config-manager KINTONE_CONFIG_APP_TOKEN=...
fly secrets set --app config-manager KINTONE_AUDIT_APP_ID=...
fly secrets set --app config-manager KINTONE_AUDIT_APP_TOKEN=...

# 3. デプロイ + ヘルスチェック
bash scripts/fly-deploy.sh
```

`scripts/fly-deploy.sh` は以下を提供します:

| 操作 | コマンド |
| --- | --- |
| 通常デプロイ | `bash scripts/fly-deploy.sh` |
| 個別シークレット設定 (+ デプロイ) | `bash scripts/fly-deploy.sh --set-secret KEY=VALUE` |
| ロールバック | `bash scripts/fly-deploy.sh --rollback` |

> ⚠️ **`.env` からの全体一括同期 (旧 `--sync-secrets`) は廃止しました。** ローカル開発用の `.env` (`AUTH_MODE=disabled` 等) で本番シークレットを上書きしてしまう事故を防ぐため、シークレットは必ず個別に設定してください。

> `PUBLIC_BASE_URL` と `ENTRA_REDIRECT_URI` は fly.io の HTTPS URL に合わせてください。これらは Entra ID アプリ登録のリダイレクト URI とも一致する必要があります。ロールバック時の注意・トラブルシューティング・CI/CD 連携は `docs/DEPLOY.md` を参照してください。

### F. Meraki 連携（省略可）

Meraki Dashboard API 経由で MR/MX/MS の設定を取得して世代管理に取り込む場合は、以下を準備します。

> **API キー・組織 ID・ネットワーク ID の取得手順は [`docs/MERAKI.md`](docs/MERAKI.md) にまとめています**。初めて Meraki API を使う場合は先にそちらを参照してください。

1. Meraki Dashboard の **Organization > Settings > API** で API アクセスを有効化し、API キーを生成（`docs/MERAKI.md` の「API キーの取得」）。
2. 取得対象の **ネットワーク ID** を確認（Dashboard の Network > Settings、または `GET /organizations/{orgId}/networks`）。組織 ID の取り方は `docs/MERAKI.md` の「組織 ID の取得」。
3. **接続情報アプリ**（推奨・任意）を作成:
   - Kintone で空のアプリを作り、`scripts/kintone/meraki-app-fields.json` を使ってフィールドを生成:
     ```bash
     # .env に KINTONE_MERAKI_APP_ID と KINTONE_MERAKI_APP_TOKEN を追加したうえで
     node scripts/setup-kintone.mjs --app meraki
     ```
   - 「接続情報」ページからネットワーク ID・API キー・デフォルト顧客・ホスト名をセットで登録しておくと、取得時に再利用できます。
4. **API キーの場所**は以下のいずれかを選択:
   - **環境変数**: `.env` に `MERAKI_API_KEY=...`、本番は `fly secrets set MERAKI_API_KEY=...`。全ネットワーク共通で使う場合に便利。
   - **接続情報アプリ**: ネットワーク毎に異なる API キーを使う場合はこちら。`CREDENTIALS_ENCRYPTION_KEY` 設定時は AES-256-GCM で暗号化保存（[`docs/SECURITY.md`](docs/SECURITY.md)）。
   - **都度入力**: 「Meraki 取得」画面で每回入力（環境変数未設定時のみ）。
5. 機器一覧の「Meraki 取得」ボタン、またはサイドメニューの「Meraki 取得」から取得を実行。

取得対象はネットワークの `productTypes` から自動判定され、`appliance`（MX）/ `switch`（MS）/ `wireless`（MR）それぞれの主要エンドポイントを並列取得します。取得結果は1つのテキストにシリアライズされ、手動アップロードと同じく正規化・重複スキップ判定・世代登録・FW/ルーティング抽出・監査ログ記録が走ります。一部エンドポイントの取得に失敗しても全体は統了し、失敗详情は結果パネルに表示されます。

> **セキュリティ注意**:
> - 都度入力・環境変数の API キーは Meraki Dashboard への読み取り要求にのみ使われ、Kintone やログには保存されません。
> - **接続情報アプリに保存した API キー**は、`CREDENTIALS_ENCRYPTION_KEY` 設定時に `enc:v1:...` 形式で暗号化されます。一覧画面では末尾 4 文字のみ表示。鍵未設定時は平文のため本番では必ず鍵を設定してください。

### G. ローカル取得（Telnet / SSH・ヘルパーアプリ・省略可）

社内 LAN 上の NW 機器から Telnet または SSH でコンフィグを自動取得する場合は、**ローカル取得ヘルパー（Go 製ポータブルアプリ）** を使います。ブラウザ単体では生 TCP（Telnet 23番 / SSH 22番）を開けないため、ユーザー PC 上で動くヘルパーが `127.0.0.1` で待ち受けて SPA からの要求を中継します。詳細な設計経緯は Issue #43 の最終コメントを参照。

> **ヘルパーのビルド・仕様は [`apps/helper/README.md`](apps/helper/README.md) にまとめています。**

1. **配布バイナリのビルド**: リリース担当者が `scripts/build-helper.sh` を実行し、Windows / macOS universal バイナリと `latest.json` を生成します。
   ```bash
   ./scripts/build-helper.sh 0.1.0
   # 成果物は apps/bff/public/downloads/helper/ 配下へ（または GitHub Releases へ）
   ```
   - `HELPER_RELEASE_BASE_URL` 環境変数で GitHub Releases の URL を指定すると、`latest.json` の URL を絶対 URL に切替えられます（社内 PC が github.com へ到達可能な場合）。
2. **ユーザー側の初回セットアップ**: SPA の「ローカル取得」メニューからセットアップ画面を開き、お使いの OS 向けバイナリを DL → ダブルクリック起動 → 接続テストで検出を確認します。
3. **日常運用**: 機器詳細画面で「Telnet / SSH で取得」ボタンを押し、接続情報（プロトコル・ホスト・ポート・ユーザー名・パスワード・enable パスワード・機種）を入力して取得します。取得した本文は既存 `/api/upload` フロー（same-origin + cookie セッション）で世代登録され、同一 hash はスキップされます。
4. **利用後**: SPA の「停止」ボタン、またはコンソールウィンドウを閉じてヘルパーを終了してください（ポータブル型のため、ファイル削除だけで完全に撤去できます）。

**対応プロトコル**: Telnet（既定ポート 23）と SSH（既定ポート 22）。SSH はパスワード認証（機器が要求する場合は keyboard-interactive）に対応し、旧世代機向けに SHA-1 系鍵交換・CBC 暗号・`ssh-rsa` ホスト鍵を低優先で許可します。

**対応機種**: Cisco IOS / IOS-XE（`terminal length 0` + `show running-config`）、YAMAHA RT（`show config`）。その他はカスタムコマンド指定で取得可能です。

> **セキュリティ注意**:
> - Telnet は平文プロトコルです。LAN 上でパスワードが平文で流れます。機器が SSH に対応している場合は SSH を選んでください（Telnet を使う場合は社内ポリシー上許可されていることを確認してください）。
> - SSH のホスト鍵は初回接続時にヘルパーの `known_hosts`（`os.UserConfigDir()/config-manager-helper/known_hosts`）へ記録され、以降は一致を検証します。不一致時は取得を中断します（`host_key_mismatch`）。機器の交換・初期化で鍵が変わった場合は該当行を削除してから再取得してください。
> - パスワード・enablePassword はヘルパーとの通信にのみ使われ、**BFF には送信されません**（取得したコンフィグ本文のみを SPA → BFF へ送ります）。
> - ヘルパーは `127.0.0.1` のみで待ち受け、許可 Origin（`PUBLIC_BASE_URL` + 開発用 localhost）以外からの要求は拒否します。

## コンフィグ正規化ルール

`apps/.../shared/normalize.ts` で実装。`CONFIG_COMMENT_PREFIXES`（既定 `!`）で始まる行・空白行・末尾空白を除去し、Cisco IOS の `Building configuration...` / `Current configuration:` ヘッダを取り除いたうえで SHA-256 を計算します。ベンダ別のコメント書式は設定で追加できます（例: `!,#`）。

## プロジェクト構成

```
config-manager/
├── apps/
│   ├── bff/        # Hono BFF（OIDC 認証 + Kintone REST クライアント + SPA 配信）
│   │   ├── src/
│   │   │   ├── api.ts        # /api/* ルート
│   │   │   ├── config.ts     # 環境変数ローダ
│   │   │   ├── entra.ts      # Entra ID OIDC ヘルパ
│   │   │   ├── index.ts      # エントリ + /auth/* ルート + SPA 配信
│   │   │   ├── kintone.ts    # Kintone REST クライアント
│   │   │   ├── meraki.ts     # Meraki Dashboard API クライアント（取得のみ）
│   │   │   └── session.ts    # sealed-cookie セッション
│   │   └── scripts/copy-assets.js
│   └── web/        # React + Vite + Tailwind
│       └── src/
│           ├── pages/        # 機器一覧 / 詳細 / アップロード / Meraki 取得 / Meraki 接続情報 / Diff / FWマトリクス / ルーティング / 履歴
│           ├── components/DiffViewer.tsx
│           └── utils/        # firewallExport.ts / routingExport.ts
├── packages/
│   └── shared/     # 型定義 + 正規化ロジック + LCS ベース diff + OS/機種識別 + FW抽出 + ルーティング抽出 + Meraki シリアライズ
├── scripts/
│   ├── setup-kintone.mjs          # Kintone アプリのフィールド一括作成
│   ├── fly-deploy.sh              # fly.io 標準デプロイスクリプト
│   └── kintone/                   # フィールド定義 JSON（config / audit / meraki）
├── docs/
│   ├── DEPLOY.md                  # fly.io デプロイ手順書・シークレット・ローテーション
│   ├── MERAKI.md                  # Meraki API キー・組織 ID・ネットワーク ID の取得手順
│   └── SECURITY.md                # RBAC・暗号化・監査・依存脆弱性の運用ガイド
├── Dockerfile
├── fly.toml
└── .env.example
```

## 制限事項 / 今後の拡張候補

- ID トークンをデコードするだけで署名検証は最低限。BFF が信頼する HTTPS トークンエンドポイント経由でのみトークンを取得しているため実用上は安全ですが、厳密には JWKS 検証を追加するとより強固です。
- 大容量コンフィグ（数百 KB 超）の場合は Kintone のフィールドサイズ上限（文字列複数行は 1 レコードあたり 10MB まで、ただし REST では推奨 64KB 程度）に注意してください。
- コンフィグ本文は平文で Kintone に保存します。機密情報（PSK など）のマスキングが必要な場合は、正規化ロジックに追加してください。
- ルーティング抽出はベストエフォートです。OSPF/BGP はサマリ情報（エリア番号・AS番号・ネイバー・`network` 宣言）を抽出し、実際の学習経路（show ip route の出力）はコンフィグからは取れないため含まれません。複雑な再配送や route-map は raw 行としてのみ記録されます。
- **Meraki 設定の取得**は Dashboard API から JSON を取得してテキストへシリアライズしています。Meraki はクラウド側で API 応答のキー順や項目を変更することがあるため、同一設定でも取得每にテキストが変わり見かけ上の「差分」が発生する場合があります。これは Meraki 側の応答仕様に起因する制約です。
