#!/bin/bash
# ============================================================
# TangProp — 服务器端非交互部署（systemd 单实例托管）
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
PORT="${PORT:-8080}"

if [ ! -f "backend/.env" ]; then
    echo "[✗] 缺少 backend/.env，请先配置 API Key"
    exit 1
fi

echo "[✓] backend/.env 已就绪"

if [ "${DEPLOY_MODE:-}" = "docker" ] && command -v docker &>/dev/null; then
    echo "→ Docker 部署..."
    systemctl stop tangprop 2>/dev/null || true
    docker build -t tangprop:latest backend/
    docker rm -f tangprop 2>/dev/null || true
    docker run -d \
        --name tangprop \
        --restart unless-stopped \
        -p "${PORT}:8080" \
        --env-file backend/.env \
        -v "$SCRIPT_DIR/backend/.env:/app/.env:ro" \
        tangprop:latest
    docker ps --filter name=tangprop
    exit 0
fi

echo "→ systemd 托管（单实例）..."
PYTHON=""
for p in python3.12 python3.11 python3 python; do
    if command -v "$p" &>/dev/null; then
        PYTHON="$p"
        break
    fi
done
[ -n "$PYTHON" ] || { echo "[✗] 需要 Python 3.10+"; exit 1; }

[ -d venv ] || $PYTHON -m venv venv
./venv/bin/pip install -q --upgrade pip
./venv/bin/pip install -q -r backend/requirements.txt

cat > /etc/systemd/system/tangprop.service << EOF
[Unit]
Description=TangProp Backend
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${SCRIPT_DIR}/backend
EnvironmentFile=${SCRIPT_DIR}/backend/.env
Environment=PORT=${PORT}
ExecStartPre=-/usr/bin/fuser -k ${PORT}/tcp
ExecStart=${SCRIPT_DIR}/venv/bin/python main.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable tangprop
systemctl restart tangprop
sleep 2

if systemctl is-active --quiet tangprop; then
    echo "[✓] tangprop.service 运行中"
    curl -sf "http://127.0.0.1:${PORT}/health" && echo ""
else
    echo "[✗] 启动失败，最近日志："
    journalctl -u tangprop -n 30 --no-pager
    exit 1
fi
