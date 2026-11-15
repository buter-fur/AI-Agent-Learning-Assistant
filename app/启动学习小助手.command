#!/bin/bash
# 双击启动：起本地卡片站，然后把浏览器打开。
cd "$(dirname "$0")" || exit 1

need() { echo "缺少 $1。请先安装：$2"; echo; read -r -p "按回车退出"; exit 1; }
command -v node >/dev/null 2>&1 || need "Node.js" "brew install node  （需要 ≥22.5）"
[ -f data/cards.db ] || echo "提示：还没有卡片，先跑 node src/scan.mjs && node src/ingest.mjs"

# 知识库服务（可选）：没起就试着起，失败不影响卡片站
if ! curl -s --max-time 0.5 http://127.0.0.1:8790/health >/dev/null 2>&1; then
  if [ -x "$HOME/rag/.venv/bin/python" ] && [ -f "$HOME/rag/kb_server.py" ]; then
    (cd "$HOME/rag" && nohup ./.venv/bin/python kb_server.py > /tmp/kb-server.log 2>&1 &)
    sleep 1
  fi
fi

find_running() {
  for p in $(seq 4780 4799); do
    if curl -s --max-time 0.3 "http://127.0.0.1:$p/api/health" | grep -q '"ok":true'; then
      echo "$p"; return 0
    fi
  done
  return 1
}

# 已经开着就直接打开，不再起第二个
if P=$(find_running); then
  echo "学习小助手已经在运行：http://127.0.0.1:$P"
  open "http://127.0.0.1:$P" 2>/dev/null
  exit 0
fi

node src/serve.mjs >> data/serve.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

URL=""
for i in $(seq 1 40); do
  for p in $(seq 4780 4799); do
    if curl -s --max-time 0.4 "http://127.0.0.1:$p/api/health" | grep -q '"ok":true'; then
      URL="http://127.0.0.1:$p"; break
    fi
  done
  [ -n "$URL" ] && break
  sleep 0.25
done

if [ -z "$URL" ]; then
  echo "服务没能起来。看看 data/serve.log："
  tail -n 20 data/serve.log
  read -r -p "按回车退出"
  exit 1
fi

echo "学习小助手：$URL"
echo "（关掉这个终端窗口就会停止服务；卡片都在本地，不上传。）"
open "$URL" 2>/dev/null || echo "请手动打开：$URL"
wait $SERVER_PID
