#!/bin/bash
# MythPen 迭代备份脚本：打包 iteration backup/vN.zip，并生成 vN.txt 迭代说明
# 用法: ./backup.sh "本次迭代的说明文字"
# 说明文字可省略；无论是否传入，都会自动附上自上次备份以来的 git 提交清单
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
BACKUP_DIR="iteration backup"
MARKER=".backup-last-sha"

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
zip -rq "$TARGET" . -x "$BACKUP_DIR/*" -x "node_modules/*" -x "*.DS_Store" -x "$MARKER"

SIZE=$(du -h "$TARGET" | cut -f1)
FILES=$(unzip -l "$TARGET" | tail -1 | awk '{print $2}')
echo "✅ 备份完成: v${NEXT}，${FILES} 个文件, ${SIZE}"

# ─── 生成迭代说明 vN.txt ───
DESC="${1:-（未提供说明）}"
NOW=$(date '+%Y-%m-%d %H:%M:%S')
LAST_SHA=""
[ -f "$MARKER" ] && LAST_SHA=$(cat "$MARKER")

{
  echo "迭代说明 v${NEXT}"
  echo "备份时间: ${NOW}"
  echo "说明: ${DESC}"
  echo
  echo "── 本迭代包含的 git 提交 ──"
  if git rev-parse --git-dir > /dev/null 2>&1; then
    if [ -n "$LAST_SHA" ] && git cat-file -e "${LAST_SHA}^{commit}" 2>/dev/null; then
      if git log --oneline --no-decorate "${LAST_SHA}..HEAD" 2>/dev/null | grep -q .; then
        git log --oneline --no-decorate "${LAST_SHA}..HEAD"
      else
        echo "（自上次备份以来无新提交——改动未提交或与上次备份内容相同）"
      fi
    else
      echo "（无有效的历史备份标记，显示最近 10 条提交）"
      git log --oneline --no-decorate -10
    fi
  else
    echo "（当前目录不是 git 仓库）"
  fi
  echo
  echo "恢复方法: 解压到项目目录后运行 pnpm install"
} > "$BACKUP_DIR/v${NEXT}.txt"

echo "📝 已生成迭代说明: $BACKUP_DIR/v${NEXT}.txt"

# 记录本次备份对应的 git 状态，供下次生成提交范围
git rev-parse HEAD > "$MARKER" 2>/dev/null || true
