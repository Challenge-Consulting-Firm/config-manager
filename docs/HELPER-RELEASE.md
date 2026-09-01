# ローカル取得ヘルパーのリリース運用

ローカル取得ヘルパー（`apps/helper`）は、利用者の PC 上で動くネイティブバイナリです。配布物がすり替えられると、利用者の LAN 内で任意コードが実行され、機器の認証情報も扱える立場を奪われます。したがって**署名されていない配布物は公開しない**ことを運用の前提にします（Issue #79）。

- ビルド・署名・公開: `.github/workflows/release-helper.yml`
- checksum / `latest.json` 生成: `scripts/helper-release-manifest.sh`
- ローカルビルド（開発用・配布不可）: `scripts/build-helper.sh`

## 目次

- [リリース手順](#リリース手順)
- [配布物の検証方法](#配布物の検証方法)
- [署名鍵の管理](#署名鍵の管理)
- [鍵のローテーション](#鍵のローテーション)
- [鍵の失効・漏えい時の対応](#鍵の失効漏えい時の対応)
- [ローカルビルドの位置づけ](#ローカルビルドの位置づけ)

---

## リリース手順

1. `main` にリリース対象のコミットが入っていることを確認する。
2. タグを打って push する。

   ```bash
   git tag helper-v0.5.0
   git push origin helper-v0.5.0
   ```

3. `Release Helper` ワークフローが以下を行う。

   | ジョブ | 実行内容 |
   | ------ | -------- |
   | `build-windows` | Windows ランナーでビルド → Authenticode 署名 → `Get-AuthenticodeSignature` が `Valid` であることを検証 |
   | `build-macos` | macOS ランナーで universal ビルド → Developer ID 署名（hardened runtime）→ notarization（`notarytool --wait`） |
   | `publish` | 署名済み artifact をダウンロード → `checksums.sha256` / `latest.json` 生成 → provenance 添付 → GitHub Release へ公開 |

4. `latest.json` を BFF の配信先（`apps/bff/public/downloads/helper/`）へ反映する。GitHub Releases から直接ダウンロードさせる場合は、Release の `latest.json`（絶対 URL 入り）をそのまま配置する。

**公開されない条件（fail closed）**

- 署名用 secret が未設定 → 該当ジョブがエラーで停止する
- 署名または `signtool verify` / `codesign --verify` が失敗 → ジョブが停止する
- notarization が `Accepted` にならない → ジョブが停止する

いずれの場合も `publish` ジョブは動かないため、未署名の成果物が Release に載ることはありません。

**署名対象と公開対象の同一性**: `publish` はビルドし直さず、署名済み artifact をそのままダウンロードして checksum を計算します。checksum は「署名後のファイル」から取るため、利用者側の照合と一致します。

**provenance**: `actions/attest-build-provenance` により、どのリポジトリのどのワークフロー実行がそのバイナリを作ったかを検証できます。

```bash
gh attestation verify config-manager-helper-windows-x64.exe \
  --repo Challenge-Consulting-Firm/config-manager
```

## 配布物の検証方法

SPA のセットアップ画面（「ローカル取得のセットアップ」）は、ハッシュを**自動照合してから起動する**コマンドを提示します。SmartScreen / Gatekeeper を迂回する手順は案内しません。警告が出た場合は実行せず、管理者へエスカレーションしてください。

### Windows

```powershell
cd ~\Downloads
$expected = "<latest.json の sha256>"
$actual = (Get-FileHash .\config-manager-helper.exe -Algorithm SHA256).Hash
if ($actual -ne $expected) {
  Write-Error "ハッシュが一致しません。実行せず削除し、管理者へ連絡してください。"
} else {
  Get-AuthenticodeSignature .\config-manager-helper.exe | Format-List Status, SignerCertificate
  .\config-manager-helper.exe
}
```

`Status` が `Valid`、署名者が自社であることを確認します。

### macOS

```bash
cd ~/Downloads
echo "<latest.json の sha256>  config-manager-helper" | shasum -a 256 -c - \
  && chmod +x config-manager-helper \
  && ./config-manager-helper
```

署名と公証の確認:

```bash
codesign --verify --verbose=2 config-manager-helper
spctl -a -t exec -vv config-manager-helper   # source=Notarized Developer ID
```

> 単体の Mach-O 実行ファイルには notarization チケットを staple できません（`.app` / `.dmg` / `.pkg` のみ）。Gatekeeper はオンラインで公証を検証します。オフライン端末へ配る必要が出た場合は `.dmg` 化して staple する方式へ切り替えてください。

## 署名鍵の管理

| 用途 | secret 名 | 保管 | 備考 |
| ---- | --------- | ---- | ---- |
| Windows Authenticode | `HELPER_WINDOWS_PFX_BASE64` / `HELPER_WINDOWS_PFX_PASSWORD` | GitHub Actions secrets（production 環境） | OV / EV コード署名証明書の `.pfx` を base64 化 |
| macOS Developer ID | `HELPER_MACOS_CERT_P12_BASE64` / `HELPER_MACOS_CERT_PASSWORD` / `HELPER_MACOS_SIGN_IDENTITY` | 同上 | `Developer ID Application` 証明書 |
| Apple 公証 | `HELPER_MACOS_NOTARY_ISSUER_ID` / `HELPER_MACOS_NOTARY_KEY_ID` / `HELPER_MACOS_NOTARY_KEY_BASE64` | 同上 | App Store Connect API キー（`.p8`） |

運用ルール:

- 秘密鍵の原本はパスワードマネージャの共有金庫に置き、リポジトリ・共有ドライブ・チャットに置かない。
- GitHub Actions secrets 以外の場所（ローカル PC の常設ファイル、CI キャッシュ）に鍵を残さない。ワークフローは一時キーチェーンと `RUNNER_TEMP` を使い、ステップ終了時に削除する。
- secrets の閲覧・更新は管理者ロールに限定する。誰が・いつ更新したかは GitHub の監査ログで追跡する。
- 署名にはタイムスタンプを必ず付ける（`/tr`・`--timestamp`）。証明書の有効期限が切れても、期限内に署名した配布物は検証可能なままになる。

## 鍵のローテーション

- **定期**: 証明書の有効期限の 60 日前までに新証明書を取得し、secrets を差し替える。差し替え後、最初のリリースで `Get-AuthenticodeSignature` / `codesign` の署名者情報が新証明書になっていることを確認する。
- **EV 証明書 / HSM を使う場合**: `.pfx` を持てないため、Azure Trusted Signing 等のクラウド署名へ切り替える。`build-windows` ジョブの署名ステップだけを差し替えれば、他の工程は変更不要。
- **Apple API キー**: 有効期限は無いが、年 1 回を目安にローテーションする。旧キーは App Store Connect で失効させる。
- ローテーション後は旧鍵で署名した配布物を Release から取り下げる必要はない（タイムスタンプにより検証可能）。ただし**漏えいが疑われる場合は下記の失効手順に従う**。

## 鍵の失効・漏えい時の対応

1. **署名を止める**: 該当 secret を GitHub から削除する。これにより `Release Helper` は fail closed で停止し、新しい配布物は公開できなくなる。
2. **証明書を失効させる**: 発行 CA へ失効（revoke）を依頼する。Apple の場合は Developer アカウントで証明書を失効させ、API キーを削除する。
3. **配布を止める**: `apps/bff/public/downloads/helper/latest.json` を取り下げ、SPA のセットアップ画面から配布物が消えることを確認する（`latest.json` が無い場合、画面は「配布物がまだ配置されていません」を表示する）。
4. **利用者へ周知する**: 影響するバージョン（`latest.json` の `version`）と SHA-256 を添えて、該当バイナリの削除を依頼する。ヘルパーは常駐せずポータブルなので、停止してファイルを削除すれば撤去できる。
5. **再発行して再リリースする**: 新しい鍵で新バージョンをリリースし、`latest.json` を差し替える。
6. **失効前に署名された配布物の扱い**: タイムスタンプがあるため OS 上は有効なままになる。漏えい時は「同じ証明書で攻撃者が署名できた期間」の配布物を信頼できないものとして扱い、バージョンを上げて再配布する。

## ローカルビルドの位置づけ

`scripts/build-helper.sh` は開発・動作確認用です。署名環境変数（`HELPER_WINDOWS_PFX` / `HELPER_MACOS_SIGN_IDENTITY` / `HELPER_MACOS_NOTARY_PROFILE`）が設定されていれば署名も行いますが、既定では未署名のまま生成し、警告を出します。

```bash
# 未署名（開発用）。生成される latest.json の signature は "none" になる
./scripts/build-helper.sh 0.5.0

# 署名を必須にする（署名できない場合はエラーで停止）
HELPER_REQUIRE_SIGNING=1 ./scripts/build-helper.sh 0.5.0
```

`signature: "none"` の `latest.json` を配信すると、SPA は「未署名（この配布物は使用しないでください）」と表示し、利用者へダウンロードを促しません。**利用者向けの配布は必ず `Release Helper` ワークフローから行ってください。**
