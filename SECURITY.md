# Security

## Threat model

A local single-user app. Threats: other websites in your browser calling the local API (CSRF / DNS rebinding), other local processes forging events, accidental secret capture, and the installer damaging your Claude configuration.

## Controls (implemented and tested)

| Control                       | Detail                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Localhost binding             | default `127.0.0.1` only                                                                                                                                                                                                                                                                                                               |
| Host and Origin allowlist     | blocks DNS rebinding and foreign origins; CORS restricted to the same list                                                                                                                                                                                                                                                             |
| Two separate tokens           | _hook token_ (file in data dir, `0600` on POSIX; Windows ignores the mode, so it relies on your user profile ACLs) can only call the hook endpoint. _UI token_ is per-process, from `GET /api/bootstrap` which requires header `x-requested-with: ai-office`. Neither works on the other's routes                                      |
| Write endpoints authenticated | all mutations need the UI token                                                                                                                                                                                                                                                                                                        |
| No fake "live" events         | `POST /api/events` rejects `sourceType` `observed` and `demo`                                                                                                                                                                                                                                                                          |
| No permission bypass          | approving/denying Claude permission requests returns `409 not_supported`; only local dismissal                                                                                                                                                                                                                                         |
| Data minimisation             | prompts never stored (length only; prompt text goes only to the local server for in-memory routing, is never spooled, and can be turned off with `AI_OFFICE_FORWARD_PROMPT=off`, see ROUTING.md); commands stored only with `AI_OFFICE_CAPTURE_COMMANDS=on`; paths reduced to labels; secret patterns redacted before storage and logs |
| Installer safety              | project-local only, explicit consent, dry run, backup + manifest, idempotent, refuses invalid JSON, uninstall removes only own entries                                                                                                                                                                                                 |
| No hardcoded secrets          | `.env.example` contains no credentials; none are required                                                                                                                                                                                                                                                                              |
| Retention                     | sanitized events pruned after `AI_OFFICE_RETENTION_DAYS` (default 30)                                                                                                                                                                                                                                                                  |

## Known limitations

- The hook token is a plain file; any process running as you can read it. This is inherent to local-first design.
- `node:sqlite` is flagged experimental by Node.
- Redaction is pattern-based and best-effort; do not rely on it for unknown secret formats. Leave command capture off.
- `pnpm audit` was run on 2026-11-10: after upgrading `zod` (4.6.7), `@fastify/static` (10.1.10) and `vitest` (5.x) there are **0 known vulnerabilities in production dependencies** and 1 moderate advisory (`minimatch` via `typescript-eslint`) in dev tooling that never ships or runs at runtime. Re-run `pnpm audit` periodically. No formal penetration test was done; the security checks listed above were exercised with curl probes and automated tests.
- Read-only API endpoints (agents, events, projects, integration status) need no token; they are protected only by the Host/Origin allowlist and localhost binding. Any local process running as you can read them. Writes always need the UI token.
- The hook script finds its data folder from its own location or `AI_OFFICE_DATA_DIR`. If you move the server's data folder, set the same variable for Claude (or leave the default) or events will be buffered to a folder the server is not reading.
- The integration status check reads `<project folder>/.claude/settings.local.json` for projects you registered. It only reports installed/not installed and never returns file contents or writes.
- Not code-signed; no auto-update (no installer exists yet).
- If you bind to a non-loopback host, the app is no longer safe; do not do this.

## Reporting

Personal project; fix issues locally.
