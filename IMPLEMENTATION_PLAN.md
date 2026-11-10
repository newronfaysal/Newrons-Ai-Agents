# Implementation plan and log

## Phase status

| Phase                | Scope                                                                        | Status                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Foundation         | monorepo, shared schemas, DB + migrations, config, security, REST API, tests | **Done**                                                                                                                                                      |
| 2 Virtual Office     | Pixi office, 4 rooms, 14 roles, avatars, bubbles, camera, demo, inspector    | **Done** (procedural art; no reference PNGs received)                                                                                                         |
| 3 Live observability | hook script, installer, ingest, dedup, spool, registry, WS                   | **Done in code and tests; live Claude session unverified**                                                                                                    |
| 4 Productivity       | planning/routing, kanban, dependencies, approvals, QA/revision               | **Partial**: workflow, kanban, approvals, evidence done. **Missing**: FFmpeg inventory/progress parsing, git branch/diff review, test-result file integration |
| 5 Managed execution  | Agent SDK / CLI adapter                                                      | **Not started** (schema placeholder only)                                                                                                                     |
| 6 Release quality    | tests, security, perf, Tauri                                                 | **Partial**: tests, lint, typecheck, security controls done. **Missing**: Tauri, perf profiling on real hardware                                              |

## Checklist for remaining work

- [ ] Verify hooks with a real Claude Code session on Windows; adjust `normalize.ts` if payloads differ
- [ ] FFmpeg/ffprobe media inventory and real render progress (`-progress` parsing)
- [ ] Git branch display and read-only diff review
- [ ] Test-result import (JUnit/Vitest JSON) as QA evidence
- [ ] Managed execution adapter (opt-in, separate config)
- [ ] Tauri shell + Node sidecar, signed installer
- [ ] Reference art (`references/*.png`) → restyle sprites
- [ ] Performance measurement on target hardware

## Risk register

| Risk                                        | Likelihood | Impact                  | Mitigation                                                     |
| ------------------------------------------- | ---------- | ----------------------- | -------------------------------------------------------------- |
| Hook payloads differ from docs/fixtures     | Medium     | Avatars wrong/missing   | Isolated in `normalize.ts`; unknown hooks ignored; verify live |
| `node:sqlite` API changes                   | Low-Med    | DB layer breaks         | thin wrapper in `db.ts`; pin Node major                        |
| Windows-specific path/quoting bugs          | Medium     | Installer or hook fails | quoted commands, tests for spaces; unverified on Windows       |
| Users read "no events" as "done"            | Medium     | Misleading status       | stale state, never "finished"                                  |
| Secret leakage in events                    | Low        | High                    | no prompt storage, redaction, commands off by default          |
| Local API abuse from web pages              | Low        | High                    | host/origin allowlist, tokens, CSRF header                     |
| Managed execution cost/permission surprises | n/a yet    | High                    | off by default, separately configured                          |

## Implementation log (key milestones and fixes)

1. Scaffolded pnpm monorepo; shared schemas and workflow state machine (24 tests).
2. Server: migrations, registry, ingest, security; fixed `node:sqlite` loading under vitest (createRequire), empty JSON body handling, static wildcard route.
3. Hook script and installer (12 tests); fixed a flawed spawnSync test and fixture mismatch.
4. Web: Pixi scene, layout/overlap fixes, roster stacking, demo runner. **Real bug found and fixed**: stopping the demo did not broadcast the agents snapshot, leaving ghost avatars; covered by a regression test.
5. Projects kanban, approval gate, task drawer; e2e suite (8 flows) and web unit tests for reconnect/backoff (9).
6. ESLint + Prettier configured; lint clean, typecheck clean.
7. Audit (see PROJECT_STATUS.md), then milestone M1: event history on load, server-side integration status with per-project hook check, registry linking fix, production dependency vulnerabilities cleared (zod 4, @fastify/static 10, vitest 5), 9 new tests.
