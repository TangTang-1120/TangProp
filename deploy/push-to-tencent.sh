#!/bin/bash
# ============================================================
# TangProp — 从本机推送到腾讯云 CVM
# ============================================================
# 用法:
#   bash push-to-tencent.sh <服务器IP> [ssh用户，默认 root]
#   或: TANGPROP_SERVER=1.2.3.4 bash push-to-tencent.sh
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_BACKEND="/Users/tangtang/Desktop/TangProp/backend"
SOURCE_FRONTEND="/Users/tangtang/Desktop/TangProp/frontend/tangprop.html"
LIVE_ENV="/Users/tangtang/Desktop/2026-07-29-09-06-35/workbuddy-backend/.env"

SERVER="${1:-${TANGPROP_SERVER:-}}"
SSH_USER="${2:-${TANGPROP_SSH_USER:-root}}"
REMOTE_DIR="${TANGPROP_REMOTE_DIR:-/opt/tangprop}"
SSH_KEY="${TANGPROP_SSH_KEY:-$HOME/.ssh/tangtang_deploy}"
SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new)

if [ -z "$SERVER" ]; then
    echo "用法: bash push-to-tencent.sh <腾讯云公网IP> [ssh用户]"
    echo "示例: bash push-to-tencent.sh 43.xxx.xxx.xxx root"
    exit 1
fi

echo "========================================"
echo "  TangProp → 腾讯云部署"
echo "  目标: ${SSH_USER}@${SERVER}:${REMOTE_DIR}"
echo "========================================"

echo "[1/4] 同步最新代码到 deploy 包..."
rsync -a --delete \
    --exclude 'venv/' \
    --exclude '__pycache__/' \
    --exclude '.workbuddy/' \
    --exclude '*.pyc' \
    "$SOURCE_BACKEND/" "$SCRIPT_DIR/backend/"

cp "$SOURCE_FRONTEND" "$SCRIPT_DIR/tangprop.html"
cp "$SOURCE_FRONTEND" "$SCRIPT_DIR/backend/static/index.html"

if [ -f "$LIVE_ENV" ]; then
    cp "$LIVE_ENV" "$SCRIPT_DIR/backend/.env"
    echo "[✓] 已同步 live .env"
else
    echo "[!] 未找到 live .env，请确保服务器上 backend/.env 已配置"
fi

echo "[2/4] 上传到腾讯云..."
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SERVER}" "mkdir -p ${REMOTE_DIR}"
rsync -avz -e "ssh ${SSH_OPTS[*]}" --delete \
    --exclude 'venv/' \
    --exclude '__pycache__/' \
    --exclude '.workbuddy/' \
    --exclude '.playwright-cli/' \
    "$SCRIPT_DIR/" "${SSH_USER}@${SERVER}:${REMOTE_DIR}/"

echo "[3/4] 远程部署..."
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SERVER}" "cd ${REMOTE_DIR} && DEPLOY_MODE=docker bash deploy-remote.sh"

echo "[4/4] 健康检查..."
sleep 3
HEALTH=$(ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SERVER}" "curl -s http://127.0.0.1:8080/health" || true)
echo ""
echo "========================================"
echo "  ✅ 部署完成"
echo "========================================"
echo "  访问: http://${SERVER}:8080"
echo "  健康: ${HEALTH:-（请手动检查）}"
echo ""
