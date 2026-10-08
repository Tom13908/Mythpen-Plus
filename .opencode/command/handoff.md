---
description: 按任务加载 AGENT.md 对应章节，不要全量读
agent: plan
---

用户任务：$ARGUMENTS

不要整份读取 `AGENT.md`。先 grep 定位，再局部读取相关章节：

| 任务类型 | 先读 |
|---|---|
| 架构 / sidecar / WASM | `docs/architecture-decision.md`；`AGENT.md` §1 |
| 模块职责 / 表结构 | `AGENT.md` §2–§3 |
| 某次迭代改了什么 | `iteration backup/INDEX.md` → `iteration backup/vN/notes.md` |
| 设计模式 / TS 坑 | `AGENT.md` §5 |
| 交接红线 / 协作偏好 | `AGENT.md` §6 |
| 加 API / 表 / 工具 / 文案 | `AGENT.md` §7 |
| 数据模型全貌 | `docs/SPEC_1.0.md` |

读完后用中文给出：相关模块、必守红线、建议改动切入点。不要动手改代码，除非用户要求。
