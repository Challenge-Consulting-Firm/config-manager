#!/usr/bin/env bash
#
# ローカル取得ヘルパー（Go 製ポータブルアプリ）のクロスビルド・checksum・
# latest.json 生成・BFF 配布ディレクトリへのコピーを行う。
#
# 設計は Issue #43 の最終コメント（確定設計）を参照。
#
# 成果物:
#   apps/bff/public/downloads/helper/
#     latest.json                              （URL + sha256 のメタデータ）
#     checksums.sha256                         （全成果物の SHA-256）
#     windows-x64/config-manager-helper.exe    （Windows 64-bit）
#     darwin-universal/config-manager-helper   （macOS Universal・lipo 結合）
#
# 使い方:
#   ./scripts/build-helper.sh                  # バージョンは go.mod から取得
#   ./scripts/build-helper.sh 0.2.0            # バージョン明示
#   HELPER_OUT_DIR=/tmp/helper ./scripts/build-helper.sh   # 出力先変更
#
# 前提:
#   - Go 1.21+ がインストールされていること
#   - macOS universal 生成には lipo（macOS 標準）が必要。Linux 環境で lipo が
#     無い場合は darwin-arm64 / darwin-amd64 を個別に出力して終了する。
#
# 注意:
#   本スクリプトはバイナリを BFF 同梱（apps/bff/public/downloads/helper/）へ
#   配置する。GitHub Releases を第一候補とする場合は、このスクリプトで生成した
#   バイナリを GitHub Release へアップロードし、latest.json の URL を公開 URL
#   に書き換えること（環境変数 HELPER_RELEASE_BASE_URL で切替可能）。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER_SRC="$ROOT_DIR/apps/helper"
OUT_DIR="${HELPER_OUT_DIR:-$ROOT_DIR/apps/bff/public/downloads/helper}"
VERSION="${1:-}"
RELEASE_BASE_URL="${HELPER_RELEASE_BASE_URL:-}"  # 空なら BFF 同梱（相対 URL）

# Go が無い場合は明確にエラーにする。
if ! command -v go >/dev/null 2>&1; then
  echo "[build-helper] エラー: Go がインストールされていません。https://go.dev/dl/ から導入してください。" >&2
  exit 1
fi

cd "$HELPER_SRC"

# バージョン解決: 引数 > git tag > go.mod の module コメント（無ければ 0.0.0）。
if [[ -z "$VERSION" ]]; then
  if VERSION="$(git -C "$ROOT_DIR" describe --tags --abbrev=0 2>/dev/null)"; then
    VERSION="${VERSION#v}"  # 先頭の v を除去
  else
    # go.mod からは直接取れないため、ヘルパーの Version 定数に埋め込まれた値を
    # 想定せず、最終手段で 0.0.0 + 日付とする。
    VERSION="0.0.0-dev"
  fi
fi
echo "[build-helper] version=$VERSION out=$OUT_DIR"

# 依存解決（go.sum が未整備な環境向け）。
if [[ -f go.mod ]]; then
  go mod download 2>/dev/null || true
fi

mkdir -p "$OUT_DIR/windows-x64" "$OUT_DIR/darwin-universal"

# 共通ビルドフラグ。CGO_ENABLED=0 で静的バイナリ（クロスコンパイル容易化）。
# -ldflags -X で以下をビルド時に注入する:
#   1. Version（internal/server.Version）: latest.json の version と同一値
#   2. BuildTimeAllowedOrigin（internal/server.BuildTimeAllowedOrigin）:
#      本番 SPA の origin。配布バイナリで PUBLIC_BASE_URL 環境変数に依存しない
#      よう、ビルド時に埋め込む。HELPER_ALLOWED_ORIGIN 環境変数で指定する
#      （未指定時は空文字＝開発用 localhost のみ許可）。
SERVER_PKG="github.com/Challenge-Consulting-Firm/config-manager/apps/helper/internal/server"
LDFLAGS="-s -w -X ${SERVER_PKG}.Version=${VERSION}"
if [[ -n "${HELPER_ALLOWED_ORIGIN:-}" ]]; then
  LDFLAGS="$LDFLAGS -X ${SERVER_PKG}.BuildTimeAllowedOrigin=${HELPER_ALLOWED_ORIGIN}"
  echo "[build-helper] 許可 Origin をビルド時に注入します: $HELPER_ALLOWED_ORIGIN"
else
  echo "[build-helper] 警告: HELPER_ALLOWED_ORIGIN 未設定のため、配布バイナリは開発用 localhost のみ許可します（本番 SPA から呼べません）" >&2
fi
BUILD_ENV="CGO_ENABLED=0"

build_one() {
  local goos="$1" goarch="$2" outfile="$3"
  echo "[build-helper] building $goos/$goarch -> $outfile"
  env $BUILD_ENV GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "$LDFLAGS" -o "$outfile" ./cmd/helper
}

# Windows x64
WIN_EXE="$OUT_DIR/windows-x64/config-manager-helper.exe"
build_one windows amd64 "$WIN_EXE"

# macOS arm64 / amd64
MAC_ARM="$OUT_DIR/darwin-universal/config-manager-helper-arm64"
MAC_AMD="$OUT_DIR/darwin-universal/config-manager-helper-amd64"
build_one darwin arm64 "$MAC_ARM"
build_one darwin amd64 "$MAC_AMD"

# macOS universal（lipo で結合）。lipo が無ければ個別バイナリを残す。
MAC_UNI="$OUT_DIR/darwin-universal/config-manager-helper"
if command -v lipo >/dev/null 2>&1; then
  echo "[build-helper] creating darwin universal via lipo"
  lipo -create -output "$MAC_UNI" "$MAC_ARM" "$MAC_AMD"
  rm -f "$MAC_ARM" "$MAC_AMD"
else
  echo "[build-helper] warning: lipo が無いため darwin universal を生成せず、arm64/amd64 個別バイナリを残します" >&2
fi

# ----- 署名（Issue #79） -----
#
# 署名は「配布物のすり替え」を利用者側で検出できる唯一の仕組みであり、
# ここが未設定のまま公開してはいけない。設定されている場合のみ実行し、
# 途中で失敗したらビルド全体を失敗させる（未署名の成果物を残さない）。
#
#   Windows: HELPER_WINDOWS_PFX（.pfx のパス）+ HELPER_WINDOWS_PFX_PASSWORD
#            osslsigncode（Linux/macOS）または signtool（Windows）を使う
#   macOS:   HELPER_MACOS_SIGN_IDENTITY（"Developer ID Application: ..."）
#            HELPER_MACOS_NOTARY_PROFILE（notarytool の keychain profile 名）
#
# HELPER_REQUIRE_SIGNING=1 を指定すると、署名設定が無い場合にエラーで停止する。
# リリース用ビルド（CI）では必ず 1 を指定すること。
WINDOWS_SIGNATURE="none"
MACOS_SIGNATURE="none"

sign_windows() {
  local target="$1"
  if [[ -z "${HELPER_WINDOWS_PFX:-}" ]]; then
    return 0
  fi
  echo "[build-helper] signing (authenticode): $target"
  if command -v osslsigncode >/dev/null 2>&1; then
    local tmp="${target}.signed"
    osslsigncode sign \
      -pkcs12 "$HELPER_WINDOWS_PFX" \
      -pass "${HELPER_WINDOWS_PFX_PASSWORD:-}" \
      -n "config-manager helper" \
      -i "https://github.com/Challenge-Consulting-Firm/config-manager" \
      -ts "${HELPER_WINDOWS_TIMESTAMP_URL:-http://timestamp.digicert.com}" \
      -in "$target" -out "$tmp"
    mv "$tmp" "$target"
    # 署名が実際に付いたことを検証する（付いていなければここで失敗させる）。
    osslsigncode verify -in "$target" >/dev/null
  elif command -v signtool >/dev/null 2>&1; then
    signtool sign /fd SHA256 /f "$HELPER_WINDOWS_PFX" \
      /p "${HELPER_WINDOWS_PFX_PASSWORD:-}" \
      /tr "${HELPER_WINDOWS_TIMESTAMP_URL:-http://timestamp.digicert.com}" /td SHA256 "$target"
    signtool verify /pa "$target"
  else
    echo "[build-helper] エラー: osslsigncode / signtool が見つかりません（Windows 署名に必要）" >&2
    exit 1
  fi
  WINDOWS_SIGNATURE="authenticode"
}

sign_macos() {
  local target="$1"
  if [[ -z "${HELPER_MACOS_SIGN_IDENTITY:-}" ]]; then
    return 0
  fi
  if ! command -v codesign >/dev/null 2>&1; then
    echo "[build-helper] エラー: codesign が見つかりません（macOS 署名は macOS 上で実行してください）" >&2
    exit 1
  fi
  echo "[build-helper] signing (developer id): $target"
  # --options runtime（hardened runtime）は notarization の必須条件。
  codesign --force --timestamp --options runtime \
    --sign "$HELPER_MACOS_SIGN_IDENTITY" "$target"
  codesign --verify --strict --verbose=2 "$target"
  MACOS_SIGNATURE="developer-id"

  if [[ -z "${HELPER_MACOS_NOTARY_PROFILE:-}" ]]; then
    echo "[build-helper] 警告: HELPER_MACOS_NOTARY_PROFILE 未設定のため notarization を行いません（Gatekeeper にブロックされます）" >&2
    return 0
  fi
  # notarytool は単体バイナリを直接受け取れないため zip で提出する。
  # 単体の Mach-O には stapler でチケットを埋め込めない仕様のため、
  # Gatekeeper はオンラインで notarization を検証する。
  local zip="${target}.notarize.zip"
  ditto -c -k --keepParent "$target" "$zip"
  echo "[build-helper] notarizing: $target"
  xcrun notarytool submit "$zip" --keychain-profile "$HELPER_MACOS_NOTARY_PROFILE" --wait
  rm -f "$zip"
  MACOS_SIGNATURE="developer-id-notarized"
}

sign_windows "$WIN_EXE"
if [[ -f "$MAC_UNI" ]]; then
  sign_macos "$MAC_UNI"
else
  [[ -f "$MAC_ARM" ]] && sign_macos "$MAC_ARM"
  [[ -f "$MAC_AMD" ]] && sign_macos "$MAC_AMD"
fi

if [[ "${HELPER_REQUIRE_SIGNING:-0}" == "1" ]]; then
  if [[ "$WINDOWS_SIGNATURE" == "none" || "$MACOS_SIGNATURE" != "developer-id-notarized" ]]; then
    echo "[build-helper] エラー: HELPER_REQUIRE_SIGNING=1 ですが署名が完了していません（windows=$WINDOWS_SIGNATURE macos=$MACOS_SIGNATURE）。未署名の成果物は公開しません。" >&2
    exit 1
  fi
fi
if [[ "$WINDOWS_SIGNATURE" == "none" && "$MACOS_SIGNATURE" == "none" ]]; then
  echo "[build-helper] 警告: 未署名ビルドです。配布用のリリースは .github/workflows/release-helper.yml（署名付き）から作成してください。" >&2
fi

# ----- checksums.sha256 / latest.json -----
#
# 署名後のファイルからハッシュを取る（署名でファイル内容が変わるため、順序が逆だと
# 利用者側の照合が必ず失敗する）。生成は scripts/helper-release-manifest.sh に集約し、
# 署名付きリリース（CI）とローカルビルドで同じ実装を使う。
"$ROOT_DIR/scripts/helper-release-manifest.sh" \
  --dir "$OUT_DIR" \
  --version "$VERSION" \
  --base-url "$RELEASE_BASE_URL" \
  --windows-signature "$WINDOWS_SIGNATURE" \
  --macos-signature "$MACOS_SIGNATURE"

echo "[build-helper] done. 成果物:"
( cd "$OUT_DIR" && find . -type f | sort )
