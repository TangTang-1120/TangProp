#!/bin/bash
# ============================================================
# TangProp Backend — 一键启动
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo "  TangProp Backend"
echo "========================================"

# ── Python 选择 ──
PYTHON="/Users/tangtang/.workbuddy/binaries/python/envs/default/bin/python3"
if [ -f "$PYTHON" ]; then
    echo "[✓] 使用托管 Python"
else
    echo "[✗] 未找到托管 Python，请先安装依赖"
    exit 1
fi

# ── .env 检查 ──
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo ""
    echo "  ⚠️  已创建 .env 文件"
    echo "  请编辑 .env 填入你的 API Key:"
    echo ""
    echo "    DeepSeek: DEEPSEEK_API_KEY=sk-xxx"
    echo "    OpenAI:   OPENAI_API_KEY=sk-xxx"
    echo ""
    echo "  编辑后重新运行: ./start.sh"
    exit 0
fi

# ── 导出环境变量 ──
set -a
source .env 2>/dev/null || true
set +a

echo "[✓] 配置已加载"

# ── 启动方式选择 ──
echo ""
echo "  选择启动模式:"
echo "    1) CLI 终端对话"
echo "    2) HTTP API 服务 (默认)"
echo ""

MODE="${1:-api}"
if [ "$MODE" = "cli" ] || [ "$MODE" = "1" ]; then
    echo "  → 启动 CLI 终端对话..."
    echo ""
    exec "$PYTHON" cli.py
else
    echo "  → 启动 HTTP API 服务..."
    echo ""
    echo "  Swagger UI: http://localhost:${PORT:-8080}/docs"
    echo "  Health:     http://localhost:${PORT:-8080}/health"
    echo "  Frontend:   打开 outputs/tangprop.html"
    echo ""
    exec "$PYTHON" -m uvicorn main:app --host 0.0.0.0 --port "${PORT:-8080}" --reload
fi
