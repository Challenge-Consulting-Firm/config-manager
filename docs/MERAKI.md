# Meraki 連携ガイド

Meraki Dashboard API 経由で MR/MX/MS の設定を取得する機能の使い方と、
API キー・組織 ID・ネットワーク ID の取得手順をまとめたドキュメントです。

README の「セットアップ手順 > F. Meraki 連携」と合わせて参照してください。

## 目次

- [前提: Meraki Dashboard API の有効化](#前提-meraki-dashboard-api-の有効化)
- [API キーの取得](#api-キーの取得)
- [組織 ID の取得](#組織-id-の取得)
- [ネットワーク ID の取得](#ネットワーク-id-の取得)
- [ネットワーク ID の形式](#ネットワーク-id-の形式)
- [curl で取得を試す](#curl-で取得を試す)
- [本システムへの登録](#本システムへの登録)
- [トラブルシューティング](#トラブルシューティング)

---

## 前提: Meraki Dashboard API の有効化

Meraki Dashboard API を使うには、対象 Organization で API アクセスを有効化する必要があります。

1. https://dashboard.meraki.com にログイン
2. **Organization > Settings**（組織 > 設定）を開く
3. **Dashboard API access**（Dashboard API アクセス）を **Enabled**（有効）にする
4. **Save**（保存）

> Organization に対して 1 度有効化すれば、その配下の全ネットワークで API が使えます。

---

## API キーの取得

1. Meraki Dashboard 右上の **Profile**（プロファイル）→ **API access**（API アクセス）
   - または **Organization > Settings** の下部にある API キー管理画面
2. **Generate new API key**（新しい API キーを生成）をクリック
3. 生成された API キー（40 文字程度の英数字）をコピー

> **注意**:
> - API キーはユーザーアカウントに紐づき、Organization 単位ではありません。同じキーでアクセス権のある全 Organization にアクセスできます。
> - API キーは再表示できません。紛失した場合は再生成が必要です（古いキーは無効化されます）。
> - 本システムでは API キーを **fly.io シークレット (`MERAKI_API_KEY`) または「Meraki 接続情報」アプリ (Kintone)** のいずれかで保持します。接続情報アプリ保存時は `CREDENTIALS_ENCRYPTION_KEY` による AES-256-GCM 暗号化を推奨（[`SECURITY.md`](./SECURITY.md)）。詳細は [本システムへの登録](#本システムへの登録) を参照。

---

## 組織 ID の取得

Meraki では「Organization（組織）」の下に複数の「Network（ネットワーク）」がぶら下がります。
ネットワーク ID を取得する前に、まず組織 ID を取得します。

### curl で取得

```bash
curl -L \
  -H "X-Cisco-Meraki-API-Key: あなたのAPIキー" \
  -H "Accept: application/json" \
  "https://api.meraki.com/api/v1/organizations"
```

### 応答例

```json
[
  {
    "id": "1215707",
    "name": "My Company",
    "url": "https://dashboard.meraki.com/o/ABCDEF/manage/organization/overview",
    "api": {
      "enabled": true
    },
    "licensing": { "model": "co-term" },
    "cloud": { "region": { "name": "North America" } }
  }
]
```

- **`id`**（例: `1215707`）が組織 ID です。数字のみの形式です。
- 複数の Organization に所属している場合は配列で複数返ります。

### 応答が空配列 `[]` の場合

- API アクセスが無効（[前提セクション](#前提-meraki-dashboard-api-の有効化) を確認）
- API キーが無効・期限切れ
- アクセス権のある Organization に所属していない

---

## ネットワーク ID の取得

組織 ID が分かったら、その配下のネットワーク一覧を取得します。

### curl で取得

組織 ID（例: `1215707`）をパスに指定します:

```bash
curl -L \
  -H "X-Cisco-Meraki-API-Key: あなたのAPIキー" \
  -H "Accept: application/json" \
  "https://api.meraki.com/api/v1/organizations/1215707/networks"
```

### 応答例

```json
[
  {
    "id": "N_2438294379823479234",
    "name": "Tokyo Office",
    "organizationId": "1215707",
    "productTypes": ["appliance", "switch", "wireless"],
    "timeZone": "Asia/Tokyo",
    "tags": ["prod", "tokyo"],
    "notes": "本社オフィス"
  },
  {
    "id": "L_646829496481105433",
    "name": "Osaka Branch",
    "organizationId": "1215707",
    "productTypes": ["appliance"],
    "timeZone": "Asia/Tokyo",
    "tags": [],
    "notes": ""
  }
]
```

- **`id`**（例: `N_2438294379823479234` または `L_646829496481105433`）が **ネットワーク ID** です。本システムで入力するのはこれです。
- **`productTypes`** に `appliance` / `switch` / `wireless` のいずれかが含まれるネットワークだけが、本システムの取得対象になります（`camera` や `sensor` のみのネットワークは取得対象外）。

### Dashboard の UI から取得する場合

API を使わずに確認するには:

1. Dashboard で対象ネットワークを開く
2. ブラウザのアドレスバーを見る:

   ```
   https://dashboard.meraki.com/N_2438294379823479234/manage/usage/list
                                 ^^^^^^^^^^^^^^^^^^^^
                                 これがネットワーク ID
   ```

3. または **Network > Settings** ページの下部に「Network ID」として明示的に表示されます

---

## ネットワーク ID の形式

| 形式 | 意味 |
| --- | --- |
| `N_xxxxxxxxxxxxx` | 通常のネットワーク（最も多い） |
| `L_xxxxxxxxxxxxx` | VPN を含むネットワーク（稀） |

どちらの形式でも本システムのバリデーション（`/^[LNQ]_[0-9a-zA-Z]+$/`）で受け付けます。

> **組織 ID とネットワーク ID を混同しないでください**:
> - 組織 ID は **数字のみ**（例: `1215707`）
> - ネットワーク ID は **`N_` / `L_` で始まる**（例: `N_2438294379823479234`）
> - **本システムで入力するのは常にネットワーク ID** です。

---

## curl で取得を試す

本システムに登録する前に、対象ネットワークの情報が取れるか curl で確認できます。

### ネットワーク情報を取得

```bash
curl -L \
  -H "X-Cisco-Meraki-API-Key: あなたのAPIキー" \
  -H "Accept: application/json" \
  "https://api.meraki.com/api/v1/networks/N_2438294379823479234"
```

応答例:

```json
{
  "id": "N_2438294379823479234",
  "name": "Tokyo Office",
  "organizationId": "1215707",
  "productTypes": ["appliance", "switch", "wireless"],
  "timeZone": "Asia/Tokyo",
  "tags": ["prod", "tokyo"],
  "notes": "本社オフィス"
}
```

### デバイス一覧を取得

```bash
curl -L \
  -H "X-Cisco-Meraki-API-Key: あなたのAPIキー" \
  -H "Accept: application/json" \
  "https://api.meraki.com/api/v1/networks/N_2438294379823479234/devices"
```

### 本システムが取得する全エンドポイントを試す

本システムは、対象ネットワークに **実際に在籍している製品タイプ**（appliance / switch / wireless）のエンドポイントだけを取得します。`productTypes` が `Combined`（3 種すべて）でも、例えば MR（wireless）しか設置されていなければ wireless のエンドポイントのみを叩きます。これは無駄な呼び出しを避け、レート制限 (429) で肝心の設定取得（Wireless の SSID/PSK 等）まで巻き込んで失敗するのを防ぐためです。
また、レート制限抑制のためエンドポイントは並列度を絞って取得します（既定 5 並列・`MERAKI_SECTION_CONCURRENCY` で調整可）。
事前に curl で叩いて応答を確認できます（エンドポイント一覧は [`packages/shared/src/meraki.ts`](../packages/shared/src/meraki.ts) の `MERAKI_ENDPOINTS` を参照）。

例（MX / appliance の VLAN を取得）:

```bash
curl -L \
  -H "X-Cisco-Meraki-API-Key: あなたのAPIキー" \
  -H "Accept: application/json" \
  "https://api.meraki.com/api/v1/networks/N_2438294379823479234/appliance/vlans"
```

> 一部エンドポイントはネットワーク構成により 404 を返します（例: Single LAN モードで `/appliance/vlans` を叩いた場合）。これは正常な動作で、本システムは該当セクションを「取得失敗」として記録しつつ全体取得を継続します。

---

## 本システムへの登録

ネットワーク ID と API キーが用意できたら、以下のいずれかの方法で本システムに登録します。

### 方法 A: 接続情報アプリに保存して再利用（推奨）

1. 本システムの **「接続情報」** ページ（`/meraki/credentials`）を開く
2. **「+ 新規登録」** をクリック
3. 以下を入力:
   - **表示名**: 後で分かりやすい名前（例: `東京オフィス MX`）
   - **ネットワーク ID**: `N_2438294379823479234`
   - **API キー**: Meraki Dashboard で生成したキー
   - **デフォルト顧客 / ホスト名**（任意）: 取得画面で自動補完されます
4. **保存** をクリック
5. 「Meraki 取得」ページ（`/meraki`）を開き、ドロップダウンから登録した接続情報を選択すれば、ネットワーク ID と API キーの入力なしで取得を実行できます

> API キーは Kintone 上に**平文で保存**されます。アクセス権限の設計には十分ご注意ください（README F 参照）。

### 方法 B: 環境変数に設定（共通キーの場合）

1 つの API キーを全ネットワークで共有する場合は、環境変数に設定します:

```bash
# .env に追記
MERAKI_API_KEY=あなたのAPIキー
```

fly.io の本番環境へは:

```bash
fly secrets set --app config-manager MERAKI_API_KEY=あなたのAPIキー
```

> 環境変数の API キーは Kintone やログに保存されません。

### 方法 C: 毎回手動入力

「Meraki 取得」ページで接続情報を選択せず、毎回ネットワーク ID と API キーを入力することも可能です（環境変数未設定時のみ API キー入力が必須）。

### 優先順位

`POST /api/meraki/import` は以下の順で認証情報を解決します:

1. **接続情報 ID (`credentialId`)** — 最優先。Kintone の接続情報から networkId / apiKey / デフォルト識別子を取得
2. **要求ボディの networkId + apiKey** — 手動入力
3. **環境変数 `MERAKI_API_KEY`** — apiKey のみフォールバック

---

## トラブルシューティング

### `Meraki API キーが短すぎるか空です`

- API キーが 16 文字未満、または空
- 入力欄の前後空白を除去して再入力してください

### `ネットワーク ID の形式が不正です`

- `N_` または `L_` で始まる文字列ではありません
- [ネットワーク ID の取得](#ネットワーク-id-の取得) を参照して正しい ID を確認してください
- 組織 ID（数字のみ）を誤って入力していませんか?

### `このネットワークには appliance/switch/wireless のいずれも含まれていません`

- ネットワークの `productTypes` が `camera` / `sensor` / `cellularGateway` 等のみで、MR/MX/MS が含まれていません
- `curl` で `GET /networks/{networkId}` を叩いて `productTypes` を確認してください
- 必要なら別のネットワーク ID を指定してください

### `Meraki API rate limit exceeded after retries`

- Meraki API のレート制限（毎秒 10 リクエスト等）に抵触しました
- 本システムは自動リトライ（既定 3 回・指数バックオフ）しますが、それでも制限に達しました
- 取得は在籍製品タイプのみに絞り、並列度も抑制（既定 5）していますが、なお頻発する場合は次を試してください:
  - 時間をおいて再実行する
  - `MERAKI_SECTION_CONCURRENCY` を下げる（例: `3`）／`MERAKI_MAX_RETRIES` を増やして再デプロイする
- なお、以前は `Combined` ネットワークで在籍しない製品（例: appliance/switch）のエンドポイントまで叩いてレート制限を誘発し、Wireless の SSID/PSK 取得まで失敗するケースがありましたが、在籍製品のみ取得する挙動に修正済みです

### `HTTP 404: ...` が特定セクションだけに出る

- そのエンドポイントがネットワーク構成上存在しない（例: Single LAN モードで `/appliance/vlans` を叩いた）
- **正常な動作** です。該当セクションは「取得失敗」として記録され、全体取得は継続します
- 結果パネルの「失敗したエンドポイント」欄で何が取れなかったかを確認できます

### Meraki 接続情報ページが「未設定です」と出る

- `KINTONE_MERAKI_APP_ID` / `KINTONE_MERAKI_APP_TOKEN` が fly.io シークレットに未設定
- README の「セットアップ手順 > F」および「B-4. API トークンの権限設計」を参照して Kintone 側に Meraki 接続情報アプリを作成してください

### `HTTP 401: ...`

- API キーが無効・期限切れ・誤入力
- Meraki Dashboard でキーを再生成して、接続情報ページまたは環境変数を更新してください

---

## 参考

- [Meraki Dashboard API v1 ドキュメント](https://developer.cisco.com/meraki/api-v1/)
- [Meraki Developer Community](https://meraki.io/community)
- 本システムの実装:
  - [`packages/shared/src/meraki.ts`](../packages/shared/src/meraki.ts) — 型定義・エンドポイント定義・シリアライザ
  - [`apps/bff/src/meraki.ts`](../apps/bff/src/meraki.ts) — Meraki API クライアント
  - [`apps/web/src/pages/MerakiImportPage.tsx`](../apps/web/src/pages/MerakiImportPage.tsx) — 取得画面
  - [`apps/web/src/pages/MerakiCredentialsPage.tsx`](../apps/web/src/pages/MerakiCredentialsPage.tsx) — 接続情報管理画面
