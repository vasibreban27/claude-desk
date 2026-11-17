Format: flow-plan/1

# Phase 4b-1: Run a plan from the app and see its status

## Goal

As the owner I want to pick a plan in the app, start it and watch its tasks run so that I no longer need a test script or the CLI to use the 4a pipeline.

Outcomes:
- A plan in `Format: flow-plan/1` and the older Phase 2-4a layout both parse; parse errors name the line.
- The Pipeline tab lists `docs/plans/*.md` with parse errors, starts a run and shows live per-task status with honest "committed, not reviewed" labels; a running run can be cancelled.
- The Settings tab edits the project's `checks`, so a run started from the app can run tests without seeding settings by script.
- The 4a follow-ups that affect the UI are closed: cancel racing the last merge (F3), paths left staged after a failed commit (F6), the `./<rel>` testPath with vitest, and the env allowlist on a real toolchain. `acceptEdits` is checked live in the smoke note.

## Scope

In:
- Parser accepts `flow-plan/1` (Size, Sensitive, Read first, Done when, Model, Tests, optional Autonomy header) and keeps the legacy layout.
- IPC contract, preload bridge, handlers, a `PipelineService` in main, a change event, the Pipeline tab, the checks editor, the F3 and F6 fixes, real-vitest verification of testPath and env, a flow test and a launch manual check.
- The service implements all five operations (plans, start, status, cancel, discard); the discard button is built in 4b-2.

Out (do not build):
- The discard button and its confirm dialog (4b-2).
- Applying a task's `Model` to the worker: it is parsed and shown only (4c).
- The parallel queue and `maxParallel` (4c); reviewers, running checks before review, merge into `main`, push (Phase 5); writing `[x]` back to the plan.
- A run history list: only the latest run per project is shown.

## Architecture

Approach: a `PipelineService` in main owns the orchestrator. A decorator around `PipelineStore` emits a light `pipeline:event {projectId, runId}` after each write; the renderer re-fetches `pipeline:status` on each event and on mount. The orchestrator is unchanged (apart from the F3 fix). Rejected: polling `pipeline:status` (laggy, wasteful); streaming per-task events from the orchestrator (changes the 4a engine).

Decisions:
- The renderer never sends a path: `pipeline:start` takes a file name, main resolves it inside `<project>/docs/plans`.
- The base branch is the project's current branch; a detached HEAD is refused. One active run per project (`busy`).
- Discard removes the run's worktrees and branches and then deletes its rows (the status columns have CHECK constraints, so no migration).
- Run-level reasons are not stored; the UI shows task reasons.
- `PlanTask` gains only optional fields so existing code and tests compile unchanged.

### Parser contract (`flow-plan/1`, mirrors the toolkit `plan-lint`)

- Detection: line 1 is exactly `Format: flow-plan/1`. Any other `Format:` value is an error ("unsupported plan format"). No `Format:` line means the legacy parser path, behaviour unchanged.
- Header lines before the first heading: `Format`, and optional `Autonomy: supervised | checkpoints | autonomous`; any other key is an error. Autonomy is exposed as `plan.autonomy` (string or null).
- Waves are `## Wave <n>` headings (level 2; text after the number is allowed, for example `## Wave 1: name`), numbered 1, 2, 3 in order. Tasks are `### T<n>: <title>` under a wave. Any other `##` heading ends the task area; `###` headings inside other sections (for example `### API contract`) are ignored. A missing `# ` title is allowed in this format (title is an empty string).
- Required task fields: Status, Worker, Size, Sensitive, Contract, Owns, Read first, Depends on, Done when, Acceptance criteria. Optional: Model, Tests. Unknown or duplicate fields are errors.
- Field rules: Size is `S` or `M` (`L` is an error, "split the task"); Sensitive is `yes` or `no`; Model is `haiku`, `sonnet` or `opus`; Tests is `writer`; Done when contains one command in backticks; Read first is not empty; Owns is a comma separated list with or without backticks and keeps today's path-shape, protected-default and same-wave-overlap checks; Depends on is `none` or task ids from earlier waves; acceptance criteria are indented `- ` bullets. Status is only checked for presence.
- `ParsedPlan` gains `format: 'flow-plan/1' | 'legacy'` and `autonomy`; `PlanTask` gains optional `size`, `sensitive`, `model`, `tests`, `readFirst`, `doneWhen`.

### API contract (IPC; every payload validated with zod in the main handler; handlers never throw)

```
pipeline:plans    req: { projectId: uuid }
  ok:  { ok: true, plans: PlanEntry[] }          err: { ok: false, error: "not-found" | "unreadable" }
  PlanEntry = { file: string, title: string | null, format: "flow-plan/1" | "legacy", ok: boolean,
                taskCount: number, waveCount: number, errorCount: number,
                errors: { line: number, message: string }[]   // at most 20 }

pipeline:start    req: { projectId: uuid, planFile: string matching ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.md$ }
  ok:  { ok: true, runId: string }
  err: { ok: false, error: "not-found" | "invalid-plan" | "busy" | "no-toolkit" | "detached-head"
                         | "storage-unavailable" | "start-failed", message?: string(<=300) }

pipeline:status   req: { projectId: uuid }
  ok:  { ok: true, run: PipelineRunView | null }  err: { ok: false, error: "not-found" | "storage-unavailable" }
  PipelineRunView  = { runId, planFile, status: "running" | "done" | "failed" | "cancelled", active: boolean,
                       baseBranch, integrationBranch, createdAt: ISO, finishedAt: ISO | null, tasks: PipelineTaskView[] }
  PipelineTaskView = { taskId, title, worker, wave, dependsOn: string[],
                       status: "queued" | "running" | "done" | "failed" | "blocked" | "cancelled",
                       reason: string | null, commit: string | null /* 7 chars */,
                       checks: "passed" | "failed" | "none" | null,
                       turns: number | null, costUsd: number | null, durationMs: number | null }

pipeline:cancel   req: { projectId: uuid, runId: string }   ok: { ok: true }   err: { ok: false, error: "not-found" | "not-active" }
pipeline:discard  req: { projectId: uuid, runId: string }   ok: { ok: true }   err: { ok: false, error: "not-found" | "active" | "cleanup-failed" }
pipeline:event    main -> renderer, payload { projectId: uuid, runId: string }   (a change signal; the renderer re-fetches status)
```

DeskApi additions: `pipelinePlans`, `pipelineStart`, `pipelineStatus`, `pipelineCancel`, `pipelineDiscard`, `onPipelineEvent(listener): () => void`.

## Changes per layer

- **API / IPC:** the contract above in `src/shared/ipc.ts`; preload mappings; handlers with validation; event broadcast to open windows.
- **Service (main):** `src/main/pipeline/service.ts` (new); `planParser.ts` (flow-plan/1); `orchestrator.ts` (F3); `workerTools.ts` (F6, testPath, env as verified); `index.ts` creates the pipeline store.
- **Database:** `pipelineStore.ts` gains `latestRunForProject` and `deleteRun`. No migration.
- **UI:** Pipeline tab (picker, parse errors, start, live status, labels, cancel); checks editor in the Settings form.
- **Docs:** `docs/notes/phase-4b-1-checks-verify.md`, `docs/notes/phase-4b-1-manual-check.md`.

## Risks

| Risk | Mitigation |
|---|---|
| `run_check` runs worker-written code unsandboxed as the user (accepted risk from the 4a security audit; the env allowlist reduces, not removes, it) | Accepted and shown next to the checks editor ("workers run these as you"). Later, not in 4b: the planner refuses `Owns` over files that define how checks run (`package.json`, `.npmrc`, `vitest.config.*`, `.gitattributes`); an OS sandbox or approval gate before `run_check`. |
| The renderer or a prompt-injected plan makes main read or run something outside `docs/plans` | The renderer sends a file name only; the schema regex, the service re-check and a `path.relative` containment check all apply; non-regular files and symlinks are refused. |
| A plan is huge or malformed | Size and task caps already in the parser; at most 20 errors per plan are returned; at most 100 plans listed. |
| Two runs on one project | `busy` error before the orchestrator is called. |
| `execFile` of `npm`/`npx` fails on Windows (`.cmd` shims, no shell) | T6 probes it and records the result; a fix is made only if it is small, otherwise it goes to Follow-ups and the editor hint says so. |
| Event flood (many store writes per task) | Events carry ids only; the renderer re-fetches and ignores events for other projects. |
| Cancel racing the final merge | F3 fix (T6): a run is `cancelled` only if a task ended `cancelled`. |

## Test strategy

- Unit: parser (both formats, real plan files), store, service (injected fakes), handlers (validation and error mapping), orchestrator and worker tools (fixes), hooks and components (Testing Library with a mocked `window.api`).
- Integration: `tests/phase-4b-checks.test.ts` runs the real `run_check` tool against real vitest in a temp dir; `tests/phase-4b-1-flow.test.ts` drives handlers, service and the real orchestrator over a temp git repo with a fake worker runner.
- Manual: `docs/notes/phase-4b-1-manual-check.md` (launch, run, cancel, and the live `acceptEdits` check).
- Deliberately not tested: SDK internals, visual styling, parallel runs, discard UI (4b-2).

## Wave 1: parser and contract

### T1: Plan parser accepts flow-plan/1
- Status: [x] verified
- Worker: node-developer
- Size: M
- Sensitive: yes
- Contract: none
- Owns: `src/main/pipeline/planParser.ts`, `src/main/pipeline/planParser.test.ts`
- Read first: `src/main/pipeline/planParser.ts`, `src/main/pipeline/planParser.test.ts`, `docs/plans/phase-3-project-settings.md`, `docs/plans/phase-4a-pipeline-engine.md`
- Depends on: none
- Done when: `npm test -- src/main/pipeline/planParser.test.ts`
- Acceptance criteria:
  - Given a plan whose line 1 is `Format: flow-plan/1` with `## Wave 1` headings and tasks that have Size, Sensitive, Read first, Done when and optional Model and Tests When parsed Then the result is ok, `format` is `flow-plan/1` and the new task fields are exposed.
  - Given an `Autonomy:` header with a valid value When parsed Then `plan.autonomy` holds it; an invalid value or an unknown header key is an error naming the line.
  - Given `Format: flow-plan/2` When parsed Then the error says the format is unsupported.
  - Given a flow-plan/1 task with Size L, Sensitive maybe, Model gpt, Tests reviewer, or a Done when without a backticked command When parsed Then each is an error naming the line and the field.
  - Given an Owns list without backticks (`a.ts, b/`) When parsed in flow-plan/1 Then it is accepted with the same path-shape, protected-default and same-wave-overlap rules as today.
  - Given the real files `docs/plans/phase-2-tracking-and-usage.md`, `docs/plans/phase-3-project-settings.md` and `docs/plans/phase-4a-pipeline-engine.md` (no Format line) When parsed Then they parse ok as before (5, 6 and 4 waves) with `format` `legacy`.
  - Given the real files `docs/plans/phase-4b-1-run-and-status.md` and `docs/plans/phase-4b-2-discard.md` When parsed Then they parse ok (8 tasks in 4 waves, and 1 task).
  - Given existing tests and callers When `npm run typecheck` runs Then it passes without edits outside Owns (the new `PlanTask` fields are optional).

### T2: IPC contract and preload bridge
- Status: [x] verified
- Worker: node-developer
- Size: S
- Sensitive: no
- Contract: pipeline:plans, pipeline:start, pipeline:status, pipeline:cancel, pipeline:discard, pipeline:event
- Owns: `src/shared/ipc.ts`, `src/shared/ipc.test.ts`, `src/shared/ipc.schemas.test.ts`, `src/preload/index.ts`, `src/preload/index.test.ts`, `src/renderer/src/App.test.tsx`
- Read first: `src/shared/ipc.ts`, `src/shared/ipc.test.ts`, `src/shared/ipc.schemas.test.ts`, `src/preload/index.ts`, `src/preload/index.test.ts`, `src/renderer/src/App.test.tsx`
- Depends on: none
- Done when: `npm run typecheck && npm test -- src/shared src/preload src/renderer/src/App.test.tsx`
- Acceptance criteria:
  - Given the API contract section of this plan When `src/shared/ipc.ts` is read Then it defines the channel names in `IPC`, zod request schemas, and exported result and view types exactly as listed, and `DeskApi` has the six new members.
  - Given `planFile` values `a.md`, `my-plan_2.md`, `../x.md`, `a/b.md`, `a\b.md`, `.md`, `C:x.md`, `a.md ` and a 101-character name When validated Then only the first two are accepted.
  - Given a `projectId` that is not a uuid or a missing `runId` When validated Then the request schema rejects it.
  - Given the preload bridge When its test runs Then each new method invokes exactly its channel with the request, `onPipelineEvent` subscribes to `pipeline:event` and its returned function unsubscribes, and `ipcRenderer` is still not exposed.
  - Given `App.test.tsx` builds a mock for every `DeskApi` key When the typecheck runs Then it passes (the new keys are added as `vi.fn()` entries).

## Wave 2: service, tab, engine fixes, checks editor

### T3: PipelineService and store queries
- Status: [x] verified
- Worker: node-developer
- Size: M
- Sensitive: yes
- Contract: pipeline:plans, pipeline:start, pipeline:status, pipeline:cancel, pipeline:discard, pipeline:event
- Owns: `src/main/pipeline/service.ts`, `src/main/pipeline/service.test.ts`, `src/main/db/pipelineStore.ts`, `src/main/db/pipelineStore.test.ts`
- Read first: `src/main/db/pipelineStore.ts`, `src/main/db/pipelineStore.test.ts`, `src/main/pipeline/orchestrator.ts`, `src/main/pipeline/planParser.ts`, `src/main/pipeline/worktrees.ts`, `src/main/projects/store.ts`, `src/main/git/status.ts`, `src/main/config.ts`, `src/shared/ipc.ts`
- Depends on: T1, T2
- Done when: `npm test -- src/main/pipeline/service.test.ts src/main/db/pipelineStore.test.ts`
- Acceptance criteria:
  - Given a project with `docs/plans` holding valid, invalid, non-markdown and subfolder files When `listPlans` runs Then it returns only the top-level regular `*.md` files, sorted by name, at most 100, each with format, counts and at most 20 errors; a missing `docs/plans` gives an empty list; an unknown project gives `not-found`.
  - Given a symlink or a non-regular entry named like a plan When listed or started Then it is skipped or refused.
  - Given a plan file name that fails the regex or resolves outside `docs/plans` When `start` runs Then it returns `not-found` or `invalid-plan` and the orchestrator is not called.
  - Given a detached HEAD, an invalid toolkit, a parse error or an already active run for the project When `start` runs Then it returns `detached-head`, `no-toolkit`, `invalid-plan` (with the first error line in `message`) or `busy` in that order of checks.
  - Given a valid plan When `start` runs Then it returns `{ ok: true, runId }` immediately while the run continues in the background, and the project is no longer active when the run finishes.
  - Given store writes (createRun, updateTask, setRunStatus, deleteRun) When they happen Then one `{projectId, runId}` event is emitted per write, an `emit` that throws never breaks the write, and the store's own return values are unchanged.
  - Given runs exist When `status` runs Then it returns the latest run for the project as a view (7-character commit, ISO times, `planFile` is the file name only, `active` from the service, tasks in wave order) or `run: null`; an unavailable store gives `storage-unavailable`.
  - Given a run of another project or an unknown run id When `cancel` or `discard` runs Then it returns `not-found`; a finished run gives `not-active` on cancel; an active run gives `active` on discard.
  - Given a finished run When `discard` runs Then the worktrees and branches are removed first and only then are the rows deleted; if removal fails the rows are kept and `cleanup-failed` is returned.
  - Given the store When `latestRunForProject` and `deleteRun` run Then they use parameterized statements, delete the run and its tasks in one transaction, and return `storage-unavailable` when the database is null.

### T4: Pipeline tab (pick, parse errors, start, live status, cancel)
- Status: [x] verified
- Worker: frontend-developer
- Size: M
- Sensitive: no
- Contract: pipeline:plans, pipeline:start, pipeline:status, pipeline:cancel, pipeline:event
- Owns: `src/renderer/src/components/Pipeline/`, `src/renderer/src/hooks/usePipeline.ts`, `src/renderer/src/hooks/usePipeline.test.ts`, `src/renderer/src/components/Workspace/Workspace.tsx`
- Read first: `src/shared/ipc.ts`, `src/renderer/src/components/Workspace/Workspace.tsx`, `src/renderer/src/hooks/useActivity.ts`, `src/renderer/src/hooks/useActivity.test.ts`, `src/renderer/src/components/Usage/UsagePanel.tsx`, `src/renderer/src/components/Usage/usage.css`, `src/renderer/src/styles/tokens.css`
- Depends on: T2
- Done when: `npm test -- src/renderer/src/components/Pipeline src/renderer/src/hooks/usePipeline.test.ts`
- Acceptance criteria:
  - Given the workspace When it renders Then the tabs are Activity, Pipeline, Usage, Settings in that order with the existing keyboard and stored-tab behaviour, and a stored `pipeline` value is accepted.
  - Given a project with plans When the Pipeline tab opens Then each plan shows file name, title or the file name, a `flow-plan/1` or `legacy` badge, task and wave counts; a plan with errors shows "N errors", lists up to 20 as "line N: message" and has a disabled Start button.
  - Given a valid plan When Start is clicked Then `pipelineStart` is called with the project id and file name only; each error value (`busy`, `no-toolkit`, `detached-head`, `invalid-plan`, `not-found`, `storage-unavailable`, `start-failed`) shows a distinct readable message in an alert.
  - Given a run When `pipeline:event` arrives for this project Then the hook re-fetches status; events for other projects are ignored; the subscription is removed on unmount and on project change; a run in progress is restored on mount from `pipelineStatus`.
  - Given a run When it is shown Then it lists tasks by wave with status, reason, 7-character commit, checks result, duration and cost, and a task that is `done` carries the label "Committed, not reviewed".
  - Given a run summary When it is shown Then it says the work is merged into `run/<id>` only and that nothing is merged into the base branch or pushed, and a `done` run is not described as reviewed or finished work.
  - Given an active run When Cancel run is clicked Then `pipelineCancel` is called, the button shows "Cancelling..." until the next status, and `not-active` or `not-found` results are shown without a crash; the button is hidden when the run is not active.
  - Given the tab When it renders Then tab semantics and the focus order stay accessible (buttons have names, errors use `role="alert"`, status uses `role="status"`), and `App.test.tsx` is not edited.

### T6: Engine fixes (F3, F6) and real-vitest verification of testPath and env
- Status: [x] verified
- Worker: node-developer
- Size: M
- Sensitive: yes
- Contract: none
- Owns: `src/main/pipeline/orchestrator.ts`, `src/main/pipeline/orchestrator.test.ts`, `src/main/pipeline/workerTools.ts`, `src/main/pipeline/workerTools.test.ts`, `tests/phase-4b-checks.test.ts`, `tests/phase-4a-flow.test.ts`, `docs/notes/phase-4b-1-checks-verify.md`
- Read first: `src/main/pipeline/orchestrator.ts`, `src/main/pipeline/orchestrator.test.ts`, `src/main/pipeline/workerTools.ts`, `src/main/pipeline/workerTools.test.ts`, `tests/phase-4a-flow.test.ts`, `docs/notes/phase-4a-manual-check.md`
- Depends on: none
- Done when: `npm test -- src/main/pipeline/orchestrator.test.ts src/main/pipeline/workerTools.test.ts tests/phase-4b-checks.test.ts tests/phase-4a-flow.test.ts`
- Acceptance criteria:
  - Given cancel is called after the last task has been merged (all tasks `done`) When the run finishes Then the run status is `done` and every task stays `done` (F3).
  - Given cancel is called while a task is running or queued When the run finishes Then at least one task is `cancelled` and the run is `cancelled`.
  - Given `tests/phase-4a-flow.test.ts` accepted `done` or `cancelled` for the F3 case When it runs Then it asserts the exact expected status.
  - Given `git add` succeeds and `git commit` fails in `git_commit` When the tool returns Then it has run a best-effort `reset` of exactly those paths (argv array, `--` before the paths, hardened prefix), the original commit error is what the tool reports even if the reset fails, and nothing from those paths stays staged in a real-git test (F6).
  - Given a temp project outside the repo with two vitest test files and a check `{ executable: process.execPath, args: [<vitest entry>, 'run', '--globals'], acceptsTestPath: true }` When the real `run_check` tool runs with `testPath` of one file Then the check passes, the output shows only that file ran, and a missing `./` prefix is not required; if vitest reports no test files for `./<rel>`, the tool passes the path without the leading `./` and a test covers it.
  - Given the same temp project When the check runs under the tool's reduced environment on this machine Then it passes; if a variable was missing, it is added to the allowlist and named in the note.
  - Given a check with executable `npm` or `npx` and `--version` When run through the tool Then the result (started or not on this platform) is recorded in `docs/notes/phase-4b-1-checks-verify.md`; a fix is made only if it is a few lines and tested, otherwise it is added to Follow-ups.
  - Given the verification When it finishes Then `docs/notes/phase-4b-1-checks-verify.md` states the testPath result, the env result and the npm result in one line each.
  - Given the changes When `npm run lint` and `npm run typecheck` run Then they pass.

### T7: Checks editor in the Settings tab
- Status: [x] verified
- Worker: frontend-developer
- Size: M
- Sensitive: no
- Contract: settings:get, settings:set (unchanged)
- Owns: `src/renderer/src/components/Settings/SettingsPanel.tsx`, `src/renderer/src/components/Settings/ChecksEditor.tsx`, `src/renderer/src/components/Settings/settings.css`, `src/renderer/src/components/Settings/ChecksEditor.test.tsx`, `src/renderer/src/components/Settings/SettingsPanel.test.tsx`, `src/renderer/src/components/Settings/SettingsPanel.gaps.test.tsx`
- Read first: `src/renderer/src/components/Settings/SettingsPanel.tsx`, `src/renderer/src/components/Settings/settings.css`, `src/renderer/src/hooks/useSettings.ts`, `src/shared/settings.ts`, `src/renderer/src/components/Settings/SettingsPanel.test.tsx`, `src/renderer/src/components/Settings/SettingsPanel.gaps.test.tsx`
- Depends on: none
- Done when: `npm test -- src/renderer/src/components/Settings`
- Acceptance criteria:
  - Given saved settings with checks When the form loads Then each check shows name, executable, one argument per line, timeout in seconds and a "takes a test path" checkbox; settings without `checks` show an empty list.
  - Given the editor When Add check is clicked Then a row is added up to 8 and the button is disabled at 8; Remove deletes a row.
  - Given invalid rows (name outside `a-z0-9-` up to 32, empty executable, timeout outside 1 to 600 seconds, more than 16 arguments, duplicate names) When Save is clicked Then nothing is sent and the row shows which field is wrong, using `checkSchema`.
  - Given valid rows When Save is clicked Then `settingsSet` is called with `checks` included (executable and args as typed, `timeoutMs` in milliseconds, `acceptsTestPath` only when ticked), and the other settings are sent as before.
  - Given the saved checks When the user edits another setting and saves Then the checks are preserved.
  - Given the editor When it renders Then a hint says workers run these by name, as the user, inside their worktree with a reduced environment, that there is no shell (one argument per line), and that this is not a sandbox.
  - Given the existing settings tests When they run Then they pass with updated payload expectations, and `useSettings.ts` is unchanged unless a test shows it must change.

## Wave 3: wiring

### T5: Handlers, registration and main wiring
- Status: [x] verified
- Worker: node-developer
- Size: M
- Sensitive: yes
- Contract: pipeline:plans, pipeline:start, pipeline:status, pipeline:cancel, pipeline:discard, pipeline:event
- Owns: `src/main/ipc/handlers.ts`, `src/main/ipc/handlers.test.ts`, `src/main/ipc/register.ts`, `src/main/ipc/register.test.ts`, `src/main/index.ts`, `src/main/index.test.ts`
- Read first: `src/main/ipc/handlers.ts`, `src/main/ipc/handlers.test.ts`, `src/main/ipc/register.ts`, `src/main/ipc/register.test.ts`, `src/main/index.ts`, `src/main/index.test.ts`, `src/main/pipeline/service.ts`, `src/shared/ipc.ts`
- Depends on: T2, T3
- Done when: `npm test -- src/main/ipc src/main/index.test.ts`
- Acceptance criteria:
  - Given any `pipeline:*` request with an invalid payload (not an object, bad uuid, bad `planFile`, extra or missing fields) When the handler runs Then it returns the contract error (`not-found` or `invalid-plan` as the contract defines) without calling the service, and it never throws.
  - Given a service that throws When a handler runs Then a generic contract error is returned and only the error name is logged.
  - Given valid payloads When the handlers run Then each calls the matching service method and returns its result unchanged.
  - Given `registerIpc` When called and then disposed Then all five `pipeline:*` channels are registered and removed, and `pipeline:event` is sent to every open, non-destroyed window with ids only.
  - Given the database failed to open When the app starts Then `pipeline:*` calls return `storage-unavailable` (or the contract's equivalent) and the app still starts.
  - Given `bootstrapStores` When it runs Then it also returns a pipeline store over the same database, and the orchestrator is created once with the real worker runner and the toolkit path from `readToolkitInfo`.
  - Given the existing handler and register tests When they run Then they pass.

## Wave 4: smoke

### T8: Flow test and launch manual check
- Status: [ ] todo
- Worker: node-developer
- Size: M
- Sensitive: no
- Contract: none
- Owns: `tests/phase-4b-1-flow.test.ts`, `docs/notes/phase-4b-1-manual-check.md`
- Read first: `tests/phase-4a-flow.test.ts`, `docs/notes/phase-4a-manual-check.md`, `tests/preload-bundle.test.ts`, `src/main/ipc/handlers.ts`, `src/main/pipeline/service.ts`
- Depends on: T4, T5, T6, T7
- Done when: `npm run build && npm test -- tests/phase-4b-1-flow.test.ts tests/preload-bundle.test.ts`
- Acceptance criteria:
  - Given a temp git repo with a flow-plan/1 plan in `docs/plans` and a fake worker runner When the flow test calls the real handlers (`pipeline:plans`, `pipeline:start`, `pipeline:status`) Then the plan is listed ok, the run starts, status reaches `done` with commits per task, events were emitted, `main` and the primary checkout are untouched.
  - Given a second start for the same project while the first runs When started Then it returns `busy`; cancel then yields a `cancelled` run with no task left `running`.
  - Given a plan with a parse error When listed and started Then the error line is returned and no run is created.
  - Given a run left `running` by a simulated crash (seeded in the real store before `registerIpc`) When `pipeline:status` is read without any start Then the run and its running task are `failed` with reason `interrupted` (regression for F1 of wave 3).
  - Given `npm run build` When it runs Then it succeeds and the preload bundle test passes.
  - Given `docs/notes/phase-4b-1-manual-check.md` When read Then it has numbered steps with expected results: launch with `npm run dev`, add this repo as a project, add a `node check.mjs` check in Settings and save, open the Pipeline tab, see a parse error for a broken plan, start a small plan, watch live status and the "Committed, not reviewed" labels, cancel a second run, and confirm `main` is untouched.
  - Given the note When read Then it has a live step for `permissionMode: 'acceptEdits'` (run the live test with `CLAUDE_DESK_LIVE=1` and `CLAUDE_TOOLKIT_PATH`, with and without the setting, never committing the change) with a result line to fill in, and the decision it implies (keep, or remove the setting in a follow-up).

## Follow-ups
- W1 reviewer F1 `planParser.ts` (~196-250): in flow-plan/1 a `### T<n>:` heading before the first `## Wave` is silently dropped (no error); report it as an error.
- W1 auditor S1 `planParser.ts:436-447`: `readFirst` (no path-shape or protected check) and `doneWhen` (any string) come from repo-controlled plan files; unused so far. Before any later task gives `readFirst` to a worker or runs `doneWhen`, validate paths with `badPathShape` and `isDefaultProtected`, and never run `doneWhen` directly.
- W1 T2: the 100-character `planFile` limit lives in the zod schema (`.max(100)`), not in `PLAN_FILE_PATTERN` alone; later code must use the schema.
- W1 auditor note: the handler that resolves `planFile` against `docs/plans` (symlinks, junctions) is not in wave 1; audit it when T3 lands.
- W2 auditor S1 `service.ts:103,70` (`resolvePlan`, `listEntries`): `docs/plans` itself is never checked for being a symlink or junction; a hostile repo could expose a `.md` outside the project to the parser (read-only, parse results only). Fix: reject if `lstat(docs/plans)` is a link, or require `realDir` inside `realpath(projectPath)`, and read via the resolved path.
- W2 reviewer F1 `service.ts:~215`: `activeRuns` holds `''` until the run id is known, so the first event reports `active=false`; at the end `setRunStatus` emits before the active entry is released, so a fast re-fetch can show `active=true` for a finished run. Set the run id early or emit once more from release. Matters for the Cancel button.
- W2 reviewer F2 `service.ts:~226`: start errors are classified by message prefix (`database error`, `settings could not`); make `startRun` return a typed error code.
- W2 reviewer F3 `usePipeline.ts:~70`: status responses are applied in arrival order; an older response can overwrite a newer one. Drop stale responses with a request counter.
- W2 reviewer F4 `ChecksEditor.tsx:~50`: `parseArgs` drops empty lines, so a saved empty-string argument is silently removed on save.
- W2 reviewer F5 `service.ts:~192`: a git status failure puts the raw git error text in the start message; log it and show a generic message.
- W2 T6: vitest accepted `./<rel>` and the env allowlist needed no change; `npm --version` starts through the tool on Windows (see `docs/notes/phase-4b-1-checks-verify.md`). The npm test only asserts a string result because the outcome is platform dependent.
- W2 out-of-scope (accepted): `src/renderer/src/App.test.tsx` (585c752, R1: tab order now Activity, Pipeline, Usage, Settings); T7 also updated Workspace tab expectations inside its Settings test files (ea612b7).
- W3 T5 reviewer F1 (major, fixed in round 1, commit 65664a7): crash recovery ran only at the first start; `registerIpc` now calls `markInterrupted()` at registration. The fix test mocks the handlers; T8 gets an end-to-end criterion with a real store.
- W3 reviewer F2 `register.ts:36-41`: the lazy orchestrator's `toolkit is not available` error maps to `start-failed`, the contract says `no-toolkit` (only after a race with the service's own check).
- W3 reviewer F3 `handlers.ts`: with no service, cancel returns `not-found` and discard `cleanup-failed` (valid contract values, misleading); add a comment or a distinct code later.
- W3 auditor S1 `handlers.ts:~207` / service: `pipeline:start` returns `git status: <git error>` text to the renderer (same as W2 F5); show a fixed message and log the detail.
- W3 auditor S2 `register.ts:~155`: dispose removes the handlers but does not cancel active runs or clear the lazy orchestrator (hygiene).
- W3 T5 deviation (accepted): the orchestrator is created lazily inside `registerIpc` (`buildPipeline`), not in `bootstrapStores`, so it can use the event-wrapped store; `bootstrapStores` returns `pipelineStore`.
