<p align="center">
  <img src="./logo.svg" alt="Mythpen" width="120" />
</p>

<h1 align="center">Mythpen Plus</h1>

<p align="center">
  <em>AI-assisted novel writing desktop app — characters, world-building, chapters, foreshadowing, timelines, with integrated AI writing assistant.</em>
</p>

<p align="center">
  Based on <a href="https://github.com/niyongsheng/mythpen">niyongsheng/mythpen</a> (GPL-3.0) — see <a href="#相对上游的新特性">相对上游的新特性</a> below.
</p>

<p align="center">
  <a href="https://github.com/Tom13908/Mythpen-Plus/releases"><img src="https://img.shields.io/github/v/release/Tom13908/Mythpen-Plus?style=flat-square&label=Release" alt="Release"></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React"></a>
  <a href="https://tailwindcss.com"><img src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white" alt="Tailwind CSS"></a>
  <a href="https://expressjs.com"><img src="https://img.shields.io/badge/Express-5-000000?style=flat-square&logo=express&logoColor=white" alt="Express"></a>
  <a href="https://tauri.app"><img src="https://img.shields.io/badge/Tauri-v2-FFC131?style=flat-square&logo=tauri&logoColor=white" alt="Tauri"></a>
</p>

<p align="center">
  <img alt="demo" src="https://github.com/user-attachments/assets/87ba980c-492b-4bd2-af75-e14faa3cec68" width="80%" style="border-radius: 8px;" />
</p>

# 相对上游的新特性

基于 [niyongsheng/mythpen](https://github.com/niyongsheng/mythpen)（GPL-3.0）分叉，已融合上游 0.0.16 的部分改动，版本线为 `0.09-TL.N`（`N` 为迭代号）。主要新增：

- **多协议 AI 接入**：OpenAI Chat Completions / OpenAI Responses / Anthropic Messages / Google Gemini 四种协议；多套配置档案一键切换，切换时密钥、地址、模型一并镜像到旧字段，老路由不用改
- **采样参数可控**：温度、Top P 按协议自动收敛（OpenAI 2.0，其余 1.0）；`top_p` 是否被支持先探测再决定发不发，探针判定不支持后旧档案里残留的值也不再发送
- **中转站友好**：地址缺 `/v1` 自动补全；模型列表直接向中转站拉取，不必手打模型名；模型与协议类型不匹配时给出明确提示（例如 DeepSeek 模型配 Anthropic 类型）
- **上下文预算裁剪**：预算 = 上下文窗口 − 最大输出 − 4000（下限 2000），超预算按优先级丢弃低价值段落，而不是让请求直接 400
- **写作语言自动判定**：不用选。按「最近几条对话里用户说的话 → 最近更新过的章节正文 → 界面语言」三级判定，结果注入提示词一行；换语言不必重建项目
- **导入旧稿**：TXT / EPUB 一键导入，按卷名章名自动切分，找不到标题时按长度兜底；TXT 自动识别 UTF-8 / GBK / Big5，EPUB 读 OPF spine 逐章转换并剥掉重复章名；上限 600 万字 / 5000 章 / 30 MB
- **项目名任意字符**：显示名与库文件名解耦，库文件为 `<UUID>.mythpen.db`，名称与真实路径存进注册表，`/ : ? *` 都能用；旧布局的 `<名称>.mythpen.db` 仍能自动识别打开
- **章节定稿自动总结**：定稿后异步生成章节摘要、抽取叙事记忆、记录人物关系变化、推进伏笔状态；内存去重队列 + 启动时补跑，没有 API key 时保持待处理而不是失败
- **里程碑快照**：整库快照、还原、还原前自动备份；快照目录按项目名派生并做安全转义
- **存储位置迁移**：书库可换目录，带迁移确认、进度显示、失败回滚与重启提示
- **工具循环健壮性**：输出被 `max_tokens` 截断时自动续写（上限 3 次）；缺必需参数的调用不执行并把原因写回对话；整轮被思考吃光时换催促语；长章节支持 `replace` / `append` 分段写
- **多卷编号**：章节编号可选「每卷从 1 开始」或「全书连续」，按 `(volume_id, num)` 定位，两卷同号时报错而不是误改
- **消息级操作**：单条消息可编辑、删除、重试（编辑只落库，重试才重跑），会话可改名
- **八种界面语言**：简体中文 / 繁體中文 / English / 日本語 / 한국어 / Français / Español / Русский，提示词模板随界面语言切换
- **编辑器增强**：撤销 / 重做；自动保存间隔可调（15 / 30 / 60 / 120 秒或关闭，语义是停手 N 秒后才存）
- **进度可视化**：每个工具调用带参数级中文提示（如「写入第 3 章正文」），并显示轮次、剩余章节、最近工具列表与耗时
- **稳定性**：项目切换用请求序列号守卫竞态；错误提示带上游状态码、原始返回与中文建议，不再静默失败

逐项差异（含上游有而本版没有的部分）见 [WhatsNew.txt](./WhatsNew.txt)。

# Feature

- **AI Writing** — Two modes: *Writing* (guided 6-step workflow) and *Collab* (AI co-writer). Supports OpenAI, OpenAI Responses, Anthropic, and Gemini.
- **Novel Management** — Characters, world-building, chapters, foreshadowing, timeline, and relations — all in one place.
- **Local-First** — Data stored in SQLite under `~/.mythpen/`. No cloud required, full privacy.
- **Rich Editor** — Bold, italic, underline via keyboard shortcuts, plus undo/redo. Chapters auto-save after you stop typing.
- **Cross-Platform** — Tauri v2 for native desktop experience, also runs in browser for development.

## Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9

## Quick Start

```bash
pnpm install        # Install dependencies
pnpm dev:all        # Start in browser (frontend + backend + seed data)
pnpm tauri dev      # Desktop development mode
pnpm tauri build    # Build desktop installer (.dmg/.msi/.AppImage)
```

macOS Apple Silicon installer: see [Releases](https://github.com/Tom13908/Mythpen-Plus/releases). The `.dmg` is unsigned — right-click → Open the first time to bypass Gatekeeper.

## Tech Stack

**Frontend**: React 19 + TypeScript + Zustand  
**Backend**: Express 5 + sql.js (WASM SQLite)  
**Desktop**: Tauri v2  
**AI**: OpenAI-compatible + Anthropic Messages + Gemini

## License

[GPLv3](./LICENSE) — same as upstream. This is a modified version of [niyongsheng/mythpen](https://github.com/niyongsheng/mythpen).
