#!/usr/bin/env bash
# =============================================================================
# fly.io 標準デプロイスクリプト (config-manager)
#
# 本スクリプトは docs/DEPLOY.md に記載の標準手順を自動化したものです。
# 初回・更新どちらも同じコマンドで実行できるよう冪等性を担保しています。
#
# 主な機能:
#   1. 前提チェック (fly CLI / ログイン状態 / fly.toml / .env)
#   2. fly アプリの存在確認 (未作成時は fly launch を案内して終了)
#   3. オプション: --set-secret KEY=VALUE で個別シークレット設定
#   4. fly deploy (fly.toml を維持)
#   5. デプロイ後のヘルスチェック (/healthz)
#   6. オプション: --rollback でリリース履歴と安全な復旧手順を表示する
#
# ⚠️ .env 一括同期 (旧 --sync-secrets) は廃止しました。
#    ローカル開発用 .env (AUTH_MODE=disabled 等) で本番シークレットを
#    上書きしてしまう事故を防ぐため、シークレットは必ず個別に設定してください。
#
# 使い方:
#   # 通常の更新デプロイ
#   bash scripts/fly-deploy.sh
#
#   # 個別シークレットの設定 (例: Meraki API キー追加)
#   bash scripts/fly-deploy.sh --set-secret MERAKI_API_KEY=xxxxxxxxxxxx
#
#   # 安全なロールバック手順を表示
#   bash scripts/fly-deploy.sh --rollback
#
#   # アプリ名を明示 (fly.toml を使わない場合)
#   bash scripts/fly-deploy.sh --app config-manager
# =============================================================================
set -euo pipefail

# --- 設定 --------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME=""
ROLLBACK=0
SECRET_ARGS=()

# fly.toml の app= 行からデフォルトアプリ名を拾う。
TOML_APP="$(grep -E '^app[[:space:]]*=' "$ROOT_DIR/fly.toml" 2>/dev/null | head -1 | sed -E 's/^app[[:space:]]*=[[:space:]]*["'"'"']?([^"'"'"']+).*$/\1/' || true)"

usage() {
  cat <<EOF
Usage: bash scripts/fly-deploy.sh [options]

Options:
  --app NAME              fly.io アプリ名 (既定: fly.toml の app= 値 = ${TOML_APP:-未検出})
  --set-secret K=V        fly secrets set を 1 件発行してからデプロイ (複数回指定可)
  --rollback              デプロイせず安全なロールバック手順を表示
  -h, --help              このヘルプを表示

注意:
  - 機密変数 (API キー・トークン・シークレット) は --set-secret で個別に設定してください。
  - .env はローカル検証専用です。本番の fly secrets と一致しないフィールドがあるため、
    一括同期 (.env → fly secrets) は廃止しました。
  - ローカル開発時は AUTH_MODE=disabled でも、本番では AUTH_MODE=oidc を維持してください。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      APP_NAME="${2:-}"
      shift 2
      ;;
    --set-secret)
      # = を含む KEY=VALUE 形式を 1 つ受け取る。複数回指定可。
      if [[ -z "${2:-}" || "$2" != *=* ]]; then
        echo "ERROR: --set-secret には KEY=VALUE 形式で指定してください: $2" >&2
        exit 2
      fi
      SECRET_ARGS+=("$2")
      shift 2
      ;;
    --rollback)
      ROLLBACK=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "不明なオプション: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

APP_NAME="${APP_NAME:-$TOML_APP}"
if [[ -z "$APP_NAME" ]]; then
  echo "ERROR: アプリ名が取得できません。--app で指定するか fly.toml に app= を設定してください。" >&2
  exit 2
fi

# --- カラー ------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_CYAN=$'\033[36m'
else
  C_RESET=""
  C_BOLD=""
  C_GREEN=""
  C_YELLOW=""
  C_RED=""
  C_CYAN=""
fi

log()   { echo "${C_BOLD}[$(date +%H:%M:%S)]${C_RESET} $*"; }
info()  { echo "${C_CYAN}[info]${C_RESET} $*"; }
ok()    { echo "${C_GREEN}[ok]${C_RESET} $*"; }
warn()  { echo "${C_YELLOW}[warn]${C_RESET} $*" >&2; }
fatal() { echo "${C_RED}[fatal]${C_RESET} $*" >&2; exit 1; }

# --- 1. 前提チェック ---------------------------------------------------------
log "前提チェックを開始します (app=${APP_NAME})"

if ! command -v fly >/dev/null 2>&1; then
  fatal "fly CLI がインストールされていません。https://fly.io/docs/hands-on/install-flyctl/ を参照してください。"
fi
ok "fly CLI を検出しました: $(command -v fly)"

if ! fly auth whoami >/dev/null 2>&1; then
  fatal "fly.io へログインしていません。'fly auth login' を実行してください。"
fi
FLY_USER="$(fly auth whoami 2>/dev/null || echo '')"
ok "ログイン済み: ${FLY_USER}"

if [[ ! -f "$ROOT_DIR/fly.toml" ]]; then
  fatal "fly.toml が見つかりません: $ROOT_DIR/fly.toml"
fi
ok "fly.toml を検出しました"

if [[ ! -f "$ROOT_DIR/.env" ]]; then
  warn ".env が見つかりません (.env.example をコピーして作成してください)。"
  warn "  cp .env.example .env"
fi
ok "ローカル検証用 .env の有無を確認しました (本番には影響しません)"

# --- 2. アプリ存在確認 -------------------------------------------------------
log "fly アプリの存在を確認しています..."
# fly apps list --json の "Name" フィールドを正規表現で拾う。
# fly CLI はバージョンによって "Name":"x" / "Name": "x" の両方を出力するため、
# コロン前後の空白を許容する正規表現を使う。
#
# 【重要】コマンド自体の失敗と「アプリが無い」を区別する。ここを一括で
# 「見つかりません」と扱うと、認証エラーやトークンのスコープ不足のときにも
# 初回セットアップ手順（fly launch）を案内してしまう。それに従うと本番とは
# 別の空アプリが作られ、fly.toml も書き換わる。
# デプロイトークンはアプリ単位にスコープされ org 全体の一覧を引けないため、
# 一覧が失敗しても即エラーにはせず、アプリ単体への到達性で確認し直す。
APPS_JSON="$(fly apps list --json 2>/dev/null || true)"
APP_FOUND=0
if grep -E "\"Name\"[[:space:]]*:[[:space:]]*\"${APP_NAME}\"" <<<"$APPS_JSON" >/dev/null 2>&1; then
  APP_FOUND=1
elif fly status --app "${APP_NAME}" >/dev/null 2>&1; then
  # 一覧は引けないがアプリ単体は見える（＝デプロイトークン運用）。
  APP_FOUND=1
  info "org 全体の一覧は取得できませんでしたが、アプリ単体へは到達できました。"
elif [[ -z "$APPS_JSON" ]]; then
  # 一覧もアプリ単体も取れない。アプリ未作成と認証失敗を区別できないため、
  # fly launch は案内せずここで止める。
  echo
  fatal "fly の API 呼び出しに失敗しました（認証切れ、またはトークンのスコープ不足の可能性があります）。
  次を実行して原因を切り分けてください:
    fly auth whoami
    fly apps list
    fly status --app ${APP_NAME}
  いずれも失敗する場合は 'fly auth logout && fly auth login'、
  それでも解決しない場合はダッシュボードで deploy token を発行し
  FLY_API_TOKEN に設定して再実行してください。
  ※ アプリが存在するのに 'fly launch' を実行すると別アプリが作られ
    fly.toml が書き換わります。存在確認が取れるまで実行しないでください。"
fi

if [[ "$APP_FOUND" -eq 0 ]]; then
  echo
  warn "fly アプリ '${APP_NAME}' が見つかりません。初回デプロイとしてセットアップが必要です。"
  echo
  cat <<EOF
${C_BOLD}初回セットアップ手順:${C_RESET}
  1. アプリを作成:
       fly launch --no-deploy --name ${APP_NAME}
     ※ fly.toml を上書きしないよう必ず --no-deploy を付け、プロンプトで
        "Would you like to tweak these settings before deployment?" は N で
        fly.toml を維持してください。

  2. シークレットを個別設定 (docs/DEPLOY.md 参照):
       fly secrets set --app ${APP_NAME} AUTH_MODE=oidc
       fly secrets set --app ${APP_NAME} NODE_ENV=production
       fly secrets set --app ${APP_NAME} PUBLIC_BASE_URL=https://${APP_NAME}.fly.dev
       fly secrets set --app ${APP_NAME} SESSION_SECRET=$(openssl rand -base64 32)
       fly secrets set --app ${APP_NAME} KINTONE_DOMAIN=...
       fly secrets set --app ${APP_NAME} KINTONE_CONFIG_APP_ID=...
       fly secrets set --app ${APP_NAME} KINTONE_CONFIG_APP_TOKEN=...
       fly secrets set --app ${APP_NAME} KINTONE_AUDIT_APP_ID=...
       fly secrets set --app ${APP_NAME} KINTONE_AUDIT_APP_TOKEN=...
       fly secrets set --app ${APP_NAME} ENTRA_TENANT_ID=...
       fly secrets set --app ${APP_NAME} ENTRA_CLIENT_ID=...
       fly secrets set --app ${APP_NAME} ENTRA_CLIENT_SECRET=...
       fly secrets set --app ${APP_NAME} ENTRA_REDIRECT_URI=https://${APP_NAME}.fly.dev/auth/callback

  3. デプロイ:
       bash scripts/fly-deploy.sh

詳細は docs/DEPLOY.md を参照してください。
EOF
  exit 1
fi
ok "fly アプリ '${APP_NAME}' は存在します"

# --- 3. ロールバック ---------------------------------------------------------
if [[ "$ROLLBACK" -eq 1 ]]; then
  warn "現在の flyctl には専用の rollback コマンドがありません。"
  warn "誤ったリリースへ戻さないよう、履歴から ImageRef を明示して再デプロイしてください。"
  echo
  fly releases --app "$APP_NAME" --image
  echo
  cat <<EOF
${C_BOLD}復旧手順:${C_RESET}
  1. 実行中・待機中のデプロイがないことを確認
  2. 上の履歴から戻し先の ImageRef を確認
  3. 次を実行:
       fly deploy --app ${APP_NAME} --image <ImageRef> --yes
  4. 復旧確認:
       curl https://${APP_NAME}.fly.dev/healthz
       fly status --app ${APP_NAME}

詳細は docs/DEPLOY.md の「ロールバック」を参照してください。
EOF
  exit 0
fi

# --- 4. 個別シークレット設定 -------------------------------------------------
if [[ ${#SECRET_ARGS[@]} -gt 0 ]]; then
  log "fly secrets set で ${#SECRET_ARGS[@]} 件のシークレットを設定します..."
  for kv in "${SECRET_ARGS[@]}"; do
    KEY="${kv%%=*}"
    info "  設定: ${KEY}=(非表示)"
  done
  fly secrets set --app "$APP_NAME" "${SECRET_ARGS[@]}"
  ok "シークレットを設定しました (ローリング再デプロイが走ります)"
fi

# --- 5. デプロイ -------------------------------------------------------------
log "fly deploy を実行します..."
# 最近の fly CLI (v0.4 以降) では --no-generate フラグは廃止され、
# fly.toml が存在する場合は自動的にそれを使用して上書きしない挙動になった。
# --yes はプロンプト確認をスキップ。
fly deploy --app "$APP_NAME" --yes
ok "fly deploy が完了しました"

# --- 6. ヘルスチェック -------------------------------------------------------
log "ヘルスチェック (/healthz) を実行しています..."
# fly.toml の primary_region 等は使わず、アプリに紐づく最初の公開 URL を使う。
# apps show の Hostname 行から取得を試みる。
HOSTNAME="$(fly apps show --app "$APP_NAME" 2>/dev/null | grep -E '^Hostname' | head -1 | awk '{print $2}' || true)"
if [[ -z "$HOSTNAME" ]]; then
  HOSTNAME="${APP_NAME}.fly.dev"
  warn "ホスト名が取得できなかったため推定値を使います: ${HOSTNAME}"
fi
HEALTH_URL="https://${HOSTNAME}/healthz"
info "GET ${HEALTH_URL}"
# curl が無ければスキップ。
if command -v curl >/dev/null 2>&1; then
  HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$HEALTH_URL" || echo '000')"
  if [[ "$HTTP_CODE" == "200" ]]; then
    ok "ヘルスチェック OK (HTTP 200) — ${HEALTH_URL}"
  else
    warn "ヘルスチェックが 200 以外を返しました (HTTP ${HTTP_CODE})。"
    warn "  'fly logs --app ${APP_NAME}' で起動ログを確認してください。"
    warn "  もし 'AUTH_MODE=disabled' の警告が出ていたら、本番用シークレットが"
    warn "  上書きされています。fly secrets set --app ${APP_NAME} AUTH_MODE=oidc で戻してください。"
  fi
else
  warn "curl が無いためヘルスチェックをスキップしました。手動で ${HEALTH_URL} を開いてください。"
fi

# --- 7. サマリ ---------------------------------------------------------------
echo
ok "デプロイ完了"
cat <<EOF
${C_BOLD}次のアクション:${C_RESET}
  - ログ確認:        fly logs --app ${APP_NAME}
  - ステータス確認:  fly status --app ${APP_NAME}
  - ロールバック手順: bash scripts/fly-deploy.sh --rollback
  - シークレット一覧: fly secrets list --app ${APP_NAME}

URL: https://${HOSTNAME}
EOF
