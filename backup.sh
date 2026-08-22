#!/bin/bash
# MythPen 迭代备份脚本：把当前源码打包为 iteration backup/vN.zip（N 自动递增）
# 排除 node_modules（可用 pnpm install 重建）和 iteration backup 自身
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
BACKUP_DIR="iteration backup"

if [ ! -d "$BACKUP_DIR" ]; then
  echo "❌ 未找到 $BACKUP_DIR 目录"
  exit 1
fi

# 找出当前最大版本号，+1 作为新版本
MAX=0
for f in "$BACKUP_DIR"/v*.zip; do
  [ -e "$f" ] || continue
  N=$(basename "$f" .zip | sed 's/^v//')
  case "$N" in
    ''|*[!0-9]*) ;;        # 跳过非 v数字 命名
    *) [ "$N" -gt "$MAX" ] && MAX=$N ;;
  esac
done
NEXT=$((MAX + 1))
TARGET="$BACKUP_DIR/v$NEXT.zip"

echo "📦 创建迭代备份: $TARGET"
zip -rq "$TARGET" . -x "$BACKUP_DIR/*" -x "node_modules/*" -x "*.DS_Store"

SIZE=$(du -h "$TARGET" | cut -f1)
FILES=$(unzip -l "$TARGET" | tail -1 | awk '{print $2}')
echo "✅ 备份完成: v$NEXT（$FILES 个文件, $SIZE）"
echo "   恢复方法: 解压到项目目录后运行 pnpm install"
