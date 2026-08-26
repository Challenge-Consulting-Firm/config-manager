# デプロイ手順書 (fly.io)

本システム (config-manager) の fly.io デプロイ手順を標準化したドキュメントです。
`scripts/fly-deploy.sh` が本手順を自動化していますが、各ステップの意味と
トラブル時の対応を把握するため、必ず一度目を通してください。

## 目次

- [前提条件](#前提条件)
- [アーキテクチャ概要](#アーキテクチャ概要)
- [初回デプロイ](#初回デプロイ)
- [更新デプロイ](#更新デプロイ)
- [シークレット管理](#シークレット管理)
- [Kintone API トークンの権限設計](#kintone-api-トークンの権限設計)
- [Kintone API トークンのローテーション](#kintone-api-トークンのローテーション)
- [ロールバック](#ロールバック)
- [確認・監視](#確認監視)
- [トラブルシューティング](#トラブルシューティング)
- [CI/CD 連携のヒント](#cicd-連携のヒント)

---

## 前提条件

### 1. ローカル環境

| ツール | 必須バージョン | 確認コマンド |
| --- | --- | --- |
| Node.js | 20 以上 | `node -v` |
| pnpm | 9.0.0 (`packageManager` に固定) | `pnpm -v` |
| Docker | 最新版 (ローカル検証時のみ) | `docker version` |
| fly CLI | 最新版 | `fly version` |

fly CLI のインストール:

```bash
# macOS
brew install flyctl
# その他
curl -L https://fly.io/install.sh | sh
```

### 2. fly.io アカウント

- fly.io アカウントを作成済みであること
- クレジットカード登録済みであること (無料枠でデプロイ可能ですが登録が必要)
- ローカルで `fly auth login` 済みであること

### 3. 外部サービスの準備

以下の外部サービスがセットアップ済みであること (手順は README.md の B・D・F を参照)。

| サービス | 必要なもの | 参照 |
| --- | --- | --- |
| Kintone | コンフィグ管理アプリ・作業履歴アプリの ID と API トークン | README B |
| Kintone (任意) | Meraki 接続情報アプリの ID と API トークン | README F |
| Entra ID | アプリ登録 (client/tenant/secret) とリダイレクト URI | README D |
| Meraki Dashboard (任意) | API キーと取得対象ネットワーク ID | README F |

### 4. リポジトリと env ファイル

```bash
git clone <repo-url> config-manager
cd config-manager
pnpm install
cp .env.example .env
# .env をエディタで開き、実値を埋める
```

> `.env` は `.gitignore` および `.dockerignore` で除外済みです。リポジトリへ commit しないでください。

---

## アーキテクチャ概要

```
Browser ──(OIDC)──> Entra ID
   │  (sealed cookie session)
   ▼
BFF on fly.io (Hono, single machine)  ──(API token)──>  Kintone
   │                                                        ▲
   ├── serves React SPA build assets                        │
   └──(API key)──> Meraki Dashboard API (取得時のみ) ────────┘
```

- **単一マシン** で BFF + SPA 配信を兼ねます (`fly.toml` の `min_machines_running = 0` により、アイドル時は自動停止します)。
- **シークレット** は fly.io の Secrets 機能で保持し、コンテナ起動時に環境変数として注入されます。`.env` ファイルはデプロイされません。
- **永続ストレージ** は持ちません。すべての状態は Kintone に保存されます。

---

## 初回デプロイ

初回は以下の 5 ステップが必要です。`scripts/fly-deploy.sh` を使うことで
ステップ 3〜5 を一括実行できます。

### ステップ 1: fly アプリを作成する

```bash
fly launch --no-deploy --name config-manager
```

- `--no-deploy`: この時点ではデプロイしない (シークレット未設定のため)
- プロンプト `Would you like to tweak these settings before deployment?` → **N** を選択
  - **N を選ばないと fly.toml が上書きされます**。本リポジトリの fly.toml (nrt リージョン・512MB・auto stop 設定済み) を維持してください。
- 既にアプリが存在する場合は `fly launch` をスキップしてください。

> リージョンは `primary_region = 'nrt'` (東京) を推奨します。変更する場合は fly.toml と Entra ID のリダイレクト URI の両方を更新してください。

### ステップ 2: Entra ID 側のリダイレクト URI を追加

本番 URL を Entra ID のアプリ登録に追加します。

```
https://<app-name>.fly.dev/auth/callback
```

- Azure Portal > App registrations > 認証 > プラットフォーム > Web
- リダイレクト URI を追加して保存

### ステップ 3: シークレットを fly.io へ設定

**シークレットは `.env` から一括同期せず、個別に設定してください。**

`.env` はローカル検証用 (`AUTH_MODE=disabled` 等) であり、本番シークレットとは値が異なるフィールドがあるため、一括同期すると本番認証が壊れる事故に繋がります。

以下は個別設定の例 (`https://config-manager.fly.dev` の部分は実際のアプリ URL に置き換えてください):

```bash
# 本番固有の設定 (ローカル .env とは異なる必須の 3 つ)
fly secrets set --app config-manager AUTH_MODE=oidc
fly secrets set --app config-manager NODE_ENV=production
fly secrets set --app config-manager PUBLIC_BASE_URL=https://config-manager.fly.dev
fly secrets set --app config-manager SESSION_SECRET=$(openssl rand -base64 32)
# Meraki 接続情報アプリを使う場合は API キー暗号化鍵も設定（推奨）
fly secrets set --app config-manager CREDENTIALS_ENCRYPTION_KEY=$(openssl rand -base64 32)

# Entra ID
fly secrets set --app config-manager ENTRA_TENANT_ID=00000000-0000-0000-0000-000000000000
fly secrets set --app config-manager ENTRA_CLIENT_ID=00000000-0000-0000-0000-000000000000
fly secrets set --app config-manager ENTRA_CLIENT_SECRET=replace-with-your-secret-value
fly secrets set --app config-manager ENTRA_REDIRECT_URI=https://config-manager.fly.dev/auth/callback

# Kintone
fly secrets set --app config-manager KINTONE_DOMAIN=example.cybozu.com
fly secrets set --app config-manager KINTONE_CONFIG_APP_ID=338
fly secrets set --app config-manager KINTONE_CONFIG_APP_TOKEN=...
fly secrets set --app config-manager KINTONE_AUDIT_APP_ID=339
fly secrets set --app config-manager KINTONE_AUDIT_APP_TOKEN=...
```

> または `scripts/fly-deploy.sh --set-secret KEY=VALUE` を使うと、デプロイも同時に走ります:
> ```bash
> bash scripts/fly-deploy.sh --set-secret AUTH_MODE=oidc
> bash scripts/fly-deploy.sh --set-secret MERAKI_API_KEY=...
> ```

> `KINTONE_MERAKI_APP_ID` / `KINTONE_MERAKI_APP_TOKEN` / `MERAKI_API_KEY` は Meraki 連携時のみ設定してください (任意)。

### ステップ 4: デプロイを実行

```bash
bash scripts/fly-deploy.sh
```

内部的には `fly deploy --yes` を実行します (fly.toml が存在する場合は自動的にそれを使用し上書きしません)。

### ステップ 5: ヘルスチェック

```bash
curl https://config-manager.fly.dev/healthz
# -> ok
```

ブラウザで `https://config-manager.fly.dev/` を開き、Entra ID ログイン → 機器一覧画面が表示されれば成功です。

---

## 更新デプロイ

コードを修正した後の通常デプロイ手順です。

### 1. ローカルで typecheck と build を通す

`AGENTS.md` のルールに従い、必ず以下を実行してからデプロイします。

```bash
pnpm -r run typecheck
pnpm build
```

これらが通らない場合はデプロイしないでください (fly.io 上の Docker ビルドで失敗します)。

### 2. fly.io へデプロイ

```bash
bash scripts/fly-deploy.sh
```

### 3. 動作確認

```bash
# ヘルスチェック
curl https://config-manager.fly.dev/healthz

# ログをtail
fly logs --app config-manager
```

ブラウザで主要機能 (ログイン・機器一覧・アップロード・Meraki 取得・Diff) を確認します。

---

## シークレット管理

### シークレットの一覧を確認

```bash
fly secrets list --app config-manager
```

> **値は表示されません**。キー名と最終更新日時のみ確認できます。

### シークレットを 1 つ追加・変更

```bash
# 直接 fly コマンドを使う場合
fly secrets set --app config-manager MERAKI_API_KEY=新しいキー

# デプロイスクリプト経由でデプロイまで一括実行する場合
bash scripts/fly-deploy.sh --set-secret MERAKI_API_KEY=新しいキー
```

> シークレットを変更すると自動的にローリングデプロイが走り、全マシンへ反映されます。

> ⚠️ **`.env` からの全体一括同期 (旧 `--sync-secrets`) は廃止しました。**
> `.env` はローカル開発用 (`AUTH_MODE=disabled` 等) であり、本番シークレットとは値が異なるフィールドがあるため、一括同期すると本番認証が壊れる事故に繋がります。シークレットは必ず個別に設定してください。

### シークレットを削除

```bash
fly secrets unset --app config-manager OBSOLETE_KEY
```

> 削除も即時反映されます。削除したキーをコードが参照していると起動しなくなるため注意してください。

### シークレット運用上の注意

- **`.env` はリポジトリに commit しないでください** (`.gitignore` 済み)
- **シークレット値を Slack・メール・PR 本文に貼らないでください**
- Meraki 接続情報アプリの API キーは `CREDENTIALS_ENCRYPTION_KEY` 設定時に AES-256-GCM で暗号化して Kintone へ保存します（詳細は [`SECURITY.md`](./SECURITY.md)）。鍵未設定時のみ平文になるため、本番では必ず設定してください
- `SESSION_SECRET` を変更すると、全ユーザーのセッションが無効化されます (再ログインが必要)
- `CREDENTIALS_ENCRYPTION_KEY` を紛失・変更すると、既存の暗号化済み API キーは復号できなくなります（再登録が必要）

---

## Kintone API トークンの権限設計

本システムが使う Kintone API トークンは **運用用** と **セットアップ用** の 2 種類に分けます。詳細な権限マトリクスは README > B-4 を参照してください。

### 運用用トークン (fly.io に設定するもの)

各アプリで **レコード権限のみ** を持つ API トークンを生成して使います。「アプリ管理」権限は付けません。

| アプリ | 閲覧 | 追加 | 編集 | 削除 | env 変数 |
| --- | :---: | :---: | :---: | :---: | --- |
| コンフィグ管理 | ✅ | ✅ | ✅ | — | `KINTONE_CONFIG_APP_TOKEN` |
| 作業履歴 | ✅ | ✅ | — | — | `KINTONE_AUDIT_APP_TOKEN` |
| Meraki 接続情報 | ✅ | ✅ | ✅ | ✅ | `KINTONE_MERAKI_APP_TOKEN` |

> 「アプリ作成者」権限や他 Kintone ユーザーへの権限付与は不要です。API トークンの権限設定のみで制御されます。

### セットアップ用トークン (フィールド定義作成時のみ一時使用)

`scripts/setup-kintone.mjs` でフィールドを一括作成する際のみ、各アプリで **「アプリ管理」権限付き** の API トークンが必要です (preview API の呼び出しに必要)。

```bash
# 1. 各アプリの「設定 > APIトークン」で: 生成 →「アプリ管理」にチェック → アプリを更新
# 2. .env をセットアップ用トークンに一時的に書き換え
node scripts/setup-kintone.mjs --app all
# 3. 完了後、すぐに Kintone 側でこのトークンを削除（重要）
# 4. .env を運用用トークンに戻す
```

> 「アプリ管理」権限はフィールド定義の変更までできる強力な権限です。漏洩時の被害を最小化するため、セットアップ完了後は即座に削除してください。

---

## Kintone API トークンのローテーション

Kintone API トークンは **四半期に 1 回程度** の定期ローテーションを推奨します。また、漏洩が疑われる場合は即座に実施してください。

### 定期ローテーション手順

```bash
# 1. Kintone ポータルで新しい運用用トークンを生成（レコード権限のみ）
#    ※ 古いトークンはまだ削除しない（削除手順は最後）

# 2. fly.io 側のシークレットを更新 (個別に)
fly secrets set --app config-manager KINTONE_CONFIG_APP_TOKEN=新しいトークン
fly secrets set --app config-manager KINTONE_AUDIT_APP_TOKEN=新しいトークン
fly secrets set --app config-manager KINTONE_MERAKI_APP_TOKEN=新しいトークン # Meraki 連携時

# 3. デプロイ完了後、アプリが動作することを確認
curl https://config-manager.fly.dev/healthz
# ブラウザで機器一覧が表示されることを確認

# 4. 古いトークンを Kintone ポータルで削除（重要！「アプリを更新」も忘れずに）
#
# ※ ローカルの .env も新しいトークンで更新しておくと、
# ローカル検証時と本番でトークンが一致します。
```

> **重要**: `fly secrets set` で fly.io 側が新トークンに切り替わっても、**Kintone 側で古いトークンを削除するまでは有効なまま** です。手順 5 を忘れると、古いトークンが漏洩した場合に無効化できません。

### 緊急ローテーション (漏洩時)

```bash
# 1. まず Kintone ポータルで該当トークンを即時削除（被害封じのため）
#    ※ この時点で BFF は一時的に Kintone にアクセスできなくなる

# 2. 新しい運用用トークンを生成

# 3. できるだけ早く fly secrets へ反映
fly secrets set --app config-manager KINTONE_CONFIG_APP_TOKEN=新しいトークン

# 4. ヘルスチェック & 動作確認
curl https://config-manager.fly.dev/healthz
```

### ローテーションのタイミング目安

| ケース | 推奨タイミング |
| --- | --- |
| 定期ローテーション | 四半期に 1 回程度 |
| 担当者変更時 | アプリ権限を見直すタイミングで |
| 漏洩の疑い | 発覚次第、即座に |
| セキュリティ監査指摘 | 指摘されたタイミングで |

> 頻度が高すぎるトークン再生成は逆に運用負荷を増やすため、四半期〜半年程度の期間が実用的です。重要なのは「**削除手順まで確実に実施すること**」と「**セットアップ用トークンを使い捨てないこと**」です。

### ローテーションが不要なもの / 別管理のもの

| シークレット | ローテーション頻度 | 備考 |
| --- | --- | --- |
| `SESSION_SECRET` | 年 1 回程度 | 変更すると全ユーザーが再ログイン必要。32 文字以上必須 |
| `CREDENTIALS_ENCRYPTION_KEY` | 年 1 回程度（計画的に） | 変更前に既存 credential の再登録計画が必要。手順は SECURITY.md |
| `ENTRA_CLIENT_SECRET` | Entra ID 側の推奨に従う (既定 6 ヶ月または 1 年) | Azure Portal から再生成 |
| `MERAKI_API_KEY` | Meraki Dashboard 側の推奨に従う | 場合によっては接続情報アプリ側も更新 |
| Meraki 接続情報アプリ内の API キー | 必要に応じて | **fly secrets ではなく Kintone 側で管理**（暗号化済み）・接続情報ページから更新 |

---

## ロールバック

問題が発生した場合は、リリース履歴から戻し先の image を明示して再デプロイします。現在の flyctl には専用の `rollback` コマンドがないため、「直前」を暗黙に選ばないでください。

```bash
# ImageRef を含む履歴を確認
fly releases --app config-manager --image --json

# 戻し先を確認して明示的に指定
fly deploy --app config-manager \
  --image registry.fly.io/config-manager:deployment-XXXXXXXX \
  --yes

# 復旧確認
curl https://config-manager.fly.dev/healthz
fly status --app config-manager
```

### ロールバック時の注意

- 実行中・待機中の自動デプロイがないことを先に確認してください
- 現在の release と、戻し先の `ImageRef` を取り違えないでください
- **コードは前バージョンに戻りますが、シークレットは現在のまま**です。シークレットが原因の場合は別途 `fly secrets set` で戻してください
- **Kintone のレコードはロールバックされません**。コード変更が Kintone のスキーマ（フィールド追加等）に依存している場合は注意してください
- ロールバック後は `fly status` と `/healthz` の両方を確認してください

### リリース履歴の確認

```bash
fly releases --app config-manager --image
```

---

## 確認・監視

### マシン状態

```bash
fly status --app config-manager
fly machines list --app config-manager
```

### ログ

```bash
# リアルタイム tail
fly logs --app config-manager

# 過去ログを検索
fly logs --app config-manager | grep -i error
```

### リソース使用量

```bash
fly scale show --app config-manager
fly machine status <machine-id>
```

### ダッシュボード

- https://fly.io/apps/<app-name> で CPU・メモリ・ネットワーク使用量が確認できます
- 異常時はメール通知が飛びます (fly.io アカウントの通知設定を有効化してください)

---

## トラブルシューティング

### デプロイが Docker ビルドで失敗する

```
=> ERROR [build 5/5] RUN pnpm --filter @config-manager/web build
```

- **原因**: typecheck または build エラー
- **対処**: ローカルで `pnpm -r run typecheck && pnpm build` を実行し、エラーを修正してから再デプロイ

### 起動直後に 502 / 503 エラーになる

- **原因 1**: 必須環境変数が未設定。`loadConfig()` が `Missing required environment variable` を投げてクラッシュ
- **対処**:
  ```bash
  fly logs --app config-manager | grep -i "Missing required"
  fly secrets list --app config-manager
  ```
  不足しているシークレットを `fly secrets set` で追加

### ログインループになる (401 が返り続ける)

- **原因**: `ENTRA_REDIRECT_URI` と Entra ID アプリ登録の URI が不一致、または `SESSION_SECRET` 未設定
- **対処**:
  - `ENTRA_REDIRECT_URI` が `https://<app>.fly.dev/auth/callback` と完全一致しているか確認
  - Entra ID 側のリダイレクト URI に fly.io の URL が追加されているか確認 (README D)
  - `SESSION_SECRET` が 32 文字以上のランダム値か確認

### Meraki 取得が失敗する

- **原因 1**: `MERAKI_API_KEY` が未設定、かつ接続情報アプリにも未登録
- **原因 2**: Meraki Dashboard 側で API アクセスが無効
- **原因 3**: ネットワーク ID の形式が不正 (`L_xxx` / `N_xxx` である必要)
- **対処**:
  ```bash
  fly secrets list --app config-manager | grep MERAKI
  ```
  結果ページに表示される失敗エンドポイント一覧から、権限不足・機能未使用のエンドポイントを見分けてください

### Meraki 接続情報ページが「未設定です」と出る

- **原因**: `KINTONE_MERAKI_APP_ID` / `KINTONE_MERAKI_APP_TOKEN` が未設定
- **対処**: README F の手順で Kintone に Meraki 接続情報アプリを作成し、env と fly secrets の両方へ設定

### コールドスタートが遅い

- **原因**: `auto_stop_machines = 'stop'` によりアイドル時はマシンが停止するため、初回アクセスに数秒かかります
- **対処**: 常時起動にする場合は `fly.toml` の `min_machines_running = 1` に変更 (課金増)

### メモリ不足 (OOM でクラッシュ)

- **原因**: 大容量コンフィグのアップロード・Diff 計算・Meraki 全エンドポイント同時取得
- **対処**:
  ```bash
  fly scale memory 1024 --app config-manager
  ```
  または fly.toml の `memory = '512mb'` を `'1gb'` に変更

---

## CI/CD 連携

`.github/workflows/deploy.yml` が、`main` への push を検証した CI の成功後に Fly.io へ完全自動デプロイします。PR の CI 成功だけではデプロイせず、squash merge 後の `main` コミットを CI で再検証し、その同じ SHA を checkout します。

### GitHub 側の設定

1. Environment `production` を作成する
2. deployment branch を `main` に限定する
3. 完全自動運用のため required reviewer は設定しない
4. Environment secret `FLY_API_TOKEN` を登録する

`FLY_API_TOKEN` は、アプリ単位・期限付きの deploy token を使用します。

```bash
fly tokens create deploy -a config-manager --expiry 2160h
```

期限切れになる前に新しい token を発行し、値をログへ表示せず Environment secret を更新してください。org-wide token や個人の認証 token は使用しません。

### 自動デプロイの流れ

1. `main` の CI が `build` / `changes` / `helper-gate` を含めて成功
2. `workflow_run` が成功した同じコミット SHA を checkout
3. `flyctl deploy --app config-manager --remote-only --yes` を実行
4. Fly 内部の `/healthz` check で Machine の健全性を確認
5. 公開 `https://config-manager.fly.dev/healthz` が HTTP 200・本文 `ok` を返すまで retry
6. GitHub Environment の deployment 履歴へ結果を記録

デプロイは `fly-production` concurrency で直列化し、進行中の rollout は後続コミットでキャンセルしません。helper-only や文書だけの変更も含め、`main` の CI が通った変更は同じ経路を通すことで path 判定漏れを避けます。

### シークレットと権限

- workflow の GitHub 権限は `contents: read` のみです
- Fly token は deploy step にだけ渡します
- Fly.io に既に設定済みの本番シークレットは、CI から同期・変更しません
- `.env` を CI や Fly.io へ一括投入しないでください

### 失敗とロールバック

Fly build、内部 health check、公開 health check のいずれかが失敗すると deployment は失敗として残ります。自動 rollback は行いません。公開経路の一時障害や別の手動操作と競合して、誤った「直前リリース」へ戻す事故を避けるためです。

ロールバックが必要な場合は、実行中の deployment がないことと対象 release/image を確認してから、この文書の「ロールバック」手順を実行してください。ロールバック後も `/healthz` を確認します。

### 手動再デプロイ

安全のため、GitHub Actions から未検証の SHA を手動デプロイする入口は設けていません。Fly 側の一時障害や token ローテーション後に再デプロイが必要な場合は、対象が CI 成功済みの `main` コミットであることを確認し、ローカルの `scripts/fly-deploy.sh` を使用してください。

> CI からは `--remote-only` を使い、Docker ビルドを Fly.io 側で実行します。ローカルの `scripts/fly-deploy.sh` はシークレット変更・手動デプロイ・調査時の標準手順として引き続き利用します。

---

## 付録: デプロイ関連ファイル構成

```
config-manager/
├── Dockerfile                # multi-stage build (SPA + BFF)
├── fly.toml                  # fly.io 設定 (リージョョン・リソース・auto stop)
├── .dockerignore             # .env・node_modules 等をビルドコンテキストから除外
├── .env.example              # 環境変数のテンプレート
├── scripts/
│   ├── fly-deploy.sh         # 標準デプロイスクリプト (本ドキュメントを自動化)
│   └── ...
└── docs/
    └── DEPLOY.md             # 本ドキュメント
```
