---
name: mythpen-release
description: 执行 Mythpen 发布新版本流程（更新版本号、提交、打 tag、推送）。Use ONLY when the user asks to release, 发版, bump version, or 打 tag.
---

# 发布新版本 — Mythpen

当前 remote 只有 `upstream`，**没有 origin**。推送前先确认 origin 已添加（`git remote -v`），没有则询问用户，用 `git remote add origin https://github.com/Tom13908/mythpen.git`，不要改 `git config` remote（曾被拦截）。

## 步骤

1. **更新版本号（三处保持一致）**
   - `package.json` → `"version": "0.09-TL.N"`
   - `src-tauri/tauri.conf.json` → `"version": "0.9.N"`（严格 semver，禁止前导零）
   - `docs/index.html` → `const APP_VERSION = '0.09-TL.N'`（现仍为上游 `0.0.9`，发版时改）

2. **提交并打 tag**（仅在用户明确要求时执行）

```bash
git add .
git commit -m "chore: bump version to 0.09-TL.N"
git push origin main
git tag v0.9.N
git push origin v0.9.N   # 触发 CI 自动构建 + Release
```

Tag 用严格 semver（`v0.9.N`），不要用 `v0.09-TL.N`。

## 注意事项

- Tag 必须 `v*` 格式。推送后不要删除重推，会残留空 Release。
- 产物：macOS → `.dmg` / Windows → `.msi` + `.exe`
- sidecar 二进制必须带平台后缀（如 `mythpen-server-aarch64-apple-darwin`）
- 若自建分发包，先改 `src-tauri/tauri.conf.json` 的 `identifier`（现 `com.mythpen.desktop`，与上游冲突）
- 本地打 DMG：非 GUI 会话用 `--sandbox-safe`；必须用暂存目录打包，直接拿 `.app` 当源会拍平 bundle
