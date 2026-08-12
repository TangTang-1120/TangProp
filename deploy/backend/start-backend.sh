#!/bin/zsh
# 从系统终端启动后端（豆包 Seedream 需直连网络，勿走 Cursor 内置代理）
cd "$(dirname "$0")"
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export PORT="${PORT:-8080}"
if [[ -f .env ]]; then set -a; source .env; set +a; fi
echo "Starting TangProp backend on http://127.0.0.1:${PORT}"
exec ./venv/bin/python main.py
