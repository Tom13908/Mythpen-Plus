<p align="center">
  <img src="./logo.svg" alt="Mythpen" width="120" />
</p>

<h1 align="center">Mythpen</h1>

<p align="center">
  <em>AI-assisted novel writing desktop app — characters, world-building, chapters, foreshadowing, timelines, with integrated AI writing assistant.</em>
</p>

<p align="center">
  Based on <a href="https://github.com/niyongsheng/mythpen">niyongsheng/mythpen</a> — see <a href="#whats-different-from-upstream">What's different</a> below.
</p>

<p align="center">
  <a href="https://github.com/Tom13908/mythpen/releases"><img src="https://img.shields.io/github/v/release/Tom13908/mythpen?style=flat-square&label=Release" alt="Release"></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React"></a>
  <a href="https://tailwindcss.com"><img src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white" alt="Tailwind CSS"></a>
  <a href="https://expressjs.com"><img src="https://img.shields.io/badge/Express-5-000000?style=flat-square&logo=express&logoColor=white" alt="Express"></a>
  <a href="https://tauri.app"><img src="https://img.shields.io/badge/Tauri-v2-FFC131?style=flat-square&logo=tauri&logoColor=white" alt="Tauri"></a>
</p>

<p align="center">
  <img alt="demo" src="https://github.com/user-attachments/assets/87ba980c-492b-4bd2-af75-e14faa3cec68" width="80%" style="border-radius: 8px;" />
</p>

# Feature

- **AI Writing** — Two modes: *Writing* (guided 6-step workflow) and *Collab* (AI co-writer). Supports OpenAI, OpenAI Responses, and Claude.
- **Novel Management** — Characters, world-building, chapters, foreshadowing, timeline, and relations — all in one place.
- **Local-First** — Data stored in SQLite under `~/.mythpen/`. No cloud required, full privacy.
- **Rich Editor** — Bold, italic, underline via keyboard shortcuts. Chapters auto-save locally.
- **Cross-Platform** — Tauri v2 for native desktop experience, also runs in browser for development.

# What's different from upstream

Based on [niyongsheng/mythpen](https://github.com/niyongsheng/mythpen) v0.0.9. This fork's version is `0.09-TL.N` (`N` is the iteration number).

## AI provider system

- Multiple provider profiles with one-click switching
- Four protocols: OpenAI chat/completions, OpenAI Responses, Anthropic Claude Messages, Google Gemini (generateContent)
- Relay-friendly: auto-append `/v1`, proxied model list, mismatch hints (e.g. DeepSeek model + Anthropic type)
- Sampling controls: `temperature` / `top_p` with a four-layer compatibility strategy (omit unset params → protocol clamp → model-family hints → upstream 400 feedback)
- Token usage recorded per call

## Context and memory

- Auto-summarize on chapter accept: summary, narrative memories, relation snapshots, foreshadow progress
- Context budget trimming based on the model's context window
- Five narrative dimension fields per chapter (cognitive frame / emotional anchor / world texture / mystery / interpersonal tension)

## Stability

- Project-switch race fix (request sequence guards)
- Tool-loop empty-response tolerance with explicit abort, 120-round cap, per-tool Chinese progress hints
- Errors surface upstream status + detail + Chinese suggestions instead of failing silently

## Editing

- Full edit/delete on Characters, World, Foreshadows, and Relations pages
- Chat message edit / delete / retry (cascading cleanup), session rename
- Database storage-location migration

## Progress UI

- Per-tool progress with argument-level Chinese hints (e.g. "写入第3章正文")
- Round hints that report remaining chapters (Writing) or current phase (Collab)
- Recent-tool list, shimmer progress bar, elapsed-time timer

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

macOS Apple Silicon installer: see [Releases](https://github.com/Tom13908/mythpen/releases). The `.dmg` is unsigned — right-click → Open the first time to bypass Gatekeeper.

## Tech Stack

**Frontend**: React 19 + TypeScript + Zustand  
**Backend**: Express 5 + sql.js (WASM SQLite)  
**Desktop**: Tauri v2  
**AI**: OpenAI-compatible + Anthropic Messages

## License

[GPLv3](./LICENSE) — same as upstream. This is a modified version of [niyongsheng/mythpen](https://github.com/niyongsheng/mythpen).
