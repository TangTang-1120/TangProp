#!/bin/bash
# TangProp 后端管理脚本（LaunchAgent 方式）
# 用法: ./tangprop_backend_ctl.sh {start|stop|status|reload|log}
PLIST="/Users/tangtang/Library/LaunchAgents/com.tangprop.backend.plist"

case "$1" in
    start)
        launchctl load "$PLIST" 2>/dev/null
        echo "Backend started (system-managed, auto-restart enabled)"
        ;;
    stop)
        launchctl unload "$PLIST" 2>/dev/null
        echo "Backend stopped"
        ;;
    status)
        launchctl list 2>/dev/null | grep tangprop && echo "Status: Running" || echo "Status: Stopped"
        curl -s --noproxy '*' http://127.0.0.1:8080/health 2>/dev/null || echo "Health: not responding"
        echo
        ;;
    reload)
        launchctl unload "$PLIST" 2>/dev/null
        sleep 2
        launchctl load "$PLIST" 2>/dev/null
        echo "Backend reloaded"
        ;;
    log)
        tail -20 /tmp/tangprop_backend.log 2>/dev/null
        ;;
    *)
        echo "Usage: $0 {start|stop|status|reload|log}"
        echo "  start  - 启动后端（系统级守护，自动重启）"
        echo "  stop   - 停止后端"
        echo "  status - 查看状态"
        echo "  reload - 重启后端"
        echo "  log    - 查看最近日志"
        ;;
esac
