#!/bin/bash
cd "$(dirname "$0")"

echo "========================================"
echo "  即梦批量视频生成工具"
echo "========================================"
echo ""
echo "启动服务器: http://localhost:8765"
echo "浏览器即将自动打开..."
echo ""
echo "按 Ctrl+C 可停止服务器"
echo "========================================"
echo ""

node dreamina-server.js &
sleep 2
open "http://localhost:8765"
wait
