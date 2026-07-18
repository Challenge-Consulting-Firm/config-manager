#!/usr/bin/env sh
# start.sh で起動したローカル検証コンテナ（cm-local）を止める。
# start.sh は --rm 付きで起動するため、通常は stop すれば自動で削除される。
# 念のため ancestor=cm-local で絞り込み、停止 → 削除まで実施する。
# イメージ（cm-local:latest）は残すので、次回の start.sh は再ビルド不要。

set -e

RUNNING=$(docker ps -q -f "ancestor=cm-local")
ALL=$(docker ps -aq -f "ancestor=cm-local")

if [ -z "$RUNNING" ] && [ -z "$ALL" ]; then
  echo "cm-local コンテナは起動していません。"
  exit 0
fi

if [ -n "$RUNNING" ]; then
  echo "コンテナを停止します: $RUNNING"
  docker stop $RUNNING >/dev/null
fi

# --rm 付きで起動している場合は停止時に自動削除されるが、
# 手動起動や異常終了で残っていたコンテナを扫除する。
REMAINING=$(docker ps -aq -f "ancestor=cm-local")
if [ -n "$REMAINING" ]; then
  echo "残存コンテナを削除します: $REMAINING"
  docker rm -f $REMAINING >/dev/null
fi

echo "停止完了。"
