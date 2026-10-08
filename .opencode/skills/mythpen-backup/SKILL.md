---
name: mythpen-backup
description: 打 Mythpen 迭代备份（vN 快照目录 + 元数据 + 四段式说明）。Use ONLY when the user asks to backup, 打备份, 打迭代, 开新迭代, or run backup.sh.
---

# 迭代备份 — Mythpen

完成一轮功能、或动手大改前打基线时使用。用户说「不需要迭代」则**不要**执行本 skill。

## 步骤

1. 跑 `pnpm typecheck` + `pnpm format`（功能完成后必须；纯基线快照可跳过）。
2. 执行备份（路径含空格和撇号，必须双引号）：

```bash
cd "/Users/junwelee/Code Stuff/Tom's mythpen"
./backup.sh "主题" $'【遇到的问题】...\n【解决方案】...\n【验证方式】...\n【恢复方法】...'
```

编号由 `iteration backup/.seq` 自动递增，**不要手写编号**。产物：
`iteration backup/vN/{workspace.zip, manifest.json, notes.md}`，并自动追加 `INDEX.md`。

3. 同步更新：
   - `AGENT.md` §4 迭代表 + 演进主线
   - `AGENTS.md` 顶部「最新备份」与「当前状态」
   - 若本轮升了版本：`package.json` 的 `0.09-TL.N` 与 `src-tauri/tauri.conf.json` 的 `0.9.N`（禁止前导零）

4. **不要**顺手 `git commit` / `git push`，除非用户明确要求。

## 说明格式

四段建议齐全：

```
【遇到的问题】...
【解决方案】...
【验证方式】...
【恢复方法】./restore.sh vN 解压到独立目录，pnpm install 后重启。
```

小修补可追加到当前 `iteration backup/vN/notes.md`（不新建快照）；若改动较大，另打一轮。

## 恢复

`./restore.sh` 列出所有备份；`./restore.sh vN [目标目录]` 先校验 sha256，再解压到独立目录，
**绝不覆盖当前项目**。创作数据在 `~/.mythpen/`，不随代码快照回滚。
