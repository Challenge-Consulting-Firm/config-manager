#!/usr/bin/env bash
#
# 既にビルド（および署名）済みのヘルパー成果物から checksums.sha256 と
# latest.json を生成する。
#
# scripts/build-helper.sh（ローカルビルド）と
# .github/workflows/release-helper.yml（署名付きリリース）の両方から呼ばれる。
# 生成物は「いま存在するファイル」からハッシュを取るため、署名対象と公開対象が
# 同一 artifact であることが保証される（Issue #79）。署名後に本スクリプトを
# 実行すること。署名前のハッシュを配ると、利用者の照合が必ず失敗する。
#
# 使い方:
#   scripts/helper-release-manifest.sh --dir OUT_DIR --version 0.4.0 \
#     [--base-url https://github.com/.../download/helper-v0.4.0] \
#     [--windows-signature authenticode] \
#     [--macos-signature developer-id-notarized]
#
# 署名種別（--*-signature）は latest.json に載せ、SPA が利用者へ検証手順を
# 提示するために使う。省略時は "none"（未署名）。
set -euo pipefail

OUT_DIR=""
VERSION=""
BASE_URL=""
WINDOWS_SIGNATURE="none"
MACOS_SIGNATURE="none"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) OUT_DIR="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    --windows-signature) WINDOWS_SIGNATURE="$2"; shift 2 ;;
    --macos-signature) MACOS_SIGNATURE="$2"; shift 2 ;;
    *) echo "[helper-manifest] エラー: 不明な引数: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$OUT_DIR" || -z "$VERSION" ]]; then
  echo "[helper-manifest] エラー: --dir と --version は必須です" >&2
  exit 2
fi
if [[ ! -d "$OUT_DIR" ]]; then
  echo "[helper-manifest] エラー: ディレクトリがありません: $OUT_DIR" >&2
  exit 1
fi

# SHA-256 の計算。Linux は sha256sum、macOS は shasum -a 256。
sha256_of() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    echo "[helper-manifest] エラー: sha256sum / shasum のどちらもありません" >&2
    exit 1
  fi
}

# 配布アセットの定義: key|OUT_DIR からの相対パス|署名種別
ASSET_DEFS=(
  "windows-x64|windows-x64/config-manager-helper.exe|$WINDOWS_SIGNATURE"
  "darwin-universal|darwin-universal/config-manager-helper|$MACOS_SIGNATURE"
  "darwin-arm64|darwin-universal/config-manager-helper-arm64|$MACOS_SIGNATURE"
  "darwin-amd64|darwin-universal/config-manager-helper-amd64|$MACOS_SIGNATURE"
)

# 実在するアセットだけを対象にする（lipo の有無で universal / 個別が変わる）。
PRESENT=()
for def in "${ASSET_DEFS[@]}"; do
  rel="${def#*|}"
  rel="${rel%%|*}"
  if [[ -f "$OUT_DIR/$rel" ]]; then
    PRESENT+=("$def")
  fi
done

if [[ ${#PRESENT[@]} -eq 0 ]]; then
  echo "[helper-manifest] エラー: $OUT_DIR に配布アセットが 1 つもありません" >&2
  exit 1
fi

# checksums.sha256（sha256sum -c / shasum -c で照合できる形式）。
CHECKSUMS="$OUT_DIR/checksums.sha256"
: > "$CHECKSUMS"
for def in "${PRESENT[@]}"; do
  rel="${def#*|}"
  rel="${rel%%|*}"
  printf '%s  %s\n' "$(sha256_of "$OUT_DIR/$rel")" "$rel" >> "$CHECKSUMS"
done
echo "[helper-manifest] wrote $CHECKSUMS"

url_for() {
  local rel="$1"
  if [[ -n "$BASE_URL" ]]; then
    echo "${BASE_URL%/}/$rel"
  else
    echo "/downloads/helper/$rel"
  fi
}

NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
{
  echo "{"
  echo "  \"version\": \"$VERSION\","
  echo "  \"releasedAt\": \"$NOW\","
  echo "  \"assets\": {"
  first=1
  for def in "${PRESENT[@]}"; do
    key="${def%%|*}"
    rest="${def#*|}"
    rel="${rest%%|*}"
    signature="${rest#*|}"
    if [[ $first -eq 0 ]]; then echo ","; fi
    printf '    "%s": {\n      "url": "%s",\n      "sha256": "%s",\n      "signature": "%s"\n    }' \
      "$key" "$(url_for "$rel")" "$(sha256_of "$OUT_DIR/$rel")" "$signature"
    first=0
  done
  echo
  echo "  }"
  echo "}"
} > "$OUT_DIR/latest.json"
echo "[helper-manifest] wrote $OUT_DIR/latest.json"
