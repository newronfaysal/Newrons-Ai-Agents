# AI OFFICE

A local-first Windows app that shows your real Claude Code activity as a 2D pixel-art virtual office, with a project/task command center on top.

- **Virtual Office** – four departments (Planning, Video Editor, App Development, QA) and 14 configurable roles. Avatars move and animate from real Claude Code hook events.
- **Project Command Center** – projects, a 7-column kanban, task workflow rules, dependencies, approvals, evidence for QA, revision loops.
- **Agent Inspector** – click an avatar to see what is known, how fresh it is, and what AI Office _cannot_ know.
- **Integration** page – previews and installs project-local Claude Code hooks, with backup and rollback.

> Status: **observability is implemented and tested; managed execution (Agent SDK) and Tauri packaging are NOT implemented.** See [TEST_REPORT.md](TEST_REPORT.md) for exactly what was verified.

## Quick start (Windows)

Requirements: Node.js **>= 22.13** (uses built-in `node:sqlite`, no native build), pnpm 10. Details in [WINDOWS_SETUP.md](WINDOWS_SETUP.md).

```powershell
cd C:\NEWRON_Agent_Office
pnpm install
pnpm start          # builds the web app, serves everything on http://127.0.0.1:4317
```

Open <http://127.0.0.1:4317>. Click **Start demo** to see the office animate. Demo agents are labelled **SIMULATED**, are never stored, and cannot be confused with real sessions.

For development with hot reload: `pnpm dev` (server on 4317, web on 5173).

## Connect real Claude Code activity (optional, explicit consent)

```powershell
# 1. Preview exactly what would change (writes nothing)
pnpm hooks:install --project C:\path\to\your\project --dry-run
# 2. Apply (backs up the file first)
pnpm hooks:install --project C:\path\to\your\project --yes
# Check / roll back
pnpm hooks:status    --project C:\path\to\your\project
pnpm hooks:uninstall --project C:\path\to\your\project --yes
```

Only the project-local `.claude/settings.local.json` is touched. Your global Claude settings are never modified. See [CLAUDE_INTEGRATION.md](CLAUDE_INTEGRATION.md).

## Scripts

| Script                                       | What it does                                               |
| -------------------------------------------- | ---------------------------------------------------------- |
| `pnpm install`                               | install dependencies                                       |
| `pnpm dev`                                   | server + Vite dev server                                   |
| `pnpm start`                                 | build web, run server (serves UI)                          |
| `pnpm build`                                 | build all packages                                         |
| `pnpm test`                                  | unit + integration tests (shared, server, hooks, web)      |
| `pnpm test:e2e`                              | Playwright browser tests (needs Chrome, see WINDOWS_SETUP) |
| `pnpm typecheck`, `pnpm lint`, `pnpm format` | static checks                                              |
| `pnpm hooks:install / uninstall / status`    | manage project-local hooks                                 |
| `pnpm db:backup`                             | write a rotated SQLite backup                              |
| `pnpm package`                               | placeholder: Tauri packaging is not built yet              |

## Honest status

| Area                                             | State                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Foundation: DB, migrations, security, API        | Complete, tested                                                                                   |
| Virtual Office (Pixi), demo, inspector           | Complete, tested in headless Chrome                                                                |
| Live observability via hooks                     | Implemented against documented hook payloads; **not yet verified with a real Claude Code session** |
| Project/task workflow, approvals                 | Complete, tested                                                                                   |
| FFmpeg media inventory / render progress parsing | Not implemented (render state is shown as indeterminate)                                           |
| Git branch / diff review                         | Not implemented                                                                                    |
| Managed execution (Agent SDK/CLI)                | Not implemented; off by design                                                                     |
| Tauri `.exe` packaging                           | Not implemented; runs as local server + browser                                                    |
| Reference PNGs (`references/*.png`)              | Never received; art is procedural                                                                  |

## Demo and sample data

`Start demo` replays a 22-step scripted scenario (planning, a video render, an app build, a QA failure and revision). It is broadcast-only: nothing is written to the database. The Projects page starts empty; create a project to try the workflow.

## Documentation

[ARCHITECTURE.md](ARCHITECTURE.md) · [ROUTING.md](ROUTING.md) · [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) · [CLAUDE_INTEGRATION.md](CLAUDE_INTEGRATION.md) · [SECURITY.md](SECURITY.md) · [WINDOWS_SETUP.md](WINDOWS_SETUP.md) · [TEST_REPORT.md](TEST_REPORT.md)
