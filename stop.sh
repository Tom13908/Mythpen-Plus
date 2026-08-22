#!/bin/bash
# MythPen 开发服务停止脚本：关闭本项目的前后端全部进程
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
PORTS="3001 5173"
found=0

# 1) 若记录了启动父进程（pnpm/concurrently），先结束它
if [ -f "$DIR/.dev.pid" ]; then
  PID=$(cat "$DIR/.dev.pid" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "🔁 结束启动进程 (PID $PID)"
    kill "$PID" 2>/dev/null
    found=1
  fi
  rm -f "$DIR/.dev.pid"
fi

# 2) 结束占用端口的进程（前端 vite :5173 / 后端 node :3001）
for PORT in $PORTS; do
  PIDS=$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null)
  if [ -n "$PIDS" ]; then
    echo "🔇 停止端口 :$PORT 的进程 (PID: $(echo $PIDS | tr '\n' ' '))"
    kill $PIDS 2>/dev/null
    found=1
  fi
done

if [ "$found" -eq 0 ]; then
  echo "ℹ️ 服务未在运行"
  exit 0
fi

# 3) 等待退出，对顽固进程强制结束
sleep 2
for PORT in $PORTS; do
  PIDS=$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null)
  if [ -n "$PIDS" ]; then
    echo "⚡ 强制结束端口 :$PORT 残留进程"
    kill -9 $PIDS 2>/dev/null
  fi
done

# 4) 最终确认端口已释放
sleep 1
left=0
for PORT in $PORTS; do
  lsof -ti tcp:$PORT -sTCP:LISTEN >/dev/null 2>&1 && left=1
done
if [ "$left" -eq 0 ]; then
  echo "✅ 所有服务已停止"
else
  echo "⚠️ 仍有端口被占用，请手动检查：lsof -i :3001 -i :5173"
  exit 1
fi
