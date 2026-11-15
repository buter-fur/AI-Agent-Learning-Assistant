#!/bin/sh
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "需要 Node.js 22.5 以上：https://nodejs.org"; exit 1; }
[ -f data/cards.db ] || echo "提示：还没有卡片，先跑 node src/scan.mjs && node src/ingest.mjs"
exec node src/serve.mjs --open
