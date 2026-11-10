# Task routing and team automation

The Task Router decides which departments are responsible for each request and shows their state in the office. It is **rule-based and deterministic**: it never calls a model, never launches agents and never runs commands. It observes real Claude Code events, assigns responsibility and records evidence.

Settings, rules, a prompt tester, the task list and the audit log are under **Integration → Team Automation Rules** (`/integration/automation`).

## How a request flows

```
UserPromptSubmit ─► Planning classifies the prompt (in memory) ─► work item + department stages
                                                                     │
PreToolUse / PostToolUse / Stop / SessionEnd ─────────────────────────┴─► stage states ─► department states ─► office
```

1. **Planning** takes part in every prompt. It shows `Planning` (active) for a few seconds while delegating, then returns to `Available`, still coordinating open tasks. A Planning-only request (research, strategy, questions) stays in `Planning` for as long as Claude works on it.
2. **Producers** (App Development, Video Editor) are assigned when the prompt asks for their work. They change to `Working` only when a real tool event is observed.
3. **QA** is assigned when the prompt asks for testing, or when a rule demands it (bug fixes). QA also joins automatically when a **real test command runs**, even if the prompt never mentioned tests.
4. The session's **one avatar** walks to the department doing the current operation: Planning on a prompt, Dev while editing, the QA lab while tests run. The router never invents extra workers.

### Classification priority

1. **Explicit instructions:** `@dev`, `@video`, `@qa`, "assign this to the QA team", "planning only", "skip tests".
2. **Project context:** a generic work request ("make it shorter") in a project linked to a folder inherits the project type (video → Video Editor, app → App Development).
3. **Observed activity:** test runners → QA; ffmpeg → Video Editor (only when the task or project is video).
4. **Intent classification:** the action verb at the start of each clause decides.
5. **Keywords:** used only through the rules above, never as plain substring matches.

### What makes a trigger word count

A word counts only when it is the **requested action**. It is ignored when it is:

- inside quotes, inline code, a code block or a `>` block quote;
- negated ("don't build anything yet");
- the topic of a research or how-to request ("Research how to develop a mobile app");
- the object of another action ("Develop an app **to edit videos**" is development only).

Generic verbs (create, make, run, fix, edit…) are resolved by their object: "Create **subtitles**" → Video Editor, "Run unit **tests**" → QA. Prompts are split into clauses at `and`, `then` and commas, so "Edit a reel and verify the subtitles" → Video Editor → QA. When nothing clearly matches, the request stays with Planning: unclear intent never activates every department.

The **Test a prompt** box shows the result, which rule matched, and which trigger words were ignored and why. It is a dry run: nothing is stored or assigned.

## Department states

`available · planning · assigned · working · waiting · testing · reviewing · blocked · completed · error · offline`

| State     | Comes from                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| planning  | a prompt was just classified, or a Planning-only request is in its turn                                                                                    |
| assigned  | the router assigned the department; no work observed yet (or returned by QA for revision)                                                                  |
| working   | a real tool event for this department                                                                                                                      |
| testing   | a real test command is running (QA)                                                                                                                        |
| reviewing | QA is doing non-test review work, or a QA-mapped subagent is running                                                                                       |
| waiting   | another department is active, approval is pending, verification is outstanding, **or no events arrived for the inactivity timeout** (shown as "no signal") |
| blocked   | Claude is waiting for your permission decision                                                                                                             |
| completed | verified pass, or the turn ended normally after observed work (shown briefly)                                                                              |
| error     | verification failed, the turn failed, or the session ended mid-turn (shown briefly)                                                                        |
| offline   | the department is switched off in settings                                                                                                                 |

Planning also reports a **mode**: `active` (planning or doing real planning work), `monitoring` (classification on and a live observed session exists), or `idle`.

## Task (work item) lifecycle

One work item per prompt. A short continuation ("continue", "yes", "go ahead") or a revision prompt for the same departments updates the existing item instead.

| Status                 | Meaning                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| assigned / in_progress | assigned / observed work in progress                                    |
| testing                | a test run is in progress                                               |
| revision               | QA observed a **failed** run; work returned to the producing department |
| awaiting_verification  | QA was required but no completed test run was observed                  |
| waiting                | the turn ended without observed work for an assigned department         |
| pending_approval       | approval mode: waiting for you                                          |
| completed              | turn ended; all assigned work observed; required verification passed    |
| accepted               | **you** accepted the outcome (recorded, including over failed tests)    |
| interrupted            | the session ended mid-turn: outcome unknown                             |
| unknown                | no events for the task timeout mid-turn: outcome unknown                |
| superseded / cancelled | a new prompt arrived mid-turn / you cancelled it                        |

A failing test run is **never** shown as approval or completion. Observed test results are stored as evidence (event ids) on the task. When the session is linked to a board task, the results are also attached to that task as `test-result` artifacts. The board task is never moved automatically.

Manual overrides on each task: **Approve assignment**, **Accept outcome**, **Reassign…**, **Cancel task**. All are logged with actor "you".

## Configuration

Stored in the local database: rules in `routing_rules`, settings in `app_settings['routing.settings']`.

| Setting             | Default                  | Effect                                                                     |
| ------------------- | ------------------------ | -------------------------------------------------------------------------- |
| Task assignment     | Automatic                | Approval mode holds assignments until you approve. It never pauses Claude. |
| Classify prompts    | on                       | Off: every prompt stays with Planning                                      |
| QA auto-detection   | on                       | Activate QA on real test commands                                          |
| Department priority | Dev, Video, QA, Planning | Tie-breaker when two rules match equally well                              |
| Department on/off   | all on                   | Off = `offline`, never assigned                                            |
| Inactivity timeout  | 120 s                    | Working/testing with no events → shown as waiting / no signal              |
| Task timeout        | 30 min                   | Mid-turn task with no events → `unknown`                                   |

**Rules**: _prompt rules_ have action words/phrases (matched at the start of a clause, with inflections and up to three words in between, e.g. "fix bug" matches "fixing the login bugs") and object words (resolve generic verbs). They can name follow-up departments ("Then also") or only suggest. _Observed activity rules_ use regular expressions against the command, which is used transiently and never stored. The built-in "media / subtitle verification" rule (ffprobe, subtitle linters) ships **disabled**, because ffprobe is also used during normal editing. Enable it if you want such commands to count as QA.

Built-in rules can be edited or disabled but not deleted. **Restore built-in defaults** resets them and keeps your custom rules.

## Privacy

The hook now sends prompt text **to the local server only** (127.0.0.1). The router classifies it in memory and discards it. The database stores only the prompt length, the rule ids and the rule keywords that matched. Prompt text is stripped before anything is written to the offline spool, so a prompt replayed after an outage is routed as "not classified" and stays with Planning. Set `AI_OFFICE_FORWARD_PROMPT=off` in the environment where Claude Code runs to send only the length, as before. Tests assert that prompt text never reaches the database, the WAL or the spool.

## Safety

- Routing runs only for events that were accepted after deduplication. The work item for a prompt is keyed by the prompt's event id, and stages are unique per (task, department), so duplicate assignments are impossible.
- The router writes only its own tables and never ingests events. A re-entrant call is refused and logged (loop protection). A routing error is logged and never blocks event ingestion.
- No agent is launched, no command is executed, nothing is published or deployed. "Complex" requests are flagged in the log, but no Planning Agent is started because no supported execution method is configured.
- Every decision, assignment, state change, override and error goes to `routing_log`, which is pruned with `AI_OFFICE_RETENTION_DAYS`.

## Known limitations

- **Pass/fail comes from which hook fires.** A test run counts as failed only when Claude Code reports the Bash call through `PostToolUseFailure`. Exit codes and test output are not forwarded.
- **Imperatives work best.** Passive or indirect phrasing ("the login bug needs fixing") is not recognised and stays with Planning. Add action words or use `@dev` if you phrase things this way.
- **One session = one executor.** When a session moves from Dev to QA, Dev shows `waiting`. Parallel work is only shown when there are multiple sessions or role-mapped subagents.
- **Render progress is not measured.** ffmpeg work is shown as "progress not measured", never as a fake percentage.
- **English only.** Default trigger words, prefixes and inquiry words are English. All of them are editable.
- **Observation, not control.** Assignments label responsibility in the office. They cannot inject tasks into, or steer, a running Claude Code Desktop session.
