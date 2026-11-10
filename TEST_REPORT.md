# Test report

Environment: Linux sandbox, Node 22, pnpm 10.28, headless Google Chrome (SwiftShader). Last full run: 2026-11-10, after milestone M1. The app has also been **launched on your Windows PC** (Node 26.13), where the demo animated correctly (your screenshots). **No automated test has run on Windows, and no real Claude Code session has been observed.**

## Results

| Suite                                                                   | Result                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| shared (schemas, workflow, sanitizers)                                  | **24 / 24**                                                        |
| server (hooks ingest, API, infra, integration status, registry linking) | **51 / 51**                                                        |
| hook script and installer                                               | **12 / 12**                                                        |
| web unit (WebSocket reconnect/backoff, history loading, formatting)     | **12 / 12**                                                        |
| e2e (Playwright, headless Chrome)                                       | **9 / 9**                                                          |
| TypeScript (`pnpm -r typecheck`)                                        | clean                                                              |
| ESLint                                                                  | 0 errors, 0 warnings                                               |
| Production build                                                        | succeeds (main chunk ~700 kB; Vite warns about chunk size)         |
| `pnpm audit --prod`                                                     | no known vulnerabilities                                           |
| `pnpm audit` (all)                                                      | 1 moderate, dev tooling only (`minimatch` via `typescript-eslint`) |

Total automated tests: **108**.

## Hands-on verification (not unit tests)

Performed against a clean server with a fresh data folder:

- The real hook script was spawned with JSON on stdin 7 times: always exit 0, no stdout. An API key in a prompt and `--token=...` in a command line never reached the database (checked by reading the events table).
- Server stopped, hook run, server restarted: the spooled event was imported and the spool folder emptied.
- Security probes (curl): no token 401; wrong Host 403; wrong Origin 403; hook token on a UI route 401; UI token on the hook route 401; forged `observed` or `demo` events 400; approving a Claude permission 409.
- Session started before its project existed: moved to the project's department on its next event; a new session in a subfolder matched the project by path.
- Screenshots of Office, Projects (board and approval queue), Integration and the Inspector with real (hook-fed) agents.
- Real installer wrote hooks into a scratch folder and the server's independent read-only check reported `installed`.
- Idle cost measured in the sandbox: ~14 frames/s in headless Chrome, server ~1.4% CPU and 90 MB.

## Regression tests added in M1 (each proven to fail without its fix)

- Registry: a session already running when its project is created moves department, and its subagents inherit the project.
- Web e2e: after a page reload the activity log and "Last real event" still show stored real events.

## Not tested / not verified

- **Real Claude Code hook payloads** (fixtures follow documentation, not captured output).
- Windows: hook install, path quoting, file permissions on the token; no automated tests on Windows.
- FFmpeg, git, and test-result integrations, managed execution, Tauri packaging (not implemented).
- Performance on a real GPU; accessibility audit.
- Visual quality judged from screenshots only.

## Known issues

- Some roster placeholders stand in overflow spots and a few labels overlap (cosmetic).
- Integration page can show "0 dashboard connection(s)" for a moment after load.
- Experimental SQLite warning printed by Node.

## Task routing (2026-11-10)

- `pnpm -r test`: 166 passing (shared 65, hooks 15, web 12, server 74). Lint, typecheck and build are clean.
- `pnpm test:e2e` with system Chrome (`PLAYWRIGHT_CHROME`): 10/10, including a new end-to-end routing test (prompt → Planning → Dev → real test run → QA → passed).
- Required scenarios A–J are covered by `packages/shared/src/routing.test.ts` (classifier) and `apps/server/test/routing.test.ts` (hook endpoint → router → database).
- Manual run: 11 events sent through the **real hook script** (stdin) for 3 concurrent sessions. Departments, tasks and the avatar rooms were correct. A failing test run showed as a revision, not completion. A `grep` of the data directory (db, WAL) found no prompt text.
- Migration `002_routing.sql` was applied to a **copy** of the live database: all existing rows were preserved (projects 2, events 123, sessions 4, agents 5).
- Not yet verified: prompt routing from a real Claude Code Desktop session (the hook payloads follow the documented fields).
- Fixed a pre-existing race in `infra.test.ts › demo stop over a live socket`. It failed consistently before this change because in-flight snapshots arrived after the buffer was cleared.
