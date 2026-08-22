#!/bin/bash
# MythPen 开发服务启动脚本：拉起前后端服务，就绪后用默认浏览器打开
set -u

# 定位脚本所在目录（兼容带空格/撇号的路径）
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

URL="http://localhost:5173"
LOG="$DIR/dev.log"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "❌ 未找到 pnpm，请先安装：npm install -g pnpm"
  exit 1
fi

# 首次使用需要安装依赖
if [ ! -d node_modules ]; then
  echo "📦 首次运行，安装依赖中..."
  pnpm install || exit 1
fi

# 已在运行则直接打开浏览器
if curl -s -o /dev/null --max-time 2 "$URL"; then
  echo "✅ 服务已在运行，直接打开浏览器"
  open "$URL"
  exit 0
fi

echo "🚀 启动 MythPen 开发服务（日志: dev.log）..."
nohup pnpm dev:all > "$LOG" 2>&1 &
echo $! > "$DIR/.dev.pid"

# 轮询等待前后端就绪，最长 60 秒
echo -n "⏳ 等待服务就绪"
ok_back=0
ok_front=0
for i in $(seq 1 60); do
  sleep 1
  if [ "$ok_back" -eq 0 ]; then
    curl -s -o /dev/null --max-time 1 http://localhost:3001/api/health && ok_back=1
  fi
  if [ "$ok_front" -eq 0 ]; then
    curl -s -o /dev/null --max-time 1 "$URL" && ok_front=1
  fi
  echo -n "."
  if [ "$ok_back" -eq 1 ] && [ "$ok_front" -eq 1 ]; then
    echo ""
    echo "✅ 后端 :3001 与前端 :5173 均已就绪"
    open "$URL"
    echo "🌐 已用默认浏览器打开 $URL"
    echo "🛑 停止服务请运行：./stop.sh"
    exit 0
  fi
done

echo ""
echo "❌ 60 秒内服务未就绪，最近日志如下："
tail -20 "$LOG"
exit 1
