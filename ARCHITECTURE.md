# Architecture

```
Claude Code session ──hook (stdin JSON)──► tools/hooks/ai-office-hook.mjs
                                              │  POST /api/hooks/claude  (hook token)
                                              │  server down? → <dataDir>/spool/*.jsonl
                                              ▼
 apps/server (Fastify, 127.0.0.1:4317)  ── normalize ─► Ingestor ─► SQLite (node:sqlite, WAL)
        │                                                  │
        │                                                  └─► AgentRegistry (in-memory reducer)
        ├─ REST /api/*  (UI token)                                  │
        └─ WebSocket /ws  ◄─────────────── events + agent snapshots ┘
                 ▼
 apps/web (React 19 + Vite + Tailwind) ── Zustand store ── PixiJS OfficeScene (outside React)
```

## Packages

| Path              | Role                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/shared` | zod schemas (events, agents, WS), departments/roles, workflow state machine, sanitizers, tool→activity mapping |
| `apps/server`     | Fastify API, ingestion, registry, SQLite, demo runner, spool drain, housekeeping                               |
| `apps/web`        | UI: Office, Projects, Integration                                                                              |
| `tools/hooks`     | hook script + reversible installer                                                                             |
| `fixtures/hooks`  | 20 hook payload fixtures used by tests                                                                         |

## Decisions and deviations

- **`node:sqlite` instead of Drizzle/Prisma/better-sqlite3**: no native compilation on Windows. Costs: Node >= 22.13 required, hand-written SQL migrations (`schema_migrations` table), and the module is still flagged experimental by Node.
- **PixiJS scene outside React**: React owns panels; `OfficeScene` is a plain class driven by store snapshots, so 60 fps rendering does not re-render React. Frame rate drops to 12 fps when idle.
- **Procedural art**: no external image assets (the reference PNGs were never provided).

## Normalized event

`eventId` (deterministic → dedup), `timestamp`, `sourceType` (`observed|orchestrated|manual|demo`), `sessionId`, `parentSessionId`, `agentId`, `projectId`, `taskId`, `departmentId`, `eventType`, `status`, `summary`, `safeMetadata`, `correlationId`. Prompts are never stored (only length). Commands are stored only when `AI_OFFICE_CAPTURE_COMMANDS=on`. Paths are reduced to safe labels; secrets are redacted.

## Agent registry

- Real agents: `sess:<sessionId>` and `sub:<sessionId>:<agentId>`. Roster placeholders `roster:<roleId>` are shown (tagged ROSTER) only while no real agent holds that role. Demo agents are `demo:<roleId>`.
- Freshness: `live` → `stale` → `ended` / `none`. **Silence becomes "stale", never "finished"**. `Stop` means idle, not session end; only `SessionEnd` ends a session.
- Subagent type → role is editable (`role_definitions.subagent_types`).
- Project link: session `cwd` prefix-matched to project folder; project kind picks department (video→Video Editor, app→App Development, general→Planning).
- `restore()` replays recent events on startup.

## Events → animation mapping

| Hook / event                         | Activity        | Visual                                         |
| ------------------------------------ | --------------- | ---------------------------------------------- |
| SessionStart                         | idle            | avatar appears at desk (LIVE tag)              |
| UserPromptSubmit                     | thinking        | thought bubble                                 |
| PreToolUse Read/Grep/Glob            | reading         | document bubble                                |
| PreToolUse Write/Edit                | coding          | typing at monitor                              |
| PreToolUse Bash + ffmpeg             | rendering       | indeterminate "ffmpeg…" bar (never a fake %)   |
| PreToolUse Bash + test command       | testing         | QA-style bubble                                |
| PreToolUse WebSearch/WebFetch        | researching     | magnifier bubble                               |
| PreToolUse Task/Agent, SubagentStart | meeting         | sub-avatar spawns, walks to meeting seats      |
| PostToolUseFailure, StopFailure      | error           | red alert                                      |
| PermissionRequest, Notification      | waiting for you | attention marker + toast "Answer it in Claude" |
| Stop                                 | idle            | returns to desk                                |
| SessionEnd                           | ended           | avatar leaves                                  |
| silence > 2 min                      | stale           | dimmed, "last seen" shown                      |

## Workflow

Statuses: backlog → planned → in_progress → qa → revision/completed, plus blocked. `checkTransition` enforces the allowed map, unmet dependencies, the approval gate, and evidence before QA. Dependency cycles are rejected. A revision bumps the task version and expires old approvals. Templates exist for app, video and general projects.

## Task Router

`apps/server/src/router.ts` + `packages/shared/src/routing.ts`. After the Ingestor stores a (deduplicated) event, the router classifies prompts (in memory, deterministic rules), creates a work item with per-department stages, updates stage states from observed tool/stop/session events, and derives the 4 department states (`available … offline`) broadcast as `{type:"departments"}`. It moves the session's single avatar to the department doing the current operation. It writes only its own tables, never ingests events (re-entrancy guard), and never launches agents. Full description: [ROUTING.md](ROUTING.md).

## Database

17 tables in `apps/server/migrations/001_init.sql`, plus 4 routing tables in `002_routing.sql` (routing_rules, work_items, work_item_stages, routing_log) (profile, departments, role_definitions, projects, sessions, agents, tasks, task_dependencies, task_assignments, workflow_transitions, events, artifacts, approvals, notifications, integration_settings, execution_jobs, app_settings). `execution_jobs` exists for the future managed-execution phase and is unused today. Backups via `VACUUM INTO` with rotation; event retention pruning by `AI_OFFICE_RETENTION_DAYS`.
