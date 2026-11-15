#!/bin/bash
# 双击：检查 config.json 里的 key 是否可用（只花几个 token）
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 22.13 以上：https://nodejs.org"
  echo
  read -r -p "按回车关闭窗口" _
  exit 1
fi
node -e 'const v=process.versions.node.split(".").map(Number); process.exit(v[0]>22||(v[0]===22&&v[1]>=13)?0:1)' || { echo "Node.js 版本太低，需要 22.13 以上"; read -r -p "按回车关闭窗口" _; exit 1; }
echo "目录：$(pwd)"
echo
node src/generate.mjs --check
echo
read -r -p "按回车关闭窗口" _
