#!/bin/sh
cd "$(dirname "$0")" || exit 1
mkdir -p data
command -v node >/dev/null 2>&1 || { echo "需要 Node.js 22.13 以上：https://nodejs.org"; exit 1; }
node -e 'const v=process.versions.node.split(".").map(Number); process.exit(v[0]>22||(v[0]===22&&v[1]>=13)?0:1)' || { echo "Node.js 版本太低，需要 22.13 以上：https://nodejs.org"; exit 1; }
[ -f data/cards.db ] || echo "提示：还没有卡片，先跑 node src/scan.mjs && node src/ingest.mjs"
exec node src/serve.mjs --open
