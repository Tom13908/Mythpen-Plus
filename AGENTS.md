# Mythpen (0.09-TL) — OpenCode 工作约定

Fork of [niyongsheng/mythpen](https://github.com/niyongsheng/mythpen) v0.0.9。版本 `0.09-TL.N`（N 为版本号，与备份迭代号已解耦）。当前版本 **0.09-TL.18**，最新备份 **v23**。

详细交接文档 `AGENT.md`（~30KB）**按需 grep 后局部读取**，不要每轮全量加载。

## 路径与启动

项目根含空格和撇号，**所有 shell 路径必须双引号**：`"/Users/junwelee/Code Stuff/Tom's mythpen"`。

```bash
./start.sh          # pnpm dev:all → 后端 :3001 + 前端 :5173，就绪后开浏览器
./stop.sh           # 按端口精确停止
./restart.sh        # 改完后端后干净重启（nodemon 偶发不生效时用；不开浏览器）
pnpm typecheck      # tsc --noEmit -p tsconfig.app.json（真实全量检查，必须 0 错误）
pnpm format         # biome format --write src/（改完必跑）
pnpm lint           # 历史遗留，勿为修 lint 大改；新增代码不要制造新问题
curl http://localhost:3001/api/health
```

⚠️ 数据安全（2026-09-24 事故教训，已加固）：数据层是内存库 + 250ms 防抖落盘。
- `_flushDb` 现为**原子写**（临时文件 + rename），杜绝截断文件
- `_loadDb` 对 0 字节/损坏文件**抛错拒开**（sql.js 会把截断文件当空库，开库迁移会反过来覆盖原文件——用户数据曾因此丢失）
- SIGTERM 退出前统一落盘（`flushAllProjectDbs`）；`stop.sh` 优雅等待后才允许强杀
- **`pnpm typecheck` 此前是空壳（根 tsconfig 为 files:[] 的引用壳），已修复为真检查**——写完必须跑且必须绿

日常开发用浏览器，不必编译 Tauri。后端 nodemon 热重载；改 `db.js` 有时需重启。日志看 `dev.log`。

无自动化测试。验证：`typecheck` + `curl` API + 浏览器操作。AI 链路复杂逻辑可写一次性 Node mock 脚本，测完即删。

## 架构（非显而易见处）

```
Tauri v2 壳 → sidecar(bun --compile Express) → sql.js(WASM, base64 内联)
浏览器/WebView ──HTTP/SSE── Express :3001 ── sql.js ── ~/.mythpen/
```

| 层 | 关键文件 |
|---|---|
| 后端入口 / AI 流 / Provider | `server/index.js` |
| REST CRUD | `server/routes/api.js` |
| 数据层 / 迁移 | `server/db.js`（sql.js 伪装成 better-sqlite3 API） |
| 25+ AI 工具 | `server/tools.js` + `toolHint()`（`index.js`） |
| 四协议适配 | `server/ai-adapter.js`（openai / openai-response / claude / gemini） |
| 定稿总结 | `server/summarizer.js` |
| 提示词 | `server/prompts/{writing,collab,context}.js` |
| 前端 API / 竞态 | `src/lib/api.ts` + `src/lib/useProjectData.ts` |
| 采样参数 | `src/lib/sampling.ts` + `clampSampling()` |

- 后端 CommonJS（`server/package.json` `"type": "commonjs"`），前端 ESM。
- 配置库 `~/.mythpen/config.db`；项目库 `~/.mythpen/projects/{名}.mythpen.db`。存储位置可由 `~/.mythpen/.storage-location` 重定向。
- schema：`CONFIG_SCHEMA_VERSION=1`，`PROJECT_SCHEMA_VERSION=4`。加表/列必须递增版本并写迁移。迁移函数缺失时 `runMigrations` 会抛错而不是静默推进版本。
- 主键：创作要素 UUID；卷/章/token_usage 用 INTEGER AUTOINCREMENT。
- `chapters.num` **只在卷内唯一**，定位/删除必须带 `volume_id`。
- 中文项目名 API 路径必须 `encodeURIComponent`。
- 写入 250ms 防抖；`transaction()` 后立即 flush。刚创建的文件可能尚未落盘——判断存在用连接缓存 `openProjectDb`，禁止 `fs.existsSync` 后静默建空库。

## 迭代与版本

```bash
./backup.sh "主题"                     # 打一轮备份
./backup.sh "主题" $'【遇到的问题】...\n【解决方案】...\n【验证方式】...\n【恢复方法】...'
./restore.sh                          # 列出备份；./restore.sh vN 恢复到独立目录
```

- **动手大改前先打基线快照**；一轮功能完成后必须再打。每轮 = `iteration backup/vN/`（`workspace.zip` + `manifest.json` + `notes.md`）；总览见 `iteration backup/INDEX.md`，设计见 `iteration backup/README.md`。
- 迭代号由 `iteration backup/.seq` 游标维护，**与 `package.json` 版本号解耦**（备份记录版本，但编号独立递增）。
- 恢复用 `./restore.sh vN [目标目录]`：先校验 sha256，解压到独立目录，**不覆盖当前项目**。
- 用户说「不需要迭代」时：只改代码/文档，不建快照、不升版本。
- 版本三处：`package.json` = `0.09-TL.N`；`src-tauri/tauri.conf.json` = 严格 semver `0.9.N`（禁止前导零）；`docs/index.html` 的 `APP_VERSION`（当前仍为上游 `0.0.9`，发版时记得改）。
- 小步：2–3 项就 typecheck；全部完成 format + 重启验证 + 备份。
- 提交用 Conventional Commits（`feat:` / `fix:`），中文描述。**未经用户明确要求不要 commit / 不要推送。**
- git 与快照并存：git 记提交历史与 diff，`iteration backup/vN/` 记整棵工作树的里程碑快照（含未提交改动和 gitignore 的本地脚本）。manifest 记录当时的 git sha。本地 `main` 有提交，remote 目前只有 `upstream`（niyongsheng/mythpen），**没有 origin**。不要擅自 `git remote add`。

## 数据安全红线

1. **绝不污染 `config.db` 的 api_key / providers**。测试必须 trap 还原或走 mock。v14 曾因测试写坏 api_key 导致 401。
2. 删除类操作要跑通「创建 → 删除 → 同名重建」。v8：删项目后轮询会静默重建空库，导致同名无法重建。
3. `seed.js` 必须保持「文件已存在就跳过」，否则演示项目用户数据会被抹掉。
4. 存储迁移测试用 `/tmp` + 事后还原引导文件。

## 高频坑（改相关代码前必读）

1. sql.js named param 对象绑定得 NULL → 走 `_normalizeParams`，新增 SQL 优先 `?`。
2. `db.export()` 后旧 statement 全失效 → 禁止缓存 statement。
3. 前端切项目竞态 → 用 `useApiData`（请求序号），不要手写裸 fetch。
4. 消息临时 id 必须在 save 后换成后端 UUID，否则删除/重试 404 静默失败。
5. 上游错误必须透出 status + detail + `mismatchHint`，禁止吞错。
6. 加 AI 工具必须同步 `tools.js` schema、`executeTool` 分支、`toolHint(name, args)` 中文描述。
7. 设置抽屉多行内容不要套 `SettingRow`；删除/操作按钮常显半透明，不要 hover 才显示。
8. `useRef(null)` / `useState(null)` / `useApiData(fetcher)` 必须加泛型，否则 `'xxx' on type 'never'`。
9. sidecar 产物需带平台后缀：`mythpen-server-aarch64-apple-darwin`。`bun --compile --assets` 在 bun 1.3.14 会静默崩溃，WASM 用 base64 内联（`scripts/embed-wasm.mjs`）。
10. DMG：非 GUI 会话用 `--sandbox-safe`；必须用暂存目录打包，直接拿 `.app` 当源会拍平 bundle。

## 协作偏好

- 中文交流、中文交付说明。
- 重视可回滚、可验证；调查类任务克制，用户说「不用分析」就停。
- 供应商 403/上游故障不要反复花 token 分析。

## 当前状态（2026-09-10）

已完成：四层采样参数（v20）、进度展示细化 + 首次 DMG（v22）、fork 身份（`package.json` author/license/repository 已改）。

未完成：

- [ ] 添加 origin 并推送（GitHub: Tom13908/mythpen）。直接改 `git config` remote 曾被拦截，用 `git remote add origin <url>` 或直接 URL 推送。
- [ ] 若自建分发包：改 `src-tauri/tauri.conf.json` 的 `identifier`（现 `com.mythpen.desktop`，与上游冲突）。
- [ ] 采样探针尚未对真实供应商实测（设置里点「测试连接」即触发）。

## 按任务查 AGENT.md / docs

| 任务 | 先读 |
|---|---|
| 架构 / sidecar / WASM | `docs/architecture-decision.md`；`AGENT.md` §1 |
| 模块职责 / 表结构 | `AGENT.md` §2–§3 |
| 某次迭代改了什么 | `iteration backup/INDEX.md` → `iteration backup/vN/notes.md` |
| 设计模式 / TS 坑 | `AGENT.md` §5 |
| 加 API / 表 / 工具 / 文案 | `AGENT.md` §7 |
| 数据模型全貌 | `docs/SPEC_1.0.md` |
