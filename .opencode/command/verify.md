---
description: 跑 typecheck + format，并检查后端健康
agent: build
---

验证当前改动，不要扩大范围。

1. `pnpm typecheck`（全量用 `pnpm exec tsc --noEmit --project tsconfig.app.json`）
2. `pnpm format`
3. 若后端应在跑：`curl -s http://localhost:3001/api/health`
4. 不要为了修历史 lint（~219 error）大改代码。
5. 把结果用中文简报给用户。
