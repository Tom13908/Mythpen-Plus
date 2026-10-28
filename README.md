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

本项目是 [niyongsheng/mythpen](https://github.com/niyongsheng/mythpen)（GPL-3.0）的分叉版本。版本号格式为 `0.09-TL.N`。`N` 是迭代号。本项目已合并上游 0.0.16 的部分改动。

## AI 连接

- 应用支持 4 种协议：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Google Gemini。
- 应用可保存多套配置档案。你点一次即可切换。
- 切换档案时，应用把密钥、地址、模型写入旧字段。旧接口继续可用。

## 采样参数

- 应用按协议限制温度。OpenAI 的上限是 2.0。其余协议的上限是 1.0。
- 应用按同一上限限制 Top P。
- 应用先测试供应商是否接受 Top P。测试通过才发送。
- 测试不通过后，应用不发旧档案里的 Top P。旧值会触发 400 错误。

## 中转站

- 地址缺少 `/v1` 时，应用补全。
- 应用从中转站读取模型列表。你不必手写模型名。
- 模型与协议不匹配时，应用给出提示。例：DeepSeek 模型配 Anthropic 协议。

## 上下文预算

- 应用先算预算。算法：上下文窗口 − 最大输出 − 4000。下限是 2000。
- 请求超出预算时，应用丢弃低优先级段落。
- 应用不发会被供应商拒绝的请求。

## 写作语言

- 你不设置写作语言。应用自动判定。
- 应用取 3 个来源，按优先级排列：
  1. 你最近在对话里写的文字。
  2. 你最后修改的章节正文。
  3. 界面语言。
- 应用向提示词加入 1 行：`写作语言: <语言名>`。
- 换语言时，你不必新建项目。

## 导入旧稿

- 应用可导入 TXT 与 EPUB。
- 应用按卷名、章名切分正文。正文没有标题时，应用按长度切分。
- 对于 TXT，应用识别 UTF-8、GBK、Big5。
- 对于 EPUB，应用读取 OPF 的 spine（阅读顺序）。应用逐章转换。应用去掉正文里重复的章名。
- 上限：600 万字、5000 章、单文件 30 MB。

## 项目名

- 项目名与数据库文件名相互独立。
- 文件名为 `<UUID>.mythpen.db`。
- 应用把项目名与文件路径存入注册表（`recent_projects` 表）。
- 项目名可含 `/`、`:`、`?`、`*`。
- 旧文件 `<名称>.mythpen.db` 也能打开。

## 定稿总结

- 你接受一章后，应用在后台执行 4 项任务：
  1. 写章节摘要。
  2. 抽取叙事记忆。
  3. 记录人物关系变化。
  4. 推进伏笔状态。
- 队列去掉重复任务。应用在下次启动时补跑未完成的任务。
- 没有可用密钥时，任务保持待处理。任务不记为失败。

## 快照

- 应用可对整个数据库创建快照。你可还原快照。
- 还原前，应用先做备份。
- 应用从项目名生成快照目录名。应用替换不安全字符。

## 存储位置

- 你可把书库移到其他目录。
- 应用要求确认。应用显示进度。失败时应用回滚。应用提示重启。

## 工具调用

- 输出在 `max_tokens` 处停止时，应用继续请求后续内容。上限是 3 次。
- 调用缺少必需参数时，应用不执行。应用把原因写回对话。
- 模型把整轮用于思考时，应用改发催促语。
- 长章节用 `content_mode=replace` 或 `content_mode=append`。

## 章节编号

- 你可让每卷从 1 编号。也可让全书连续编号。
- 应用按「卷 ID + 章号」定位章节。
- 两卷章号相同时，应用报错。应用不改错章节。

## 消息

- 你可编辑、删除或重试单条消息。
- 编辑只写数据库。你重试后，应用才重新发送。
- 你可改会话名称。

## 语言

- 界面支持 8 种语言：简体中文、繁體中文、English、日本語、한국어、Français、Español、Русский。
- 提示词模板跟随界面语言。

## 编辑器

- 你可撤销、重做。
- 自动保存间隔可选 15、30、60、120 秒。也可关闭。
- 你停止输入达到设定秒数后，应用保存本章。

## 进度

- 应用为每次工具调用显示 1 条中文提示。提示含参数。例：「写入第 3 章正文」。
- 应用显示轮次、剩余章节数、最近工具、已用时间。

## 稳定性

- 切换项目时，两个请求可能互相覆盖。应用用请求序号阻止。
- 错误提示含上游状态码、返回内容、中文建议。应用不静默失败。

完整差异（含上游有而本版没有的部分）见 [WhatsNew.txt](./WhatsNew.txt)。

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
