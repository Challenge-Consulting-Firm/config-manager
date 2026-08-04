# セキュリティ運用ガイド

脆弱性診断フォローアップ（Epic #9）で入れた対策の運用メモです。
デプロイ手順の詳細は [DEPLOY.md](./DEPLOY.md) を参照してください。

## 目次

- [認証・RBAC](#認証rbac)
- [セッション](#セッション)
- [Meraki API キーの暗号化](#meraki-api-キーの暗号化)
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
| Dependabot | `.github/dependabot.yml` — npm / GitHub Actions を毎週月 9:00 JST |
| CI audit | `.github/workflows/ci.yml` — `pnpm audit --audit-level=high`（現状は可視化のみ・非ブロッキング） |

### 既知の例外（2026-08 時点）

| パッケージ | 深刻度 | 理由 |
| --- | --- | --- |
| `xlsx` | high (ReDoS) | パッチ版が npm に未公開（advisory 上 Patched `<0.0.0`）。利用はブラウザ側エクスポートのみ。代替ライブラリ移行を別 Issue で検討 |
| `vite` 5.x | high (Windows `server.fs.deny`) | 本番コンテナは Vite dev server を使わない。major 上げ（v6）は別 PR |

これらが解消、または `package.json#pnpm.auditConfig.ignoreCves` で期限付き ignore したら、CI の `continue-on-error` を `false` に戻してゲート化する。

### トリアージ方針

1. **Critical / High**: 原則その PR または当日中に更新。defer する場合は Issue を切り理由・期限を書く
2. **Moderate**: 次回依存更新 PR に含める。悪用条件が自環境に無い場合は defer 可
3. **Low / 情報**: まとめて四半期で対応してよい
4. **例外（fix が無い / 誤検知）**: PR 説明に advisory URL と判断理由を残し、`pnpm.auditConfig.ignoreCves` 等で明示 ignore（期限付きコメント必須）

ローカル確認:

```bash
pnpm audit --audit-level=high
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
