# Claude Code integration

## Adapter A – Observability (implemented)

AI Office watches Claude Code through **documented command hooks**. It does not read private Desktop IPC, does not mutate transcripts, and has **no control** over existing Desktop sessions.

### Hooks used (14)

SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Notification, PermissionRequest, Stop, StopFailure. Any other hook name is ignored.

### What the hook does

`tools/hooks/ai-office-hook.mjs` reads the hook JSON from stdin, keeps a whitelist of fields, and POSTs to `http://127.0.0.1:4317/api/hooks/claude` with a hook token (1.2 s timeout). If the server is unreachable it appends to `<dataDir>/spool/*.jsonl`, and the server drains the spool on start and every 15 s. For `UserPromptSubmit` it also sends the prompt text (up to 4,000 characters) to the local server only, so the Task Router can classify it in memory. It is never stored, and it is stripped before spooling. Set `AI_OFFICE_FORWARD_PROMPT=off` to send only the length. See [ROUTING.md](ROUTING.md). It **always exits 0 and prints nothing**, so it can never block or alter Claude's behavior. It is installed with `async: true`.

### Installer

```
node tools/hooks/install.mjs install   --project <dir> [--dry-run] [--yes]
node tools/hooks/install.mjs uninstall --project <dir> [--yes]
node tools/hooks/install.mjs status    --project <dir>
```

- Edits only `<dir>/.claude/settings.local.json` (project-local). Global settings are never touched.
- Shows the exact change first; writes nothing without `--yes` or an interactive `y`.
- Backs up the existing file and records a manifest. Idempotent. Refuses invalid JSON.
- Uninstall removes only AI Office entries (and the file, if AI Office created it).

Each event gets `{ matcher: "", hooks: [{ type: "command", command: 'node "<path>/ai-office-hook.mjs"', async: true, timeout: 5 }] }`.

### Limits you should know

- Observability does not mean control. Permission prompts must be answered inside Claude; the dashboard can only dismiss its own alert (API returns `409 not_supported` for approve/deny).
- No events does **not** mean done: silent sessions show as "stale".
- Hook payload shapes follow Anthropic's public docs and the 20 fixtures in `fixtures/hooks`. **They have not been checked against a live session yet.** Field names may differ by Claude Code version; if so, only `apps/server/src/normalize.ts` needs adjusting.
- Hooks must be installed per project, and sessions started before installation are not observed.

### First live verification (please do this)

1. `pnpm start`, open the dashboard.
2. `pnpm hooks:install --project <a test folder> --yes`.
3. Start a **new** Claude Code session in that folder and ask it to read a file.
4. A LIVE avatar should appear. If not, run `pnpm hooks:status` and check `<dataDir>/spool` for queued events.

## Adapter B – Managed execution (not implemented)

Planned as optional and separately configured (Agent SDK / CLI), off by default (`AI_OFFICE_MANAGED_EXECUTION=off`), never bypassing Claude's permission system, and with no assumption that a subscription covers SDK usage. Nothing in this repo launches Claude today.
