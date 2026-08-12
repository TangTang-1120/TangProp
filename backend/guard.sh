#!/bin/bash
# ============================================================
# TangProp Backend 守护启动脚本
# 三重防杀：setsid + nohup + disown
# 自动重启：进程退出后 3 秒自动拉起
# 健康检查：每 30 秒 curl /health，失败则重启
# ============================================================

BACKEND_DIR="/Users/tangtang/Desktop/TangProp/backend"
PYTHON="$BACKEND_DIR/venv/bin/python"
if [ ! -x "$PYTHON" ]; then
    PYTHON="/Users/tangtang/.workbuddy/binaries/python/envs/default/bin/python3"
fi
PID_FILE="/tmp/tangprop_backend.pid"
LOG_FILE="/tmp/tangprop_backend.log"
GUARD_LOG="/tmp/tangprop_guard.log"
PORT=8080
MAX_RESTART=10
RESTART_COUNT=0

# 清理旧进程
kill_old() {
    if [ -f "$PID_FILE" ]; then
        old_pid=$(cat "$PID_FILE" 2>/dev/null)
        if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
            echo "[$(date '+%H:%M:%S')] Killing old PID $old_pid..."
            kill -9 "$old_pid" 2>/dev/null
            sleep 1
        fi
        rm -f "$PID_FILE"
    fi
    # 也清理可能残留的 uvicorn 进程
    pkill -f "uvicorn.*main:app.*$PORT" 2>/dev/null
    sleep 1
}

# 启动后端（三重防杀）
start_backend() {
    cd "$BACKEND_DIR"
    
    # setsid: 创建新会话，脱离控制终端
    # nohup: 忽略 SIGHUP
    # & + 立即 disown: 脱离 job 表
    setsid nohup "$PYTHON" main.py > "$LOG_FILE" 2>&1 &
    local pid=$!
    disown $pid 2>/dev/null
    
    echo "$pid" > "$PID_FILE"
    echo "[$(date '+%H:%M:%S')] Started backend PID=$pid on port $PORT"
    
    # 等待启动（最多 15 秒）
    local waited=0
    while [ $waited -lt 15 ]; do
        sleep 1
        waited=$((waited + 1))
        if curl -s --noproxy '*' "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
            echo "[$(date '+%H:%M:%S')] Backend healthy after ${waited}s"
            return 0
        fi
        if ! kill -0 $pid 2>/dev/null; then
            echo "[$(date '+%H:%M:%S')] Backend died during startup (after ${waited}s)"
            return 1
        fi
    done
    echo "[$(date '+%H:%M:%S')] Backend started but health check not responding yet"
    return 0
}

# 健康检查
check_health() {
    local pid=$(cat "$PID_FILE" 2>/dev/null)
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
        return 1
    fi
    curl -s --noproxy '*' "http://127.0.0.1:$PORT/health" > /dev/null 2>&1
}

# 守护循环
guard_loop() {
    echo "[$(date '+%H:%M:%S')] === TangProp Guard Started ===" | tee -a "$GUARD_LOG"
    
    kill_old
    start_backend
    
    while true; do
        sleep 30
        
        if ! check_health; then
            RESTART_COUNT=$((RESTART_COUNT + 1))
            echo "[$(date '+%H:%M:%S')] Health check failed! Restart #$RESTART_COUNT" | tee -a "$GUARD_LOG"
            
            if [ $RESTART_COUNT -ge $MAX_RESTART ]; then
                echo "[$(date '+%H:%M:%S')] Max restarts ($MAX_RESTART) reached. Stopping guard." | tee -a "$GUARD_LOG"
                break
            fi
            
            kill_old
            sleep 3
            start_backend
        else
            # 健康的话每 10 分钟输出一次心跳
            local now=$(date '+%H:%M:%S')
            if [ $(( $(date '+%s') % 600 )) -lt 30 ]; then
                echo "[$now] Heartbeat OK"
            fi
        fi
    done
}

case "$1" in
    start)
        guard_loop &
        echo "Guard started in background"
        ;;
    stop)
        if [ -f "$PID_FILE" ]; then
            kill -9 $(cat "$PID_FILE") 2>/dev/null
            rm -f "$PID_FILE"
        fi
        pkill -f "tangprop_guard\|uvicorn.*main:app" 2>/dev/null
        echo "Backend and guard stopped"
        ;;
    status)
        pid=$(cat "$PID_FILE" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "Backend running: PID=$pid"
            if check_health; then
                echo "Health: OK"
                curl -s --noproxy '*' "http://127.0.0.1:$PORT/health" 2>/dev/null
                echo
            else
                echo "Health: FAILED (process alive but not responding)"
            fi
        else
            echo "Backend NOT running"
        fi
        echo "Restart count: $RESTART_COUNT"
        echo "Log: $LOG_FILE"
        ;;
    restart)
        kill_old
        start_backend
        ;;
    *)
        echo "Usage: $0 {start|stop|status|restart}"
        exit 1
        ;;
esac
