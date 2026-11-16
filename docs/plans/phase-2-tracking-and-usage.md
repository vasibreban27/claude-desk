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

Resolved history (waves 1-5 findings, rounds 2-5, the close-out): `docs/notes/phase-2-followups-history.md`. Only open items are listed here.

- Manual live checks still required (`docs/notes/phase-2-manual-check.md`): `duration_ms` and `last_assistant_message`, no duplicate `tool-finished` on a denied tool, hooks inside subagents, a `Skill` cannot run shell commands before the guard, the `flow` plugin skills load and the project's `CLAUDE.md` is in effect with `settingSources: []`, and the real end-to-end run against the SDK.
- Guard assumptions to re-check on every SDK upgrade: how the Grep/Glob tools normalize `path` and the Glob base dir (trim, `/x/` drive mapping, glob characters). Last verified against CLI 2.1.323. Windows device names (`CON`, `CONIN$`) in a path are not handled (at most a blocked tool call).
- Known limits of the CLAUDE.md injection: an edited `CLAUDE.md` reaches a resumed chat only after compaction or in a new session; a hardlinked `CLAUDE.md` pointing outside the project is not detected.
- Unverified: a symlink inside the project pointing to a UNC target would make the real-path resolution touch SMB before the deny (could not be created on the test machine).
- The guard allows the search tools only because the installed Claude Code does not pass `--follow` to ripgrep; revisit if that changes.
- An 8.3 path under a long-form cwd is denied (fail closed, usability only).
- Timezone test relies on a runtime `TZ` change (passes on Windows; not checked on macOS or Linux).
- Not checked: automated launch of the built Electron app (manual check only); the SDK `permissionMode`/`canUseTool` spike; a per-project trust setting for project settings (Phase 3/6).
