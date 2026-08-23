#!/bin/bash
# MythPen 迭代备份脚本：打包 iteration backup/vN.zip，并生成 vN.txt 迭代说明
# 用法: ./backup.sh "本次迭代的说明（建议写：遇到什么问题、做了什么改动）"
# 说明文字支持多行：用 $'...\n...' 形式传入
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
TARGET="$BACKUP_DIR/v${NEXT}.zip"

echo "📦 创建迭代备份: ${TARGET}"
zip -rq "$TARGET" . -x "$BACKUP_DIR/*" -x "node_modules/*" -x "*.DS_Store"

SIZE=$(du -h "$TARGET" | cut -f1)
FILES=$(unzip -l "$TARGET" | tail -1 | awk '{print $2}')
echo "✅ 备份完成: v${NEXT}，${FILES} 个文件, ${SIZE}"

# ─── 生成迭代说明 vN.txt ───
DESC="${1:-（未提供说明）}"
NOW=$(date '+%Y-%m-%d %H:%M:%S')

{
  echo "迭代说明 v${NEXT}"
  echo "备份时间: ${NOW}"
  echo
  echo "${DESC}"
  echo
  echo "恢复方法: 解压到项目目录后运行 pnpm install"
} > "$BACKUP_DIR/v${NEXT}.txt"

echo "📝 已生成迭代说明: $BACKUP_DIR/v${NEXT}.txt"
