#!/bin/bash
# ============================================================
# TangProp — 一键部署脚本（腾讯云 CVM）
# ============================================================
# 使用方式：
#   1. 将整个 deploy 目录上传到服务器
#   2. 在服务器上执行: bash deploy.sh
# ============================================================
set -e

echo "========================================"
echo "  TangProp 部署脚本"
echo "========================================"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── 检查 .env ──
if [ ! -f "backend/.env" ]; then
    echo ""
    echo "  ⚠️  未找到 backend/.env 文件"
    echo "  请先复制模板并填写配置:"
    echo ""
    echo "    cp backend/.env.example backend/.env"
    echo "    vi backend/.env"
    echo ""
    echo "  填好后再运行此脚本"
    exit 1
fi

echo "[✓] 检测到 .env 配置文件"

# ── 检查 Docker ──
if command -v docker &> /dev/null; then
    echo "[✓] 检测到 Docker"
    
    echo ""
    echo "  选择部署方式:"
    echo "    1) Docker 部署（推荐）"
    echo "    2) 直接运行（需要 Python 3.12+）"
    echo ""
    read -p "  请选择 [1/2]: " choice
    
    if [ "$choice" = "1" ] || [ -z "$choice" ]; then
        echo ""
        echo "  → 构建 Docker 镜像..."
        docker build -t tangprop:latest backend/
        
        echo "  → 停止旧容器（如有）..."
        docker rm -f tangprop 2>/dev/null || true
        
        echo "  → 启动容器..."
        docker run -d \
            --name tangprop \
            --restart unless-stopped \
            -p 8080:8080 \
            --env-file backend/.env \
            -v "$SCRIPT_DIR/backend/.env:/app/.env:ro" \
            tangprop:latest
        
        echo ""
        echo "========================================"
        echo "  ✅ 部署完成！"
        echo "========================================"
        echo ""
        echo "  访问地址: http://$(hostname -I | awk '{print $1}'):8080"
        echo "  健康检查: http://$(hostname -I | awk '{print $1}'):8080/health"
        echo "  API 文档: http://$(hostname -I | awk '{print $1}'):8080/docs"
        echo ""
        echo "  查看日志: docker logs -f tangprop"
        echo "  停止服务: docker stop tangprop"
        echo "  重启服务: docker restart tangprop"
        echo ""
        exit 0
    fi
fi

# ── 直接运行模式 ──
echo ""
echo "  → 直接运行模式"

# 检查 Python
PYTHON=""
for p in python3 python; do
    if command -v $p &> /dev/null; then
        version=$($p --version 2>&1 | awk '{print $2}')
        major=$(echo $version | cut -d. -f1)
        minor=$(echo $version | cut -d. -f2)
        if [ "$major" -ge 3 ] && [ "$minor" -ge 10 ]; then
            PYTHON=$p
            break
        fi
    fi
done

if [ -z "$PYTHON" ]; then
    echo "  [✗] 需要 Python 3.10+，请先安装"
    exit 1
fi

echo "[✓] 使用 $PYTHON ($($PYTHON --version 2>&1))"

# 创建虚拟环境
if [ ! -d "venv" ]; then
    echo "  → 创建虚拟环境..."
    $PYTHON -m venv venv
fi

# 安装依赖
echo "  → 安装依赖..."
./venv/bin/pip install --upgrade pip -q
./venv/bin/pip install -r backend/requirements.txt -q

# 启动
echo ""
echo "========================================"
echo "  ✅ 部署完成！"
echo "========================================"
echo ""
echo "  启动服务: cd backend && ../venv/bin/python main.py"
echo "  或使用:  nohup ./venv/bin/python backend/main.py &"
echo ""

# 询问是否立即启动
read -p "  是否立即启动？[Y/n]: " start_now
if [ "$start_now" != "n" ] && [ "$start_now" != "N" ]; then
    echo "  → 启动服务..."
    cd backend
    exec ../venv/bin/python main.py
fi
