# Windows setup

Written for Windows 10/11. **Not yet executed on Windows**: the code was built and tested on Linux, so first-run issues on your PC are possible; see Troubleshooting.

## 1. Prerequisites

- **Node.js 22.13 or newer** (LTS 22/24). Check: `node -v`. Download from nodejs.org.
- **pnpm 10**: `corepack enable` then `corepack prepare pnpm@10.28.0 --activate` (or `npm i -g pnpm`).
- Optional: Google Chrome (only for `pnpm test:e2e`), FFmpeg on PATH (only your own workflows; not used by AI Office yet).

## 2. Install and run

```powershell
cd C:\NEWRON_Agent_Office
pnpm install
pnpm start
```

Open <http://127.0.0.1:4317>. Data (SQLite DB, backups, spool, tokens) lives in `C:\NEWRON_Agent_Office\data` unless `AI_OFFICE_DATA_DIR` is set. Copy `.env.example` to `.env` to change settings (set variables in your shell, or use a launcher; the server reads process environment).

## 3. Tests

```powershell
pnpm test
$env:PLAYWRIGHT_CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
pnpm test:e2e
```

## 4. Hooks

See [CLAUDE_INTEGRATION.md](CLAUDE_INTEGRATION.md). Paths with spaces are quoted by the installer.

## 5. Packaging (Tauri) – not implemented

`pnpm package` is a placeholder. A Tauri shell would need the Rust toolchain and Microsoft C++ Build Tools, and would wrap this local server (Node sidecar) and web UI. Until then, run it with `pnpm start` and use a browser (an "app window" shortcut via Edge/Chrome `--app=http://127.0.0.1:4317` works well).

## Troubleshooting

- `ExperimentalWarning: SQLite` is expected.
- `Cannot find module 'node:sqlite'` → Node is older than 22.13.
- Port busy → set `AI_OFFICE_PORT`.
- No avatars after installing hooks → start a **new** Claude session in that project; run `pnpm hooks:status`.
- PowerShell blocks scripts → run commands from `cmd` or use `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
