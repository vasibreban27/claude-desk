# Plan: Phase 2 - Tracking and usage

Source: `docs/vision.md`, Phase 2. Nothing beyond this phase is planned here.

Branch: `phase-2-tracking-usage` (never `main`), cut from `main` after PR #1 (Phase 1 and 1.5) was merged.

## 1. Goal

As the owner I want to watch what each agent does while a run is going and see afterwards what it cost, so that I can trust and budget the agentic workflow.

Outcomes:
- During a chat run, every tool call (start, end) and every subagent finish shows up live in an Activity feed in the workspace panel, labelled by agent (`main` or the subagent type).
- When a run ends, its cost and token totals are saved locally. A Usage tab shows totals per project, per agent and per day, labelled as estimates.
- The chat can only use read-only tools plus subagents and skills in this phase. The restriction is enforced by a `PreToolUse` hook, not only by option lists.
- Usage survives an app restart; the activity feed (last run per project) does not.

Decisions confirmed with the user: approach B (live feed in memory, SQLite for runs and usage), chat permissions option 1(a) (read-only tools plus subagents). Taken as recommended, not explicitly confirmed: SQLite via `better-sqlite3`, and per-agent usage approximate (cost exact per run and per model only).

## 2. Scope

In:
- SDK `hooks` (`PreToolUse`, `PostToolUse`, `SubagentStop`, `Stop`) registered as in-process callbacks in the runner.
- Mapping of SDK messages and hook inputs to typed `ActivityEvent`s; only mapped events cross IPC, raw SDK objects never do.
- In-memory per-project buffer of the latest run's events (capped).
- SQLite database (`better-sqlite3`) in main with versioned migrations; `runs`, `usage_models`, `usage_agents` tables; a `RunStore`.
- Tool allowlist and a deny-by-default `PreToolUse` guard.
- New IPC: `activity:event`, `activity:history`, `usage:summary`.
- Renderer: workspace tabs (Activity, Usage), live feed, usage tables.

Out (do not build):
- Project settings, per-project policies, model selection, protected paths (Phase 3).
- Worktrees, orchestration, multiple runs per project, queues (Phase 4).
- Persisting individual events or replaying past runs.
- Moving the project store to SQLite (stays JSON behind `ProjectStore`).
- Charts; plain tables and simple bars only.
- Budget limits (`maxBudgetUsd`), billing accuracy claims, currency conversion.
- Interactive permission prompts (`canUseTool`).

## 3. Architecture

Chosen (approach B):
- **Runner** (`src/main/chat/runner.ts`) passes `options.hooks` and turns SDK output into `RunnerItem`s: text deltas, session id, activity (from hooks), assistant-step usage, and the final result usage. Hook callbacks and the message stream are merged into the one async iterable through a small push queue.
- **Pure mapping** (`src/main/chat/activity.ts`): hook input to `ActivityEvent`, assistant message to a per-agent usage accumulator (dedupe by `message.id` plus `parent_tool_use_id`), `result` message to `RunUsage`. All inputs are `unknown` and validated at the boundary.
- **Service** (`src/main/chat/service.ts`) owns the run lifecycle: assigns `runId`, stamps `seq` and `at`, keeps a capped per-project buffer, emits `activity:event`, and at run end writes one run through the injected `RunStore`. Existing chat behaviour (history, `busy`, errors) is unchanged.
- **Guard** (`src/main/chat/tools.ts`): `ALLOWED_TOOLS` = `Read`, `Grep`, `Glob`, `Agent`, `Task` (older SDK name), `Skill`. A `PreToolUse` hook denies every other tool (`permissionDecision: "deny"`), registered with `onFailure: "block"` so a crashing guard fails closed. Tracking hooks use `onFailure: "continue"` and never throw into the run. `allowedTools` carries the same list.
- **Persistence** (`src/main/db/`): `better-sqlite3`, `PRAGMA journal_mode = WAL`, migrations as an ordered array applied in one transaction each and tracked with `PRAGMA user_version`. Parameterized statements only.
- **Usage semantics** (from the current docs, fetched 2026-11-16):
  - `result.total_cost_usd` and `result.modelUsage` include subagents; `result.usage` is the main loop only.
  - Costs are client-side estimates; the docs say nothing specific about subscription logins. The UI labels every cost "estimated".
  - Per-agent tokens are summed from deduplicated `assistant` messages grouped by agent type (`agent_type` on hooks, `agent_id` and `parent_tool_use_id` on messages). Input and cache tokens per step are accurate; per-step `output_tokens` is a placeholder, so subagent output tokens are flagged `approximate`. The main agent's totals come from `result.usage` and are exact.
- **IPC**: one new event channel and two invoke channels, all defined in `src/shared/ipc.ts`, validated in main handlers, exposed through the preload bridge.

Rejected: A, in-memory only (loses "per day" on restart); C, persist every event (database growth with no Phase 2 consumer); JSON file for usage (awkward to aggregate, migration later); `canUseTool` prompts (UI work that belongs with Phase 3 settings).

### Verify before building (CLAUDE.md rule: check current docs, do not rely on memory)
- `better-sqlite3` against Electron 45: a prebuilt binary or a rebuild path (`@electron/rebuild` / `electron-builder install-app-deps`), and how Vitest (plain Node ABI) and Electron (Electron ABI) both load it. T1 decides the scripts. If no workable setup exists, stop and ask the user: the fallback is built-in `node:sqlite`, which changes the stack in `docs/vision.md` and CLAUDE.md.
- SDK option names for restricting tools (`allowedTools`, `disallowedTools`, `tools`, `permissionMode`) and whether `Agent`, `Task` and `Skill` are the exact tool names in `@anthropic-ai/claude-agent-sdk` ^0.3.323. Confirm `onFailure` is supported at that version.
- Whether the `flow` plugin's subagents (`reviewer` and others use `Bash`) fail cleanly when the guard denies a tool, and that a denied tool does not end the run.
- Hook input fields at the installed version: `agent_type` equals the subagent type name, `SubagentStop` fields, `duration_ms` on `PostToolUse`.

## 4. API contract (IPC)

All in `src/shared/ipc.ts`; channel names added to `IPC`; payloads validated with zod in main handlers; `DeskApi` gains matching methods.

```
activity:event    main -> renderer (like chat:event)
  ActivityEvent = {
    projectId: uuid, runId: string, seq: int >= 0 (per run, starts at 0),
    at: ISO-8601 with offset,
    agent: string          // "main" or the subagent type
    agentId: string | null // SDK agent_id; null for main
  } & one of:
    { type: "run-started" }
    { type: "tool-started",  toolUseId: string, tool: string, summary: string(0..200) }
    { type: "tool-finished", toolUseId: string, tool: string, durationMs: int | null, denied: boolean }
    { type: "agent-finished", summary: string(0..200) }
    { type: "run-finished", status: "success" | "error", costUsd: number | null, durationMs: int | null }

activity:history  invoke   auth: none (local)
  req:  { projectId: uuid }
  res:  ActivityEvent[]    // latest run of that project, oldest first, at most ACTIVITY_BUFFER_MAX = 500 (oldest dropped); [] if none or unknown project

usage:summary     invoke
  req:  { projectId: uuid | null, days: int(1..365) }   // null = all projects; window = last `days` local calendar days including today
  res:  UsageSummary = {
    days: int, estimated: true,
    totals:    { runs, costUsd, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens },
    byDay:     [{ day: "YYYY-MM-DD" (local date), runs, costUsd, inputTokens, outputTokens }],   // ascending, only days with runs
    byAgent:   [{ agent: string, steps: int, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, approximate: boolean }],
    byProject: [{ projectId: uuid, runs, costUsd }]       // [] when req.projectId is not null
  }
  invalid req -> an empty summary (zero totals, empty arrays), never a throw
```

`tool-started.summary` is built only from the keys `file_path`, `path`, `pattern`, `description`, `subagent_type`, `skill` of `tool_input` (first present, truncated to 200 chars); otherwise empty. `tool_response` content and any other `tool_input` field are never sent, stored or logged.

Tasks that touch the contract say `Contract: <channel>`.

## 5. Changes per layer

- API / IPC: `src/shared/ipc.ts` (channels, schemas, types, `DeskApi`), `src/main/ipc/handlers.ts`, `src/main/ipc/register.ts`, `src/preload/index.ts`.
- Service (main): `src/main/chat/activity.ts`, `src/main/chat/tools.ts` (new), `src/main/chat/runner.ts`, `src/main/chat/service.ts`, `src/main/index.ts` (open the database, pass the store).
- Database: `src/main/db/` (new): connection, migrations, `RunStore`. DB file in `app.getPath('userData')/data/claude-desk.db`. `better-sqlite3` and rebuild scripts in `package.json`.
- UI (renderer): `src/renderer/src/hooks/useActivity.ts`, `useUsage.ts`; `components/Activity/`, `components/Usage/`, `components/Workspace/` (new); `App.tsx` mounts the workspace.

## 6. Risks

| Risk | Mitigation |
|---|---|
| `better-sqlite3` ABI mismatch between Electron and Vitest | T1 spike first, scripts for both ABIs, documented in `docs/notes/sqlite-spike.md`; a failing spike stops the phase and goes back to the user. |
| Chat runs with tools can modify the main checkout | Deny-by-default `PreToolUse` guard, fail closed, plus `allowedTools`; tested with a denied `Write` and `Bash`. |
| Denied tools break subagents (e.g. `reviewer` uses `Bash`) | The guard returns a deny reason; the run continues. Verified in T1/T4 notes; accepted limitation until Phase 3. |
| Sensitive data in the feed (tool input, file contents) | Summary built from allowlisted keys only, truncated, never from `tool_response`; nothing persisted; no event text logged. |
| Double-counted tokens (parallel tool calls share a `message.id`) | Dedupe on `message.id` plus `parent_tool_use_id`; unit test with duplicated ids. |
| Cost misread as billing | Every cost in UI and contract is marked estimated; `estimated: true` in the summary. |
| A hook callback throws and breaks the run | Tracking hooks wrapped in try/catch returning `{}`; only the guard blocks on failure. |
| Unbounded event buffer | Capped at 500 per project, oldest dropped; test covers the cap. |
| Crash mid-run loses that run's usage | Accepted: a run is written at its end. Noted in Follow-ups if it hurts. |
| Existing tests assert the old runner/service shape | T4 updates `service.test.ts`; `RunnerItem` stays backward compatible for `text` and `session`. |

## 7. Test strategy

- Unit (Vitest): hook input to `ActivityEvent` (each hook, main vs subagent, summary key rules and truncation, unknown input ignored); usage accumulator (dedupe, per-agent grouping, result overrides main totals); guard (allowed and denied tools, throws means deny); migrations (fresh db, re-open is a no-op, newer `user_version` rejected); `RunStore` against in-memory SQLite (insert, rollback on failure, summary by day/agent/project, local-day boundaries, empty window); zod schemas (valid, invalid, caps).
- Service (runner mocked): events stamped with increasing `seq`, buffer cap, `run-finished` on success and on `is_error`, usage written once per run, one failing store write does not break the chat turn, `busy` unchanged.
- Component (Testing Library, `window.api` mocked): ActivityFeed (live append, history on mount, grouping by agent, denied badge, empty state, project switch), UsageView (tables, estimated label, approximate marker, range switch, empty state, error state), Workspace tabs (keyboard, roles).
- Integration (`tests/`): fake runner emitting hooks and a result, through the real service, a temp SQLite file and the handlers; asserts feed events and `usage:summary`.
- Not tested deliberately: the live SDK, real cost accuracy, Electron packaging. Covered by the manual check note (T9).

## 8. Tasks

### Wave 1

### T1: SQLite dependency and spike
- Status: [x] verified
- Worker: node-developer
- Contract: none
- Owns: `package.json`, `package-lock.json`, `electron.vite.config.ts` (or the file actually used by the scaffold), `vitest.config.ts`, `docs/notes/sqlite-spike.md`, `tests/sqlite-smoke.test.ts`, the Commands section of `CLAUDE.md`
- Depends on: none
- Acceptance criteria:
  - Given the current Electron version When `better-sqlite3` is added Then `npm run dev` and `npm run build` still work and a `better-sqlite3` import in main bundles as an external, loadable module.
  - Given Vitest runs under Node When a test opens `new Database(':memory:')` Then it passes, and `npm test` works after a fresh `npm install` without a manual rebuild step (or the single required step is a documented npm script).
  - Given the Electron ABI When a one-off script or dev run opens an in-memory database inside Electron's main process Then it succeeds (result recorded in `docs/notes/sqlite-spike.md`).
  - Given `docs/notes/sqlite-spike.md` When read Then it states the chosen rebuild setup, the docs consulted, and how to switch ABIs; if no workable setup exists it says so and the worker stops without adding a fallback.
  - Given the new scripts When `CLAUDE.md` Commands is read Then it matches `package.json` scripts.

### T2: IPC contract, event mapping and tool guard
- Status: [x] verified
- Worker: node-developer
- Contract: `activity:event`, `activity:history`, `usage:summary`
- Owns: `src/shared/ipc.ts`, `src/shared/ipc.test.ts`, `src/main/chat/activity.ts`, `src/main/chat/activity.test.ts`, `src/main/chat/tools.ts`, `src/main/chat/tools.test.ts`
- Depends on: none
- Acceptance criteria:
  - Given the contract section When `ipc.ts` is read Then channels, zod request schemas (`activityHistoryRequestSchema`, `usageSummaryRequestSchema`), `ActivityEvent`, `UsageSummary`, `ACTIVITY_BUFFER_MAX` and the three `DeskApi` methods exist exactly as specified, with no `any`.
  - Given a `PreToolUse` hook input for `Read` with `tool_input.file_path` When mapped Then a `tool-started` event has `summary` equal to the path, truncated to 200 chars; given an input with only other keys Then `summary` is empty and none of those values appear.
  - Given hook inputs with and without `agent_id` and `agent_type` When mapped Then `agent` is the type name and `agentId` is set for subagents, and `"main"` and `null` otherwise.
  - Given `PostToolUse`, `SubagentStop` and `Stop` inputs When mapped Then `tool-finished` (with `durationMs`, `denied: false`), `agent-finished` (summary from `last_assistant_message`, truncated) and no event for the main `Stop` are produced; malformed input maps to `null`.
  - Given assistant messages sharing a `message.id` When accumulated Then their usage counts once; messages with a `parent_tool_use_id` are attributed to the subagent group, and a result message yields `RunUsage` with cost, per-model usage and the main-loop token totals.
  - Given the guard When called with `Read`, `Grep`, `Glob`, `Agent`, `Task`, `Skill` Then it returns `{}`; with `Write`, `Edit`, `Bash`, `NotebookEdit`, `WebFetch` or an unknown name Then it returns `permissionDecision: "deny"` with a reason, and a malformed input is denied.

### Wave 2

### T3: Database layer and RunStore
- Status: [x] verified
- Worker: node-developer
- Contract: `usage:summary` (result shape)
- Owns: `src/main/db/**` (including tests)
- Depends on: T1, T2
- Acceptance criteria:
  - Given a new database file When opened Then migrations create `runs`, `usage_models`, `usage_agents` with indexes on `runs(project_id, started_at)`, `user_version` equals the migration count, and WAL is on; re-opening applies nothing; a `user_version` higher than known throws a typed error.
  - Given a `RunUsage` for a run When `recordRun` is called Then one `runs` row, its `usage_models` and `usage_agents` rows are written in one transaction; given a failure halfway Then nothing is written.
  - Given runs on several local days, projects and agents When `summary({ projectId, days })` is called Then totals, `byDay` (local date, ascending), `byAgent` and `byProject` match the contract; `byProject` is empty when a project is given; runs outside the window are excluded; an empty window returns zero totals and empty arrays.
  - Given an agent whose output tokens came from placeholders When summarized Then `approximate` is true for it and false for `main`.
  - Given hostile strings (quotes, `;`, unicode) as `agent` or `model` When stored and read Then they round-trip unchanged (parameterized statements).

### Wave 3

### T4: Runner and service run lifecycle
- Status: [x] verified
- Worker: node-developer
- Contract: `activity:event`, `activity:history`
- Owns: `src/main/chat/runner.ts`, `src/main/chat/service.ts`, `src/main/chat/service.test.ts`, `src/main/chat/runner.test.ts`
- Depends on: T2, T3
- Acceptance criteria:
  - Given the runner When `query()` options are built Then `hooks` hold the guard (`onFailure: "block"`) and the tracking callbacks, `allowedTools` equals `ALLOWED_TOOLS`, and existing options (`cwd`, `plugins`, `includePartialMessages`, `resume`, abort) are unchanged.
  - Given a mocked stream with hooks firing and a final `result` When run Then the runner yields `text`, `session`, `activity` and one `usage` item in order, and yields `usage` before throwing when `result.is_error` is true.
  - Given a send When a run starts Then the service emits `run-started` (`seq` 0), then events with strictly increasing `seq`, then exactly one `run-finished` (`success` or `error`), all with the same `runId`.
  - Given more than `ACTIVITY_BUFFER_MAX` events in one run When `activityHistory(projectId)` is read Then it returns the newest 500 in order; given a second run for the project Then the buffer is replaced; given an unknown project Then `[]`.
  - Given a finished run When it ends Then `RunStore.recordRun` is called once with the run's usage; given `recordRun` throws Then the chat turn still ends with `done` and the error is logged without payload content.
  - Given the existing `service.test.ts` cases (history, `busy`, errors, session resume, config error) When run Then they pass with only mechanical updates.

### T5: Activity feed (renderer)
- Status: [x] verified
- Worker: frontend-developer
- Contract: `activity:event`, `activity:history`
- Owns: `src/renderer/src/hooks/useActivity.ts`, `src/renderer/src/hooks/useActivity.test.ts`, `src/renderer/src/components/Activity/**`
- Depends on: T2
- Acceptance criteria:
  - Given a selected project When mounted Then `window.api.activityHistory` loads its events; given `onActivityEvent` events for that project Then they append in `seq` order; events for other projects are ignored; the subscription is removed on unmount.
  - Given events from `main` and from a subagent When rendered Then each row shows time, agent, tool and summary, and subagent rows are visibly distinguished (label plus indent or badge, not color alone).
  - Given a `tool-started` and its `tool-finished` When rendered Then they show as one row with duration; a `denied` finish shows a "Denied" badge; an unfinished tool shows "running".
  - Given `run-finished` When rendered Then a footer row shows status and estimated cost ("~$0.0123"); given no events Then the empty state "No activity yet. Start a chat run." is shown.
  - Given a `tool-started` with no `tool-finished` (for example the tool failed, wave 1 follow-up F2) When `run-finished` arrives Then that row stops showing "running" and shows "ended" instead.
  - Given the feed grows When it is scrolled up Then it does not jump; when at the bottom Then it follows (reuse the existing `stickToBottom` helper from the chat if it fits, else a local equivalent).

### T6: Usage view (renderer)
- Status: [x] verified
- Worker: frontend-developer
- Contract: `usage:summary`
- Owns: `src/renderer/src/hooks/useUsage.ts`, `src/renderer/src/hooks/useUsage.test.ts`, `src/renderer/src/components/Usage/**`
- Depends on: T2
- Acceptance criteria:
  - Given a selected project When mounted Then `window.api.usageSummary({ projectId, days: 30 })` is called; changing the range (7, 30, 90 days) or the scope (this project / all projects) refetches.
  - Given a summary When rendered Then totals, a per-day table, a per-agent table and (in all-projects scope) a per-project table show; costs are formatted as "~$x.xxxx" and a note says costs are estimates.
  - Given a per-agent row with `approximate: true` When rendered Then its output tokens carry a "~" marker with an accessible description.
  - Given an empty summary When rendered Then "No runs in this period." is shown; given the call rejects Then an error message with `role="alert"` is shown and the previous data is kept.
  - Given a run just finished (`run-finished` for the selected project) When the Usage tab is visible Then the view refetches (the hook accepts a refresh signal prop).

### Wave 4

### T7: IPC wiring and database bootstrap
- Status: [x] verified
- Worker: node-developer
- Contract: `activity:event`, `activity:history`, `usage:summary`
- Owns: `src/main/ipc/handlers.ts`, `src/main/ipc/handlers.test.ts`, `src/main/ipc/register.ts`, `src/preload/index.ts`, `src/preload/index.test.ts`, `src/main/index.ts`, `src/main/index.test.ts`
- Depends on: T4
- Acceptance criteria:
  - Given the preload bridge When `window.api` is inspected Then it exposes `activityHistory`, `usageSummary` and `onActivityEvent` (with unsubscribe), each mapped to one contract channel, and `ipcRenderer` is still not exposed.
  - Given a malformed `activity:history` or `usage:summary` payload When handled Then it returns `[]` or an empty summary and does not throw; a valid payload reaches the service or store with parsed values.
  - Given a project whose chat last sent from a window When activity events are emitted Then only that window receives `activity:event` (same routing as `chat:event`); destroyed windows are skipped.
  - Given app start When `main/index.ts` runs Then the database is opened in `userData/data`, migrations applied, the `RunStore` passed to the chat service; given the database fails to open Then the app still starts, chat works, usage returns an empty summary and the failure is logged once without paths of user data beyond the file name.
  - Given the app quits When `will-quit` fires Then handlers are removed and the database is closed.

### T8: Workspace tabs and app wiring
- Status: [x] verified
- Worker: frontend-developer
- Contract: none (consumes T5 and T6)
- Owns: `src/renderer/src/components/Workspace/**`, `src/renderer/src/App.tsx`, `src/renderer/src/App.test.tsx`
- Depends on: T5, T6
- Acceptance criteria:
  - Given the app When rendered Then the workspace panel shows a tablist with "Activity" and "Usage" (`role="tab"`, `aria-selected`, arrow-key navigation, a labelled `tabpanel`); Activity is selected by default; the choice is remembered in `localStorage` with try/catch and a validated value.
  - Given no project selected When rendered Then the workspace shows the existing empty state instead of the tabs.
  - Given a `run-finished` event for the selected project When it arrives Then the Usage view's refresh signal increments.
  - Given the existing `App.test.tsx` flows (select, stream, done, error, rejected send, other-project events ignored) When run Then they pass; new tests cover the tabs and a mocked activity event appearing in the feed.

### Wave 5

### T9: Smoke - launch check and end-to-end test
- Status: [x] verified
- Worker: node-developer
- Contract: all three channels
- Owns: `tests/phase-2-flow.test.ts`, `docs/notes/phase-2-manual-check.md`
- Depends on: T7, T8
- Acceptance criteria:
  - Given a fake runner emitting hooks (a main `Read`, a subagent `Grep`, a denied `Write`) and a result When driven through the real service, a temp SQLite file and the handlers Then `activity:history` holds the expected events in order and `usage:summary` returns the run's totals, a `main` and a subagent row.
  - Given `npm run build` When run Then it succeeds; given a launch of the built app (automated if a launch test is cheap, otherwise the manual steps) Then `window.api` has the three new methods and no console errors appear.
  - Given `docs/notes/phase-2-manual-check.md` When read Then in under 20 lines it lists the manual steps to confirm "done when": set `CLAUDE_TOOLKIT_PATH`, `npm run dev`, add a project, ask a question that makes Claude read files and call a subagent, watch the feed live, open Usage after the run, restart the app and confirm usage is still there and the feed is empty, and confirm a request to edit a file is denied.

## 9. Wave summary

| Wave | Tasks | Parallel |
|---|---|---|
| 1 | T1, T2 | yes: T1 owns dependency and config files, T2 owns `shared` and new `chat` files |
| 2 | T3 | single task |
| 3 | T4, T5, T6 | yes, disjoint folders; T5 and T6 build against the contract with a mocked `window.api` |
| 4 | T7, T8 | yes, disjoint folders |
| 5 | T9 | smoke |

Workers: `node-developer` for T1-T4, T7, T9 (`src/main`, `src/preload`, `src/shared`); `frontend-developer` for T5, T6, T8 (`src/renderer`). Commits: Conventional Commits with the task id, for example `feat(usage): record runs in SQLite (T3)`.

Done when (from the vision): during a run the user sees each agent's actions live, and afterwards what it cost.

## 10. Follow-ups

### Status after the resolution pass (commits 130d9c1, e736165, 05e1031, 27b21c6, 5115f25, e540638, 2f35150, 1b2c8bb; reviewed in two rounds, security audit PASS)

Resolved: every wave 1-5 finding below (F, S and T-caveat items), including S10 (read tools are scoped to the project folder, UNC/other-drive paths denied with no filesystem access, brace and link-prefix globs denied, `Agent`/`Task` input allowlisted), S1 (identifier caps), `PostToolUseFailure` mapping with per-`toolUseId` dedupe, the `days` validation in `RunStore.summary`, the usage window upper bound, the test timeouts (now scoped to the two git-backed test files; 3 consecutive green full runs of 324-325 tests), `register.test.ts`, and the renderer race, tab and stale-data fixes. `settingSources: []` is in effect with the project's `CLAUDE.md` injected by the main process (S50; see below), brace globs are allowed by expanding and checking every expansion with a bounded filesystem budget (F10, F20, F23, S51), and `Agent`/`Task` accept `name` and `resume` (F11).

Still open:
- Decided (owner, after security audit S50): `settingSources: []`. The owner first chose `['project']`, but the audit (major, FAIL) showed an untrusted repo's `.claude/settings.json` could run command hooks (`SessionStart`, `UserPromptSubmit`), `apiKeyHelper`, `env`, skill shell injections and possibly `disableAllHooks` as the user, outside our guard. Now nothing from a repo's settings, hooks, skills or agents is loaded; the main process reads only `<cwd>/CLAUDE.md` (`src/main/chat/projectContext.ts`: regular file inside the project after `realpath`, bounded 32 KB read, invalid UTF-8 replaced, null on any error, never logged) and appends it to the full `claude_code` preset system prompt as framed project guidance. Project skills and agents do not load; the toolkit comes from `plugins`. A per-project trust setting that could re-enable project settings is a Phase 3/6 decision. The docs do not say whether `plugins` loads independently of `settingSources`: manual check step 10 confirms the `flow` skills appear in the `init` message, that the project's `CLAUDE.md` is in effect, and that a project `SessionStart` hook does not run.
- Resolved (round 4): F20 (512-char cap only for brace patterns), F23 (boundary tests), S51 (expansions deduped, real cwd resolved once, walk down from cwd, 256-probe cap), `[` inside a brace group denied.
- Known limits of the CLAUDE.md injection: an edited `CLAUDE.md` reaches a resumed chat only after compaction or in a new session (the system prompt is recorded on a session's first request); a hardlinked `CLAUDE.md` pointing outside the project is not detected (`lstat` shows a regular file).
- Round 4 reviewer minors (not fixed unless noted below): F30 the probe budget counts repeated directory checks, so a legitimate fan-out glob such as `{p1..p10}/src/{a..e}/**/*.{ts,tsx}` can be denied as "too complex" (memoize `exists`/`realpath` per directory and count only misses); F31 a multi-byte UTF-8 character cut at the 32 KB cap leaves a stray U+FFFD before `[truncated]`, and a short `read` is treated as end of file (loop until the buffer is full or 0 bytes); F32 a clearly outside absolute path with more than 256 segments gets the misleading "too complex" hint; F33 the `projectContext` symlink test silently passes on unprivileged Windows (add a junction case).
- F10 (round 2) `src/main/chat/tools.ts`: every glob containing `{` or `}` is denied, including common ones like `**/*.{ts,tsx}`; the model sees a misleading reason. Either allow braces when the pattern has no `..` substring (literal prefix up to the first `{`), or give a clearer deny reason.
- F11 (round 2) `src/main/chat/tools.ts` `AGENT_INPUT_KEYS`: only `description`, `prompt`, `subagent_type`, `model` are allowed; a call with `name` or `resume` is denied. Consider adding the benign keys; keep `isolation`, `mode`, `team_name`, `cwd` denied.
- F12 (round 2, theoretical): on POSIX a backslash in a glob escapes the next character, so `\.\./x` is not seen as a `..` segment; deny patterns containing a backslash on non-win32.
- F13 (round 2, defense in depth): the literal prefix stops before a partial segment containing magic (`ln*/**`); only matters if the search tool follows symlinks, which it does not today (no `--follow`).
- Resolved (round 5): S60 (path arguments no longer walk up unboundedly: 4096-char and 64-segment lexical caps with 0 fs calls, one shared `ProbeCtx` per guard call, memoized probes, walk down from the real cwd), F30, F31, F32, F33; expansion cap raised from 64 to 128 to let a 100-combination monorepo glob pass.
- OPEN, security (round 5 audit, FAIL): S70 (major) `src/main/chat/tools.ts` (`probeComponent`/`walkDown`, lexical checks): on win32 a path segment ending in `.` makes `lstatSync` report ENOENT, so the guard treats it as missing and returns "inside", while ripgrep (Grep/Glob tools) normalizes the dot away and follows the link. Reproduced: `Grep {path: "jfirst."}` and `Read jfirst./s.txt` through a junction pointing outside the project are allowed and read outside files; also on intermediate segments (`src/a/jmid./s.txt`) and in glob prefixes and brace expansions. Fix: on win32 deny lexically (0 fs calls) any segment ending in `.` or a space other than `.` and `..`, for path arguments, every brace expansion and every literal prefix, next to the existing `..`/`~`/NUL checks.
- OPEN, minor: S61 `realpathSync` (JS implementation) follows every hop of a link chain with unbounded cost per probe: a 60-hop chain of in-project junctions plus a brace glob blocks the main process ~26 s per call (needs links already present in the repo). Fix: use `realpathSync.native` for `realCwd` and link resolution (verify identical junction, 8.3 and case behavior on win32, and derive `realCwd` from the same function), or resolve links one `readlinkSync` hop at a time and charge each hop to the probe budget.
- Round 5 reviewer minors: F40 the 256-probe budget can be hit within the documented 128 expansions (`{16 dirs}/{8 dirs}/src/**` costs 272), raise MAX_PROBES to about 512 or reword the message; F41 the 4096-char cap applies only to path arguments (brace-free patterns uncapped; segments after the first magic character are counted), apply the cap to the pattern string and count only literal-prefix segments; F42 a real path through a junction to another drive is denied before the real cwd is consulted (fail closed, usability only, not a regression); an absolute path in long form while the cwd is in 8.3 form (or the reverse) is wrongly denied; F43 test gaps: dangling links (inside and outside targets), relative link targets, a cwd that is itself a link, win32 case handling; `try { symlinkSync } catch { return }` swallows every error so a broken junction call turns assertions into no-ops (rethrow unless EPERM/EACCES/ENOSYS, use `ctx.skip()`); F44 two `performance.now()` < 500 ms assertions can flake under load (the call-count assertions already prove the bound) and one test title still says 64 expansions.
- Unverified: a symlink inside the project pointing to a UNC target would make `realResolve` touch SMB before the deny (could not be created on the test machine).
- Manual live checks still required (see `docs/notes/phase-2-manual-check.md`): `duration_ms` and `last_assistant_message`, no duplicate `tool-finished` on a denied tool, hooks inside subagents, a `Skill` cannot run shell commands before the guard, the `flow` plugin skills load and the project's `CLAUDE.md` is in effect with `settingSources: ['project']`, and the real end-to-end run against the SDK.
- The guard allows the search tools only because the installed Claude Code does not pass `--follow` to ripgrep; revisit if that changes.
- Timezone test relies on a runtime `TZ` change (passes on Windows; not checked on macOS or Linux).

### Findings by wave (history)

Wave 1 (reviewer and security audit both PASS; minor findings, not fixed):
- F1 `src/main/chat/activity.ts:236`: `agents()` marks `main` as `approximate: false` even without `mainTokens` (run errored or aborted before `result`); should be `true` unless `mainTokens` overrides.
- F2 `src/main/chat/activity.ts:59`: no mapping for `PostToolUseFailure`; a failing tool leaves a `tool-started` with no `tool-finished` (shows "running" forever). Map it to `tool-finished` (`denied: false`, `durationMs: null`) or have T5 close open tools at `run-finished`. Decide before wave 3.
- F3 `src/main/chat/activity.ts:19`: `truncate` can split a surrogate pair at the cut; drop a trailing high surrogate.
- F4 `src/main/chat/activity.ts:150`: assistant messages without `message.id` are ignored; confirm the SDK always sets it, else fall back to `uuid`.
- S1 `src/main/chat/activity.ts` (lines 39-53, 83-84, 207-212): only `summary` is capped; `tool`, `toolUseId`, `agentId`, `agent` and the model-written `subagent_type` pass through at any length (memory and IPC bloat). Cap identifiers at ~100 chars; validate `subagent_type` or fall back to `"subagent"`.
- T1 caveats: `@types/better-sqlite3` ^9.6.0 not checked against `better-sqlite3` v13's API (T3 confirms by typechecking); `npm run dev` with HMR not run against the new dependency; not verified on macOS or Linux.
- To confirm in T4 (security audit): the guard runs for subagent tool calls and is registered with `onFailure: "block"`; a `Skill` cannot run shell commands before the `PreToolUse` hook sees them; hook field names (`agent_id`, `agent_type`, `duration_ms`, `last_assistant_message`) match the installed SDK; the denied-tool event comes from `mapDeniedToolUse`.
- F2 resolved on the renderer side: T5 closes open tools at `run-finished` (criterion added). The `PostToolUseFailure` mapping in `activity.ts` is still open.

Wave 2 (reviewer and security audit both PASS; minor findings, not fixed):
- F1 `src/main/db/runStore.ts` (summary statements, ~line 170): the window has no upper bound (`day >= ?` only); a run with a future `startedAt` counts in every window. Add `AND day <= ?` with `localDay(now())` or accept.
- F2 `src/main/db/runStore.ts` (~line 108): when `usage.costUsd` is null but per-model costs exist, `runs.cost_usd` is NULL and counts as $0; optionally fall back to the sum of model costs (matters for runs that error after `modelUsage` was captured).
- F3 `src/main/db/db.test.ts:158-196`: window-boundary tests never cover the day just outside the window (`daysAgo(days)`), so an off-by-one in `days - 1` is not caught; no test covers `approximate` aggregating across mixed runs of the same agent.
- F4 `src/main/db/runStore.ts` (~line 85): `day` is fixed at record time in the timezone then in effect; no test under a non-UTC timezone. Acceptable behavior, test gap only.
- S (note) `RunStore.summary` does not validate `days` itself; NaN gives an empty summary. It relies on the IPC zod schema (T7).
- To confirm in T7: where the database file lives (`userData/data`), and that the database is closed at quit so the WAL is checkpointed.
Wave 3 (reviewer and security audit both PASS; minor findings, not fixed):
- S10 `src/main/chat/runner.ts:140`, `src/main/chat/tools.ts:30`: the guard checks the tool name only, and bare `allowedTools` rules pre-approve `Read`/`Grep`/`Glob` for every path. A prompt-injected file in a project could make the agent read `~/.ssh/*`, `~/.aws/credentials` or another project's `.env`; the content would appear in chat, in-memory history and the SDK transcript on disk. No network tool exists in Phase 2, so this is disclosure, not exfiltration, but it becomes an exfiltration path once `Bash`/`WebFetch`/push arrive. Fix: in `guardPreToolUse`, resolve `file_path`/`path` (default `cwd`) with `path.resolve` + `fs.realpathSync` and deny anything outside the run's `cwd` (pass `cwd` into `buildHooks`). Needs a decision from the user (see build report).
- Security (not a finding, unverified): set `settingSources` explicitly in the `query()` options so only the intended settings sources load; confirm in T9 that hooks fire for subagent tool calls and that a `Skill` cannot run shell commands before `PreToolUse` (skill `!`cmd`` with `allowed-tools: Bash`).
- F1 `src/renderer/src/hooks/useUsage.ts:34-58`: on project or scope change the previous summary stays rendered (and an error shows beside it) until the new response arrives; key the data by request (`projectId`, `days`, scope), dim or hide mismatches, show "Refreshing", add a project-switch test.
- F2 `src/main/chat/runner.ts:131-180`: the push queue is unbounded (document it); an already-aborted `args.signal` never aborts the run (latent, the service passes no signal).
- F3 `src/renderer/src/components/Activity/ActivityFeed.tsx:28`: a null cost renders "cost unknown (estimated)"; append "(estimated)" only for a non-null cost.
- F4 `src/renderer/src/hooks/useActivity.test.ts`: no test for a project switch while history is in flight (stale-history guard untested).
- F5 `src/renderer/src/hooks/useActivity.ts:61-66`: after a history load failure the error stays until the project changes while live rows keep appending; clear the error on the next live event.
- T4 caveats: `duration_ms` on `PostToolUse` and `last_assistant_message` on `SubagentStop` not confirmed by the docs (code degrades to null/empty; check live in T9); unsure whether a denied tool also fires `PostToolUseFailure` (possible duplicate `tool-finished`); a config error produces no activity run; a runner that throws before any result records nothing to the store; `Stop` is not registered (maps to no event).
Wave 4 (reviewer and security audit both PASS; minor findings, not fixed):
- F1 `src/main/ipc/register.ts:26`, `src/main/index.ts:78`: no test for `emitActivity` routing, for the dispose list including the new channels, or for the database close at `will-quit` (`register.ts` has no test file; predates T7). A short `register.test.ts` with mocked electron would cover it.
- F2 `src/renderer/src/components/Workspace/Workspace.tsx:51`: a finished run loaded from history bumps the usage refresh signal on mount (and on project switch with scope "all"), causing one extra, harmless fetch. Seed `seenRunId` from the first history load or bump only on live events.
- F3 `src/renderer/src/components/Workspace/Workspace.tsx:90`: `aria-controls` on the inactive tab points to a panel that is not rendered, and the tabpanel has no `tabIndex={0}`. Render one panel with a fixed id (or set `aria-controls` only on the selected tab) and add `tabIndex={0}`.
- F4 `src/renderer/src/App.test.tsx`: the refresh test does not assert that a repeated `run-finished` with the same run id leaves the usage call count unchanged ("once per run id").
- `tests/integration/main-flow.test.ts` (Phase 1) also times out under parallel load (about 3s alone, 5s limit) and the `afterEach` cleanup then fails with EPERM; same class as the `status.test.ts` timeout. Both pass alone.
Wave 5 (reviewer PASS; security audit skipped, no sensitive surface; minor findings, not fixed):
- F1 `tests/phase-2-flow.test.ts:105,173`: `expect` calls inside the fake runner generator are swallowed by `ChatService` and surface as an `error` event; the test would fail only at the final `done` assertion with a misleading message. Capture values in variables and assert in the test body.
- F2 `tests/phase-2-flow.test.ts`: no failure-path case (runner throws, `is_error` result, store failure) at integration level; covered by unit tests only.
- F3 `tests/phase-2-flow.test.ts:31`: `rmSync` without `maxRetries`; Windows file locks on the WAL file can make `afterEach` fail with EPERM (seen in `main-flow.test.ts`).
- F4 `docs/notes/phase-2-manual-check.md:5`: the built app is never launched; the note does not say to run `npm run build`.
- F5 `docs/notes/phase-2-manual-check.md:11-12`: checks (c) and (d) have no concrete prompt or throwaway skill, hard to repeat.
- Smoke: automated launch of the built Electron app is not covered (only `tests/preload-bundle.test.ts` checks the preload bundle); the launch is a manual check.
- Known, outside this plan: `src/main/git/status.test.ts` times out under parallel load (deferred by the user).
