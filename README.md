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
- **FWポリシー / ACL マトリクス**：コンフィグからFWルール・ACLを抽出し、一覧表示・送信元×宛先マトリクス表示・Excel/CSV出力が可能（Cisco IOS/IOS-XE/NX-OS/ASA、Juniper、Fortinet、YAMAHA に対応）。
- **ルーティングテーブル可視化**：コンフィグからスタティックルート・接続インターフェース・OSPF/BGP サマリを抽出し、ルート一覧・プロトコル別マトリクス表示・Excel/CSV出力が可能。Excel出力には「Routes」「Matrix」「Protocol Summary」の 3 シートが含まれます。
- 識別子として **顧客・IPアドレス・ホスト名・用途・シリアル番号・稼働区分（本番/予備）** を持つ。
- **本番/予備のタグ管理**。予備機は「本番への昇格」アクションで、最新コンフィグを本番新世代として登録可能（故障時差し替えを想定）。
- **本番↔予備比較**：同じ顧客・ホスト名の本番機と予備機の最新コンフィグを1クリックで Diff 表示。
- **OS／機種の自動識別**：アップロード時にコンフィグからベンダー・OS・バージョン・機種を自動抽出（Cisco IOS/IOS-XE/NX-OS/ASA、Juniper Junos、YAMAHA、Arista EOS、Fortinet FortiOS、Mikrotik RouterOS に対応）。
- 機器一覧は **スペース区切りAND検索**（顧客・ホスト名・IP・用途・シリアルが対象）。
- Kintone 監査アプリに「誰がいつ何をしたか」を記録。

## Kintone アプリ定義

2 つのアプリ（**コンフィグ管理** / **作業履歴**）を使います。各フィールドの定義（フィールド種類・フィールドコード・ラベル）は `scripts/kintone/config-app-fields.json` と `scripts/kintone/audit-app-fields.json` に正則として持っています。フィールドコードはプログラム（`apps/bff/src/kintone.ts`）が読み書きに使うため、**JSON 定義と完全一致させる必要**があります。作成手順は後述の「セットアップ手順 > B」を参照してください。

本システムは **API トークン** で Kintone REST API を呼ぶため、Kintone 側のログイン方法（パスワード / SAML・Entra ID）は問いません。

## セットアップ手順

> ローカル検証を先行する場合は「A → B → C」の順で進め、Entra ID（手順 D・E）は後回しで OK です。

### A. リポジトリの依存を入れる

```bash
pnpm install
```

### B. Kintone アプリとフィールドを作る

#### B-1. 空のアプリを 2 つ作る

Kintone ポータルから、**フィールド未定義の空アプリ**を 2 つ作成します（アプリ名は自由）。

1. 「NW コンフィグ管理」アプリを作成 → アプリ ID をメモ
2. 「NW 作業履歴」アプリを作成 → アプリ ID をメモ

> 既存アプリ（例: コンフィグ管理 = 338）を流用する場合、そのアプリ ID を使ってください。ただし既存フィールドとコードが重複するとエラーになることがあります。

#### B-2. フィールドコードを一括作成する（推奨）

`scripts/kintone/*.json` にフィールド定義があります（コード・種類・ラベル）。これを Kintone に反映するスクリプトを用意しています。

**注意:** フォーム設定（フィールドの追加）は **API トークンでは実行できません**。Kintone ユーザー（アプリ管理権限）の **パスワード認証** が必要です。Kintone が SAML（Entra ID）専用でパスワード認証が無効な場合は B-3 の手動手順を使ってください。

`.env` に以下を設定:

```env
KINTONE_DOMAIN=xxx.cybozu.com
KINTONE_CONFIG_APP_ID=338
KINTONE_AUDIT_APP_ID=339
KINTONE_ADMIN_USERNAME=（アプリ管理権限のある Kintone ユーザー名）
KINTONE_ADMIN_PASSWORD=（上記ユーザーのパスワード）
```

実行:

```bash
node scripts/setup-kintone.mjs --app all      # 両アプリ
# または個別:
node scripts/setup-kintone.mjs --app config
node scripts/setup-kintone.mjs --app audit
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

`action` ドロップダウンの選択肢は **5 つすべて** を追加してください（値＝ラベル）:
`upload`, `view`, `diff`, `download`, `delete`

#### B-4. API トークンを発行する

各アプリの「設定 > APIトークン」で、**レコード閲覧・追加・編集** 権限を持つトークンを生成し（生成後「アプリを更新」を忘れないこと）、`.env` の以下に設定:

```env
KINTONE_CONFIG_APP_TOKEN=...
KINTONE_AUDIT_APP_TOKEN=...
```

### C. 環境変数とローカル検証

`.env.example` をコピーして `.env` を作り、値を埋めます。

```bash
cp .env.example .env
```

主要な変数:

| 変数 | 説明 |
| --- | --- |
| `AUTH_MODE` | `disabled` で Entra ID をバイパス（ローカル検証用）。本番は `oidc` |
| `LOCAL_DEV_USER_NAME` / `LOCAL_DEV_USER_EMAIL` | `AUTH_MODE=disabled` 時に記録されるダミー作業者 |
| `KINTONE_DOMAIN` | `xxx.cybozu.com` |
| `KINTONE_CONFIG_APP_ID` / `KINTONE_CONFIG_APP_TOKEN` | コンフィグ管理アプリ |
| `KINTONE_AUDIT_APP_ID` / `KINTONE_AUDIT_APP_TOKEN` | 作業履歴アプリ |
| `CONFIG_COMMENT_PREFIXES` | コメント行接頭辞。既定 `!`（Cisco）。Juniper は `#` など |
| `ENTRA_*` / `SESSION_SECRET` | `AUTH_MODE=oidc` の時のみ必須 |

#### C-1. ローカルコンテナで検証（推奨）

```bash
# イメージをビルド
docker build -t cm-local .

# コンテナを起動（.env を読み込ませる）
docker run --rm -p 3000:3000 --env-file .env cm-local
```

ブラウザで http://localhost:3000 を開きます。`AUTH_MODE=disabled` ならログイン不要で、ダミーユーザーとして操作できます。コンフィグのアップロード・Diff 表示を試せます。

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

```bash
fly launch            # 初回のみ。fly.toml を上書きしないよう注意
# シークレットを設定
fly secrets set \
  AUTH_MODE=oidc \
  ENTRA_TENANT_ID=... \
  ENTRA_CLIENT_ID=... \
  ENTRA_CLIENT_SECRET=... \
  ENTRA_REDIRECT_URI=https://<your-fly-app>.fly.dev/auth/callback \
  SESSION_SECRET=$(openssl rand -base64 32) \
  KINTONE_DOMAIN=... \
  KINTONE_CONFIG_APP_ID=... \
  KINTONE_CONFIG_APP_TOKEN=... \
  KINTONE_AUDIT_APP_ID=... \
  KINTONE_AUDIT_APP_TOKEN=... \
  NODE_ENV=production \
  PUBLIC_BASE_URL=https://<your-fly-app>.fly.dev

fly deploy
```

> `PUBLIC_BASE_URL` と `ENTRA_REDIRECT_URI` は fly.io の HTTPS URL に合わせてください。これらは Entra ID アプリ登録のリダイレクト URI とも一致する必要があります。

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
│   │   │   └── session.ts    # sealed-cookie セッション
│   │   └── scripts/copy-assets.js
│   └── web/        # React + Vite + Tailwind
│       └── src/
│           ├── pages/        # 機器一覧 / 詳細 / アップロード / Diff / FWマトリクス / ルーティング / 履歴
│           ├── components/DiffViewer.tsx
│           └── utils/        # firewallExport.ts / routingExport.ts
├── packages/
│   └── shared/     # 型定義 + 正規化ロジック + LCS ベース diff + OS/機種識別 + FW抽出 + ルーティング抽出
├── scripts/
│   ├── setup-kintone.mjs          # Kintone アプリのフィールド一括作成
│   └── kintone/                   # フィールド定義 JSON（config / audit）
├── Dockerfile
├── fly.toml
└── .env.example
```

## 制限事項 / 今後の拡張候補

- ID トークンをデコードするだけで署名検証は最低限。BFF が信頼する HTTPS トークンエンドポイント経由でのみトークンを取得しているため実用上は安全ですが、厳密には JWKS 検証を追加するとより強固です。
- 大容量コンフィグ（数百 KB 超）の場合は Kintone のフィールドサイズ上限（文字列複数行は 1 レコードあたり 10MB まで、ただし REST では推奨 64KB 程度）に注意してください。
- コンフィグ本文は平文で Kintone に保存します。機密情報（PSK など）のマスキングが必要な場合は、正規化ロジックに追加してください。
- ルーティング抽出はベストエフォートです。OSPF/BGP はサマリ情報（エリア番号・AS番号・ネイバー・`network` 宣言）を抽出し、実際の学習経路（show ip route の出力）はコンフィグからは取れないため含まれません。複雑な再配送や route-map は raw 行としてのみ記録されます。
