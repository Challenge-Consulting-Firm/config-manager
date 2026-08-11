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

# 成果物リスト（checksums.sha256 用）。
declare -a ARTIFACTS=()

build_one() {
  local goos="$1" goarch="$2" outfile="$3"
  echo "[build-helper] building $goos/$goarch -> $outfile"
  env $BUILD_ENV GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "$LDFLAGS" -o "$outfile" ./cmd/helper
  ARTIFACTS+=("$outfile")
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
  # lipo 結合で arm64/amd64 個別バイナリを削除したため、ARTIFACTS を
  # universal のみに再構成する（build_one で追加した個別バイナリは除外）。
  ARTIFACTS=("$WIN_EXE" "$MAC_UNI")
else
  echo "[build-helper] warning: lipo が無いため darwin universal を生成せず、arm64/amd64 個別バイナリを残します" >&2
  ARTIFACTS+=("$MAC_ARM" "$MAC_AMD")
fi

# checksums.sha256 生成（全成果物）。
CHECKSUMS="$OUT_DIR/checksums.sha256"
echo "[build-helper] writing $CHECKSUMS"
: > "$CHECKSUMS"
for f in "${ARTIFACTS[@]}"; do
  (cd "$(dirname "$f")" && sha256sum "$(basename "$f")") >> "$CHECKSUMS"
done

# latest.json 生成。RELEASE_BASE_URL が空なら BFF 同梱の相対パスを使う。
# BFF の GET /downloads/helper/* が配信する。
url_for() {
  local rel="$1"  # OUT_DIR からの相対パス
  if [[ -n "$RELEASE_BASE_URL" ]]; then
    # 末尾スラッシュを正規化して結合。
    echo "${RELEASE_BASE_URL%/}/$rel"
  else
    echo "/downloads/helper/$rel"
  fi
}

sha256_for() {
  (cd "$(dirname "$1")" && sha256sum "$(basename "$1")" | awk '{print $1}')
}

# アセットエントリ（key|relpath|filepath）を配列で構築し、実在するファイルのみ
# latest.json へ出力する。lipo の有無で universal / 個別バイナリが切り替わる。
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
# 各行は | 区切り: key|relpath|filepath（| はファイルパスに現れない前提）
ASSET_ROWS=()
ASSET_ROWS+=("windows-x64|windows-x64/config-manager-helper.exe|$WIN_EXE")
if [[ -f "$MAC_UNI" ]]; then
  ASSET_ROWS+=("darwin-universal|darwin-universal/config-manager-helper|$MAC_UNI")
fi
if [[ -f "$MAC_ARM" ]]; then
  ASSET_ROWS+=("darwin-arm64|darwin-universal/config-manager-helper-arm64|$MAC_ARM")
fi
if [[ -f "$MAC_AMD" ]]; then
  ASSET_ROWS+=("darwin-amd64|darwin-universal/config-manager-helper-amd64|$MAC_AMD")
fi

echo "[build-helper] writing latest.json"
{
  echo "{"
  echo "  \"version\": \"$VERSION\","
  echo "  \"releasedAt\": \"$NOW\","
  echo "  \"assets\": {"
  first=1
  for row in "${ASSET_ROWS[@]}"; do
    key="${row%%|*}"
    rest="${row#*|}"
    relpath="${rest%%|*}"
    filepath="${rest#*|}"
    url=$(url_for "$relpath")
    sha=$(sha256_for "$filepath")
    if [[ $first -eq 0 ]]; then echo ","; fi
    printf '    \"%s\": {\n      \"url\": \"%s\",\n      \"sha256\": \"%s\"\n    }' "$key" "$url" "$sha"
    first=0
  done
  echo
  echo "  }"
  echo "}"
} > "$OUT_DIR/latest.json"

echo "[build-helper] done. 成果物:"
( cd "$OUT_DIR" && find . -type f | sort )
