# config-manager ヘルパー（ローカル Telnet / SSH 取得アプリ）

NW 機器から Telnet または SSH でコンフィグを自動取得する **Go 製ローカルヘルパーアプリ** です。
ユーザー PC 上で動作し、SPA（fly.io 上）からの要求を受けてコンフィグ本文を取得します。

> 設計の経緯は Issue #43 の最終確定コメントを参照してください。
> Chrome 拡張機能 + Native Messaging 方式は廃止され、「拡張機能なしの単体ローカルアプリ
> （ポータブル型）」に確定しました。

---

## アーキテクチャ

```
┌─────────────┐   ①fetch要求    ┌──────────────────┐
│   SPA       │ ───────────────▶│  ヘルパー        │
│ (fly.io/HTTPS)│                │ (127.0.0.1/HTTP) │
└─────────────┘                 └────────┬─────────┘
      │ ②コンフィグ本文                   │ ③Telnet (23) / SSH (22)
      ▼                                   ▼
┌─────────────┐                 ┌──────────────────┐
│   BFF       │                 │  NW 機器         │
│ (fly.io)    │                 │ (Cisco/YAMAHA等) │
│ /api/upload │                 └──────────────────┘
└─────────────┘
   ④same-origin + cookie セッション
```

- ヘルパーはユーザー PC 上の `127.0.0.1` に HTTP サーバを開きます（外部公開なし）
- SPA がヘルパーを直接呼び出し、コンフィグ本文を受け取ります
- SPA は受け取った本文を既存 `POST /api/upload`（same-origin + cookie セッション）で BFF に送ります
- **ヘルパーは BFF に直接 POST しません**（拡張トークン・CSRF バイパスは一切不要）
- ヘルパーはインストーラ不要・レジストリ等への書き込みなしのポータブル型です

---

## ビルド方法

### 前提

- Go 1.25 以上（`golang.org/x/crypto` の要求バージョン。CI も 1.25 を使用）
- 外部依存は `golang.org/x/text`（SJIS 変換用）と `golang.org/x/crypto`（SSH 用）

### 初回セットアップ

`go.sum` はリポジトリに含まれていますが、依存を更新した場合は `go mod tidy` で
再生成してください。

```bash
cd apps/helper
go mod tidy
```

### ビルド

```bash
CGO_ENABLED=0 go build -o config-manager-helper ./cmd/helper
```

`CGO_ENABLED=0` を指定することで、純粋 Go の静的バイナリが生成されます。

### 本番配布向けビルド（ldflags 注入）

本番 SPA からヘルパーを呼ぶには、**ビルド時に本番 SPA の origin を埋め込む** 必要があります。
配布バイナリを起動するユーザー PC で環境変数が設定されている保証がないためです。
同時にバージョンも注入します。

```bash
# HELPER_VERSION と HELPER_ALLOWED_ORIGIN を ldflags で注入
CGO_ENABLED=0 go build -ldflags "-s -w \
  -X github.com/Challenge-Consulting-Firm/config-manager/apps/helper/internal/server.Version=1.2.3 \
  -X github.com/Challenge-Consulting-Firm/config-manager/apps/helper/internal/server.BuildTimeAllowedOrigin=https://config-manager.fly.dev" \
  -o config-manager-helper ./cmd/helper
```

注入する変数:

| 変数 | 役割 | 未注入時 |
| --- | --- | --- |
| `server.Version` | 表示バージョン | `0.0.0-dev` |
| `server.BuildTimeAllowedOrigin` | 本番 SPA の origin | 空（開発用 localhost のみ許可） |

`scripts/build-helper.sh` を使う場合は、環境変数で制御できます:

```bash
# build-helper.sh は VERSION を引数または git tag から取得し、
# HELPER_ALLOWED_ORIGIN 環境変数があれば BuildTimeAllowedOrigin へ注入します。
HELPER_ALLOWED_ORIGIN=https://config-manager.fly.dev ./scripts/build-helper.sh 1.2.3
```

> **注意**: `scripts/build-helper.sh` は `apps/helper/` 配下ではなく `scripts/` 配下にあるため、
> 本ディレクトリの管轄外です。スクリプトの詳細は同ファイルを参照してください。

### クロスコンパイル例

配布先 OS 向けにクロスコンパイルできます。

```bash
# Windows (64-bit)
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o config-manager-helper.exe ./cmd/helper

# Linux (64-bit)
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o config-manager-helper ./cmd/helper

# macOS (Apple Silicon)
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o config-manager-helper-darwin-arm64 ./cmd/helper

# macOS (Intel)
CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -o config-manager-helper-darwin-amd64 ./cmd/helper
```

#### macOS universal binary

Apple Silicon と Intel の両方で動く universal binary を作る場合は `lipo` を使います。

```bash
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o config-manager-helper-arm64 ./cmd/helper
CGO_ENABLED=0 GOOS=darwin GOARCH=amd64  go build -o config-manager-helper-amd64  ./cmd/helper
lipo -create -output config-manager-helper config-manager-helper-arm64 config-manager-helper-amd64
```

---

## 実行方法

### サーバモード（通常利用）

Windows はダブルクリック、macOS / Linux は端末から起動します。

```bash
./config-manager-helper
```

> **macOS の注意**: ブラウザでダウンロードしたファイルは実行権限（`+x`）が落ちるため、
> ダブルクリックするとテキストエディットで開いてしまいます。初回のみ端末から起動してください。
> 配布物は Developer ID 署名 + Apple 公証済みのため、隔離属性を外す必要はありません。
> 下記は SHA-256 を照合し、一致した場合だけ起動します（Issue #79）。
>
> ```bash
> cd ~/Downloads
> echo "<latest.json の sha256>  config-manager-helper" | shasum -a 256 -c - \
>   && chmod +x config-manager-helper \
>   && ./config-manager-helper
> ```
>
> Gatekeeper がブロックした場合は、迂回せずファイルを削除して管理者へ連絡してください
> （配布物がすり替えられている可能性があります）。検証手順は
> [`docs/HELPER-RELEASE.md`](../../docs/HELPER-RELEASE.md) を参照。

起動時に許可 Origin を追加指定できます（staging 確認等）:

```bash
# --allow-origin で許可 Origin を追加（複数指定可）
./config-manager-helper --allow-origin https://staging.fly.dev
```

起動時のコンソール出力例:

```
========================================================
  config-manager ヘルパー を起動しました
========================================================
  待ち受けポート: 53712 (127.0.0.1)
  バージョン    : 1.2.3
  ヘルパー ID   : <公開鍵から導出した ID>
  ペアリングコード: <初回所有確認用コード>
  停止方法      : Ctrl+C または SPA の「停止」ボタン
--------------------------------------------------------
  許可 Origin:
    - http://localhost:3000
    - http://127.0.0.1:3000
    - http://localhost:5173
    - http://127.0.0.1:5173
    - https://config-manager.fly.dev
--------------------------------------------------------
  【セキュリティ注意】
  ・本ヘルパーは 127.0.0.1 のみで待ち受けます（外部公開なし）
  ・許可された Origin 以外からの要求は拒否します
  ・Telnet は平文プロトコルです。機器との通信は暗号化されません
  ・SSH の場合はホスト鍵を初回接続時に記録し、以降の変更を検知します
    known_hosts: /Users/you/Library/Application Support/config-manager-helper/known_hosts
========================================================

SPA 側でこのヘルパーを検出したら、取得ボタンが有効になります。
保存済みの機器認証情報を初めて使う際は、画面に上記ペアリングコードを入力します。
コードは helper identity の所有確認だけに使われ、BFF の監査ログには保存されません。
終了する場合は Ctrl+C を押すか、SPA の停止ボタンを押してください。
```

許可 Origin は以下の優先順位でマージされます:

1. ビルド時注入（`BuildTimeAllowedOrigin`）
2. `PUBLIC_BASE_URL` 環境変数
3. `--allow-origin` 起動引数
4. 開発用 localhost（`localhost:3000` / `127.0.0.1:3000` / `localhost:5173` / `127.0.0.1:5173`）

### CLI デバッグモード（SPA なしで E2E 検証）

`fetch` サブコマンドを使うと、HTTP サーバを起動せずに取得を直接実行できます。
**パスワードはコマンドライン引数には乗せません**（プロセス一覧で漏洩するため）。
環境変数または標準入力から読み込みます。

```bash
# 環境変数でパスワードを指定
export HELPER_PASSWORD='***'
export HELPER_ENABLE_PASSWORD='***'   # 任意（Cisco enable 昇格用）
./config-manager-helper fetch --host 192.168.1.1 --os cisco-ios --username admin

# 未設定時は標準入力からプロンプトで読み込み
./config-manager-helper fetch --host 192.168.1.1 --os cisco-ios --username admin
# Password: （ここで入力）

# 取得コマンドを上書き
./config-manager-helper fetch --host 192.168.1.1 --os generic --username admin --command "show startup-config"

# SSH で取得（ポートは既定 22）
./config-manager-helper fetch --host 192.168.1.1 --protocol ssh --os cisco-ios --username admin
```

フラグ:

| フラグ          | 既定値               | 説明                                                               |
| --------------- | -------------------- | ------------------------------------------------------------------ |
| `--host`        | （必須）             | 接続先ホスト（IP またはホスト名）                                  |
| `--protocol`    | `telnet`             | 接続プロトコル（`telnet` / `ssh`）                                 |
| `--port`        | telnet=23 / ssh=22   | 接続ポート                                                         |
| `--os`          | `cisco-ios`          | 機種ヒント（`cisco-ios` / `yamaha-rt` / `yamaha-swx` / `generic`）  |
| `--username`    | （必須）             | ログインユーザー名                                                 |
| `--command`     | （os 別既定）        | コンフィグ取得コマンドの上書き                                     |
| `--known-hosts` | OS のユーザー設定DIR | SSH の known_hosts パス（`HELPER_KNOWN_HOSTS` でも指定可）         |

---

## セットアップ（初回利用）

詳細な手順は SPA 側のセットアップ画面に記載されています。概要:

1. SPA のセットアップ画面から、お使いの OS 向けバイナリをダウンロードする
2. ダウンロードしたファイルをダブルクリックで起動する（インストール不要）
3. SPA 側で「ヘルパー検出」が成功したら、取得ボタンが有効になる
4. 利用後は SPA の停止ボタン、または Ctrl+C / ウィンドウクローズで終了する
5. 不要になればファイルを削除してよい（レジストリ等への書き込みはない）

---

## 停止方法

- **Ctrl+C** を押す（サーバモード）
- **ウィンドウを閉じる**（ダブルクリック起動時）
- **SPA の「停止」ボタン**を押す（`POST /api/shutdown` でプロセス終了）

いずれの場合もプロセスは即座に終了し、`127.0.0.1` の待ち受けを解放します。

---

## 配布について

- **リリースは `Release Helper` ワークフローから行う** — `helper-v<バージョン>` タグの push で
  ビルド → 署名（Windows: Authenticode / macOS: Developer ID + Apple 公証）→ checksum・provenance 付きで
  GitHub Release へ公開する。署名・公証に失敗したビルドは公開されない（Issue #79）。
  手順・鍵管理・失効時の対応は [`docs/HELPER-RELEASE.md`](../../docs/HELPER-RELEASE.md) を参照。
- **第一候補: GitHub Releases** — バイナリ本体（`.exe` / macOS universal）と
  `latest.json`（URL + sha256 + signature）を配置する。SPA のセットアップ画面が OS 判定で該当リンクを提示する。
- **フォールバック: BFF 同梱** — 社内 PC から `github.com` へ到達不可の場合のみ、
  BFF の `public/downloads/helper/` に同梱して配信する。
- **`scripts/build-helper.sh` は開発用** — 既定では未署名で、`latest.json` の `signature` が
  `none` になる。SPA はこれを「未署名。使用しないでください」と表示する。

---

## HTTP API 仕様

バインドは `127.0.0.1` のみ。既定ポート **53712**（使用中なら 53713〜53716 を順に試行）。

### `GET /api/status`

死活・バージョン応答。

```json
{ "ok": true, "version": "0.1.0" }
```

### `POST /api/fetch`

コンフィグ取得の実行。`protocol` は `"telnet"` または `"ssh"`（省略不可）。
リクエストボディ（JSON）:

```json
{
  "host": "192.168.1.1",
  "port": 23,
  "protocol": "telnet",
  "username": "admin",
  "password": "***",
  "enablePassword": "",
  "osHint": "cisco-ios",
  "commandOverride": null,
  "timeouts": { "connectMs": 10000, "loginMs": 15000, "commandMs": 120000, "totalMs": 180000 }
}
```

成功レスポンス:

```json
{
  "ok": true,
  "body": "! config ...\n",
  "meta": {
    "elapsedMs": 8420,
    "prompt": "router#",
    "command": "show running-config",
    "sourceEncoding": "utf-8"
  }
}
```

失敗レスポンス:

```json
{ "ok": false, "code": "auth_failed", "message": "login prompt timeout" }
```

エラーコード: `connect_failed` / `auth_failed` / `prompt_not_found` / `timeout` /
`pager_detected` / `empty_body` / `command_rejected` / `handshake_failed`（SSH のみ） /
`host_key_mismatch`（SSH のみ） / `credential_redeem_failed`

`port` を省略した場合はプロトコル既定値（telnet=23 / ssh=22）が使われます。

#### 認証情報の渡し方

`username` / `password` を直接乗せる（都度入力）ほかに、BFF が発行した
**一回限りのトークン**を渡す経路があります（Issue #53）。

```json
{
  "host": "192.168.1.1",
  "protocol": "ssh",
  "credentialToken": "<BFF が発行した単回トークン>",
  "osHint": "yamaha-rt"
}
```

`credentialToken` が指定されると、ヘルパーは機器へ接続する直前に

```
POST <検証済み Origin>/helper/credentials/redeem   { "token": "..." }
  → { "username": "...", "password": "..." }
```

で平文を引き換え、それを使ってログインします。SPA は平文を一度も保持しません。

- 引き換え先はリクエストボディからは受け取らず、**withCORS が allowlist 照合済みの
  `Origin` ヘッダ**から組み立てます。SPA が任意の URL を指定することはできません。
- リモートホストへの平文 HTTP は拒否します（`localhost` / `127.0.0.1` は開発用に許可）。
- 引き換えに失敗した場合は `credential_redeem_failed` を返します。理由（期限切れ・
  使用済み・到達不可）は区別しません。
- 引き換えた平文はメモリ上のみで扱い、ログ・エラー応答には出しません。

`password` と `credentialToken` のどちらも無い場合は 400 を返します。

### `POST /api/shutdown`

200 を返してからプロセスを終了する。

```json
{ "ok": true }
```

### CORS / Private Network Access

- HTTPS の SPA（パブリックオリジン）→ `http://127.0.0.1` は Private Network Access 対象
- プリフライト（`OPTIONS`）に `Access-Control-Allow-Private-Network: true` 等で応答
- 許可 Origin はハードコードの allowlist（`PUBLIC_BASE_URL` 環境変数 + 開発用 localhost）
- 許可外 Origin、または Origin ヘッダ無しの状態変更リクエストは 403

---

## OS 別コマンドマップ

| osHint       | ページング抑制      | コンフィグ取得        | 対象機器 |
| ------------ | ------------------- | --------------------- | -------- |
| `cisco-ios`  | `terminal length 0` | `show running-config` | Cisco IOS / IOS-XE |
| `yamaha-rt`  | （不要）            | `show config`         | YAMAHA ルーター（RTX 等） |
| `yamaha-swx` | `terminal length 0` | `show running-config` | YAMAHA スイッチ（SWX2100/2200/2300/3100/3200 等） |
| `generic`    | `terminal length 0` を試行 | `commandOverride` 必須 | その他 |

> **YAMAHA は 2 系統ある点に注意**: ルーター（RTX）とスイッチ（SWX）で CLI 体系が
> 異なります。SWX は Cisco 風の CLI を持つため、`yamaha-rt` を指定して `show config`
> を送ると機器が `% Invalid input detected at '^' marker.` を返して失敗します。
> スイッチには必ず `yamaha-swx` を使ってください。

機器が取得コマンドを受け付けなかった場合、ヘルパーは本文を世代として返さず
`command_rejected` エラーで失敗させます（エラーメッセージがコンフィグとして
登録されるのを防ぐため）。

### `commandOverride` の制約（Issue #76）

`commandOverride` はヘルパー側で検証し、機器へ接続する前に拒否します。SPA 側にも
同じ検証がありますが、そちらは入力ミスを早く知らせるための UX 補助で、セキュリティ
境界はヘルパーにあります。

- CR / LF / NUL / タブなどの制御文字を含むコマンドは拒否（`sendLine` が末尾へ CR を
  付けるため、混入すると 1 本の取得コマンドに複数コマンドを潜り込ませられる）
- 使える文字は英数字と `- _ . / :` および半角空白のみ（`;` `|` `&` `$` などは不可）
- 先頭語は読み取り専用コマンドに限定（`show` / `display` / `get` / `dir` / `more`）
- 100 文字以内。前後の空白は除去し、連続する空白は 1 個へ畳む
- **保存済み認証情報（`credentialToken`）を使う場合は、下表の定義済みコマンドのみ**
  （高権限の credential と任意コマンドの組み合わせを断つため。自由入力が必要な機種は
  都度入力の認証情報で実行する）

| osHint | 保存済み認証情報で指定できるコマンド |
| ------ | ------------------------------------ |
| `cisco-ios` / `yamaha-swx` | `show running-config` / `show startup-config` / `show version` |
| `yamaha-rt` | `show config` / `show config list` / `show environment` |
| `generic` | 上記すべて |

検証で拒否した場合は HTTP 400 を返し、入力されたコマンドはログにも応答にも出しません
（誤って貼り付けられた認証情報が漏れないようにするため）。送信直前のセッション層でも
同じ制御文字チェックを行い、通過した場合は `command_invalid` で fail closed にします。

---

## セキュリティ注意

- **127.0.0.1 バインド**: 外部ネットワークには一切公開しません。`0.0.0.0` にはバインドしません。
- **Origin allowlist**: 許可された Origin 以外からの要求は拒否します。
- **パスワード取り扱い**: パスワード・enablePassword はログ・ファイルに書き出しません。
  メモリ上で取得後に参照を破棄します。CLI でもコマンドライン引数には乗せません。
- **ヘルパー identity / ペアリング**: 初回起動時に Ed25519 鍵とペアリング secret を
  ユーザー設定ディレクトリの `identity.json`（0600）へ生成します。保存済み認証情報を
  使うには、コンソール表示コードでペアリングし、token と対象ホストに対する helper
  署名を BFF が検証します。ファイル削除・別 PC への移行時は再ペアリングが必要です。
- **Telnet は平文プロトコルです**: 本ヘルパーと機器間の通信は暗号化されません。
  同一セグメント上のパケットキャプチャで認証情報が漏洩する可能性があります。
  機器が SSH に対応している場合は `protocol: "ssh"` を使ってください。
- **SSH のホスト鍵検証（TOFU）**: 初回接続時のホスト鍵を `known_hosts` に記録し、
  以降は一致を検証します。不一致の場合は `host_key_mismatch` で取得を中断します
  （中間者攻撃の検知）。機器の交換・初期化で鍵が正当に変わった場合は、
  `known_hosts` の該当行を削除してから再取得してください。
  - 既定の保存先: `os.UserConfigDir()/config-manager-helper/known_hosts`
    （Windows: `%AppData%\config-manager-helper\known_hosts`、
    macOS: `~/Library/Application Support/config-manager-helper/known_hosts`、
    Linux: `~/.config/config-manager-helper/known_hosts`）
  - `HELPER_KNOWN_HOSTS` 環境変数、または CLI の `--known-hosts` で変更できます
  - ファイル形式は OpenSSH の `known_hosts` と同一です
- **SSH の暗号方式**: 旧世代の NW 機器向けに、SHA-1 系の鍵交換（`diffie-hellman-group1-sha1` 等）・
  CBC 暗号（`aes128-cbc`）・`ssh-rsa` ホスト鍵を**低優先で**許可しています。機器が新しい方式に
  対応していればネゴシエーションで自動的にそちらが選ばれます（平文の Telnet を使わずに
  済むことを優先した判断です）。

---

## 開発者向け情報

### ディレクトリ構成

```
apps/helper/
├── go.mod
├── go.sum
├── README.md
├── cmd/helper/main.go          # エントリポイント（サーバ + CLI デバッグモード）
├── internal/server/server.go   # 127.0.0.1 HTTP・CORS/PNA・Origin allowlist
├── internal/session/session.go # Telnet / SSH 共通の取得状態機械（ログイン・プロンプト学習・整形）
├── internal/telnet/telnet.go   # Telnet トランスポート（TCP 接続・IAC ネゴシエーション）
├── internal/ssh/ssh.go         # SSH トランスポート（ハンドシェイク・PTY シェル・暗号方式）
├── internal/ssh/hostkey.go     # SSH ホスト鍵検証（TOFU / known_hosts）
├── internal/ssh/stream.go      # SSH の stdin/stdout を期限付きストリームへ適合
├── internal/commands/commands.go # osHint 別コマンドマップ
└── internal/encoding/encoding.go # SJIS→UTF-8 変換
```

> **注意**: このディレクトリには `package.json` を置きません。
> pnpm workspace（`apps/*`）から自動除外することで、Go モジュールを
> TypeScript のビルド対象から切り離すためです。

### 検証

```bash
cd apps/helper
go build ./...
go vet ./...
go test ./...
```

### 外部依存

- `golang.org/x/text`（SJIS 変換用 `encoding/japanese`）
- `golang.org/x/crypto`（SSH クライアント `ssh` / `ssh/knownhosts`）
- それ以外は Go 標準ライブラリで実装しています。
