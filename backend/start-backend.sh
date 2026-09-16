#!/bin/zsh
cd "$(dirname "$0")"
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
[[ -f .env ]] && set -a && source .env && set +a
export PORT="${PORT:-8080}"
export PATH="/Users/tangtang/Library/Python/3.9/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

for pid in $(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null); do
  [[ "$pid" == "$$" ]] && continue
  echo "释放端口 ${PORT}（结束 PID ${pid}）"
  kill -9 "$pid" 2>/dev/null
done
sleep 0.5

PY="./venv/bin/python"
[[ -x "$PY" ]] || PY="/usr/bin/python3"
echo "▶ TangProp 后端 → http://127.0.0.1:${PORT} ($PY)"
exec "$PY" main.py
