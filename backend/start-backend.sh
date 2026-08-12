#!/bin/zsh
# 一键启动 TangProp 后端（清代理 + 确保 8080 单实例）
cd "$(dirname "$0")"
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
[[ -f .env ]] && set -a && source .env && set +a
export PORT="${PORT:-8080}"

# 释放端口，避免 launchd/systemd 与手动启动冲突导致反复崩溃
for pid in $(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null); do
  [[ "$pid" == "$$" ]] && continue
  echo "释放端口 ${PORT}（结束 PID ${pid}）"
  kill -9 "$pid" 2>/dev/null
done
sleep 0.5

echo "▶ TangProp 后端 → http://127.0.0.1:${PORT}"
exec ./venv/bin/python main.py
