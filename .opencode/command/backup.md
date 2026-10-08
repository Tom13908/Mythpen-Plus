---
description: 打一轮迭代备份（vN 快照 + 四段式说明）
agent: build
---

为当前工作打 Mythpen 迭代备份。

用户补充说明（若有）：$ARGUMENTS

按 `.opencode/skills/mythpen-backup/SKILL.md` 执行：

1. 确认是否需要备份（用户说「不需要迭代」则停止）。
2. 功能完成后先 `pnpm typecheck` + `pnpm format`。
3. 用主题 + 四段式说明调用 `./backup.sh "主题" $'...'`（编号自动递增）。
4. 同步 `AGENT.md` §4 与 `AGENTS.md` 当前状态。
5. 不要 commit / push，除非用户明确要求。
