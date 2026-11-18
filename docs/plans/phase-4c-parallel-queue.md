Format: flow-plan/1

# Phase 4c: Parallel workers (the queue with maxParallel)

## Goal

As the owner I want the tasks of a wave to run in parallel, at most N at once, so that a plan finishes in a fraction of the serial time while nothing reaches `main`.

Outcomes:
- A wave of independent tasks runs with at most `maxParallel` workers at once (default 2, maximum 4), each in its own worktree and SDK session; a plan with three independent tasks finishes measurably faster than the same plan with `maxParallel` 1 (numbers in `docs/notes/phase-4c-timing.md`).
- Merges into `run/<id>` never overlap, cancel stops every running worker and cancels the queued ones, and a failing task does not stop its siblings.
- The turn cap, the per-task time limit and the number of workers at once are project settings, and a plan task's `Model` is applied (the task wins over the project model).
- The 4b follow-ups that matter when tasks overlap are closed (the `active` flag race, out-of-order status responses, "Cancelling..." flipping back).

## Scope

In:
- Wave-by-wave pool with a cap, one per-run mutex around every git-mutating manager call, cancel-all, per-task failure isolation.
- Settings `maxParallel`, `maxTurns`, `taskTimeoutMinutes` (schema, Settings tab) and applying the plan's `Model`.
- Pipeline tab: running count, total cost, parallel tasks; the 4b follow-ups listed in the Goal.
- A spike first (concurrent git in one repo, concurrent checks over the shared `node_modules` junction, concurrent live SDK sessions), an integration test over real git, a live timing test and a manual check.

Out (do not build):
- Phase 5: reviewers, running checks before review, auto-fix rounds, merge into `main`, push.
- Scheduling across waves by the dependency graph (needs cross-wave `Owns` overlap validation), a cap across projects, serializing `run_check` (only if the spike says it is needed: then stop and re-plan), showing the model used per task in the UI (needs a migration), a run history list.

## Architecture

Approach: the orchestrator runs wave by wave. Inside a wave the plan format already guarantees disjoint `Owns` and no dependencies between tasks, so a pool starts tasks in order and keeps at most `maxParallel` running. A wave finishes (every task settled) before the next wave starts. Per task: [mutex] create the worktree, then run the SDK worker and its checks outside the mutex, then [mutex] resolve the end commit and merge into `run/<id>`. All `WorktreeManager` mutations (create, merge, remove) go through one per-run mutex, which also keeps the manager's per-operation state (`memo`, `setup`) from overlapping. Merges happen in completion order, so the integration history order is not deterministic (acceptable: `Owns` are disjoint). A failed task settles as today; its siblings keep running and its dependents in later waves are `blocked`. Cancel aborts the shared `AbortController` (every runner listens to it), queued tasks become `cancelled`. A database error aborts the pool: no new tasks start, running ones are aborted, unsettled tasks fail with `run failed: <reason>`.

Rejected: (B) scheduling across waves by the dependency graph (faster but cross-wave `Owns` overlap is not validated by the format); (C) one child process per task (more isolation, far more work, the SDK already runs sessions in-process).

Model precedence: `task.model` (haiku, sonnet, opus, validated by the parser) wins; else the project `model` unless it is `auto`; `auto` means the SDK default (no `model` option). Limits: `maxParallel` 1..4 (default 2), `maxTurns` 5..100 (default 40), `taskTimeoutMinutes` 1..120 (default 20); `effectiveLimits(settings)` in `src/shared/settings.ts` is the single place that applies the defaults.

### API contract (no new IPC channel; the existing settings payload grows)

```
settings:get / settings:set   ProjectSettings gains three optional integer fields (no version bump; absent means the default)
  maxParallel:        int 1..4      (default 2)
  maxTurns:           int 5..100    (default 40)
  taskTimeoutMinutes: int 1..120    (default 20)
  settings:set with a value outside the range -> { ok: false, error: "invalid" } (existing error)
pipeline:* channels and PipelineRunView / PipelineTaskView: unchanged
```

Internal: `effectiveLimits(settings) -> { maxParallel, maxTurns, timeCapMs }` (shared), `createMutex()` and `runPool(items, limit, fn)` in `src/main/pipeline/queue.ts`, `StartRunInput.runId?` (optional, the service passes it).

## Changes per layer

- **API / IPC:** none (settings payload fields only).
- **Service (main):** `queue.ts` (new), `orchestrator.ts` (pool, mutex, cancel-all), `service.ts` (active flag race, discard guard), `workerRunner.ts` (caps and Model from settings).
- **Database:** none (no migration; the task model is not stored).
- **UI:** Settings tab fields (`LimitsEditor.tsx`), Pipeline tab header, status hook fixes.
- **Docs:** `docs/notes/phase-4c-spike.md`, `docs/notes/phase-4c-timing.md`, `docs/notes/phase-4c-manual-check.md`.

## Risks

| Risk | Mitigation |
|---|---|
| Several SDK sessions at once hit rate limits or cost N times faster | Default 2, hard maximum 4, a visible running count and total cost; the spike measures 3 live sessions and sets the default; a negative result stops the plan for a re-plan |
| Concurrent git in one repo (`worktree add`, commits in sibling worktrees, gc) | Mutex for every manager mutation; workers commit in their own worktrees; the spike hammers both and records failures |
| Concurrent checks write into the one shared `node_modules` (caches) | The spike runs real vitest in parallel worktrees; if flaky, stop and re-plan (a `run_check` lock task) |
| Cancel leaves workers running | One shared signal, every runner closes its query; the integration test cancels mid-wave and asserts no task stays `running` |
| Two tasks edit the same unowned file | The second merge returns `conflict`, the task fails with `merge conflict`, the integration worktree is aborted clean (existing behaviour, tested in parallel) |
| A database error in one task while others run | Pool abort path with a test; final status still written with the existing retry |
| `run_check` runs worker-written code unsandboxed as the user (accepted risk from 4a); N tasks run N checks at once | Unchanged and shown next to the checks editor; the cap limits the load |
| Several projects each running N workers | Out of scope (no global cap); noted in Follow-ups if it matters |

## Test strategy

- Unit: `queue.ts` (mutex order, pool cap), orchestrator with a fake runner and fake manager (cap, waves, mutex overlap, cancel, failures, database error), service (active flag, discard guard), runner (caps, Model table, no shared state), settings schema, components and hooks with a mocked `window.api`.
- Integration: `tests/phase-4c-flow.test.ts` (real git, fake runner with held promises, real orchestrator and manager).
- Live (gated by `CLAUDE_DESK_LIVE=1`): `tests/live/phase-4c-live.test.ts` times the same 3-task plan at 1 and at 3 workers; manual check note for the launched app.
- Deliberately not tested: SDK internals, rate-limit behaviour beyond what the spike measured, parallel runs of several projects.

## Wave 1: spike and contract

### T1: Spike: concurrent git, shared node_modules, live concurrent sessions
- Status: [ ] todo
- Worker: node-developer
- Size: M
- Sensitive: no
- Contract: none
- Owns: `docs/notes/phase-4c-spike.md`
- Read first: `docs/notes/phase-4a-spike.md`, `docs/notes/phase-4a-timing.md`, `src/main/pipeline/worktrees.ts`, `src/main/pipeline/workerRunner.ts`, `tests/live/phase-4a-live.test.ts`
- Depends on: none
- Done when: `node -e "if(!/Decision index/.test(require('fs').readFileSync('docs/notes/phase-4c-spike.md','utf8')))process.exit(1)"`
- Acceptance criteria:
  - Given a temp repo and 4 concurrent `git worktree add -b` calls with the hardened argv (no mutex) repeated 20 rounds When run Then the note records the number of failures and their messages, and states whether the mutex is required (the plan builds it regardless).
  - Given 4 sibling worktrees each doing `add` and `commit` at the same moment, 20 rounds When run Then the note records any lock error, whether `gc --auto` ran, and a decision on adding `-c gc.auto=0` to the task-worktree argv.
  - Given 3 worktrees sharing the primary `node_modules` through a junction, each running real vitest on a tiny test at the same moment, 5 rounds When run Then the note records failures and which files the runs wrote under the shared `node_modules`. If any round fails because of the sharing, the note says STOP and the build stops for a re-plan (a `run_check` lock task) before Wave 2.
  - Given the live login and `CLAUDE_TOOLKIT_PATH` When 3 real haiku worker sessions run at the same time, each in its own worktree with a one-file task and `git_commit`, and the same 3 run serially Then the note records wall-clock, sum of task times, cost and any rate-limit or overload errors; if the concurrent run errors, the note sets the default `maxParallel` to 2 (or 1 if 2 also errors, and then says STOP for a re-plan).
  - Given the measurements When the note ends Then it has a `Decision index` table with one line per question and the recommended default and maximum for `maxParallel`.
  - Given the scripts used When the spike ends Then they live outside the repo (scratch folder) and nothing under `src/` changes.

### T2: Settings contract: maxParallel, maxTurns, taskTimeoutMinutes
- Status: [ ] todo
- Worker: node-developer
- Size: S
- Sensitive: yes
- Contract: settings:get, settings:set
- Owns: `src/shared/settings.ts`, `src/shared/settings.test.ts`
- Read first: `src/shared/settings.ts`, `src/shared/settings.test.ts`, `src/shared/ipc.ts`
- Depends on: none
- Done when: `npm run typecheck && npm test -- src/shared`
- Acceptance criteria:
  - Given the settings schema When `maxParallel` is 1 to 4, `maxTurns` 5 to 100 and `taskTimeoutMinutes` 1 to 120 integers Then it parses; 0, 5 (for parallel), 4.5, "2", NaN, Infinity and values over the bounds are rejected.
  - Given stored settings without the three fields When parsed with `parseSettingsOrDefaults` Then the case is `ok` and the fields hold the defaults 2, 40 and 20; `defaultSettings()` holds the same.
  - Given settings missing a field or holding it undefined When `effectiveLimits` runs Then it returns `{ maxParallel, maxTurns, timeCapMs }` with the defaults applied and `timeCapMs` = minutes times 60000.
  - Given the existing `checks` behaviour When the tests run Then all earlier settings tests still pass, and the constants `MAX_PARALLEL_LIMIT`, `DEFAULT_MAX_PARALLEL`, `MAX_TURNS_RANGE`, `TIME_LIMIT_MINUTES_RANGE` are exported through `@shared/ipc`.
  - Given a 1000 workers value in a settings payload When validated Then it is rejected (the bound is the guard against a fork bomb of SDK sessions).

## Wave 2: scheduler, runner, settings tab, pipeline tab

### T3: Scheduler: pool, per-run mutex, cancel-all, service race fixes
- Status: [ ] todo
- Worker: node-developer
- Size: M
- Sensitive: yes
- Contract: none
- Owns: `src/main/pipeline/orchestrator.ts`, `src/main/pipeline/orchestrator.test.ts`, `src/main/pipeline/queue.ts`, `src/main/pipeline/queue.test.ts`, `src/main/pipeline/service.ts`, `src/main/pipeline/service.test.ts`
- Read first: `src/main/pipeline/orchestrator.ts`, `src/main/pipeline/orchestrator.test.ts`, `src/main/pipeline/service.ts`, `src/main/pipeline/service.test.ts`, `src/main/pipeline/worktrees.ts`, `src/main/pipeline/workerRunner.ts`, `src/shared/settings.ts`, `docs/notes/phase-4c-spike.md`
- Depends on: T1, T2
- Done when: `npm test -- src/main/pipeline/queue.test.ts src/main/pipeline/orchestrator.test.ts src/main/pipeline/service.test.ts`
- Acceptance criteria:
  - Given `createMutex()` When several async functions are queued Then they run one at a time in call order and the next runs after a rejection; given `runPool(items, limit, fn)` Then at most `limit` run at once, they start in item order, and it resolves when all settled without rejecting.
  - Given a wave of 4 independent tasks and `maxParallel` 2 with a fake runner that holds each task When run Then never more than 2 runners are active, and the third starts as soon as one finishes.
  - Given `maxParallel` 1 When run Then tasks run in plan order exactly as before and all earlier orchestrator tests pass unchanged.
  - Given a plan with 2 waves When run Then every task of wave 1 has settled before any task of wave 2 starts.
  - Given parallel tasks and a fake manager that records enter and exit When run Then `createTaskWorktree` and `mergeTask` calls never overlap, while runners do overlap.
  - Given two tasks finishing in the order B then A When merged Then B merges first (completion order), each commit sha is recorded, and a `conflict` result fails only that task with `merge conflict` while the other siblings are unaffected.
  - Given one task in a wave fails When its siblings are still running Then they finish normally, the run is `failed`, and tasks of later waves that depend on the failed one are `blocked`.
  - Given 3 tasks running and 2 queued When cancel is called Then every runner receives the abort, the queued tasks become `cancelled` without starting, the run is `cancelled`, and no task stays `running`; given cancel after the last merge Then the run is still `done` (F3 rule kept).
  - Given the store fails for one task while others run When the error surfaces Then no new task starts, running ones are aborted, every unsettled task fails with `run failed: <reason>`, and the final run status is still written with the existing retry.
  - Given `service.start` When the run begins Then the service passes a pre-generated run id so `active` is true from the very first `pipeline:event`, and `active` is false by the time the event for the final run status triggers a re-fetch.
  - Given a run whose stored status is `running` but is not in the service's active map When `discard` is called Then it returns `active` and removes nothing.
  - Given `maxParallel` is read When a run starts Then it comes from `effectiveLimits(settings)` at start (a later settings change does not affect a running run).

### T4: Worker runner: caps from settings, apply the task Model
- Status: [ ] todo
- Worker: node-developer
- Size: S
- Sensitive: yes
- Contract: none
- Owns: `src/main/pipeline/workerRunner.ts`, `src/main/pipeline/workerRunner.test.ts`
- Read first: `src/main/pipeline/workerRunner.ts`, `src/main/pipeline/workerRunner.test.ts`, `src/shared/settings.ts`, `src/main/pipeline/planParser.ts`, `docs/notes/phase-4c-spike.md`
- Depends on: T1, T2
- Done when: `npm test -- src/main/pipeline/workerRunner.test.ts`
- Acceptance criteria:
  - Given settings with `maxTurns` 12 and `taskTimeoutMinutes` 3 and no `deps` override When a worker runs Then the SDK option `maxTurns` is 12 and the time cap fires after 180000 ms (fake timers); with the fields absent the defaults 40 and 20 minutes apply; a `deps` value still overrides (tests).
  - Given the Model table: task haiku with project sonnet; no task model with project sonnet; no task model with project `auto`; task opus with project `auto` When options are built Then the SDK `model` is haiku, sonnet, absent, and opus.
  - Given a task `model` that is not haiku, sonnet or opus (bypassing the parser) When options are built Then no `model` option is passed and nothing is thrown.
  - Given two runners started at the same moment, one cancelled and one finishing When both complete Then the cancelled one reports `cancelled`, the other `finished`, and no timer, controller or listener of one affects the other.
  - Given the existing runner behaviour When the tests run Then all earlier tests pass (turn limit, time limit, cancel, error mapping).

### T5: Settings tab: workers at once, turn cap, time limit
- Status: [ ] todo
- Worker: frontend-developer
- Size: S
- Sensitive: no
- Contract: settings:get, settings:set
- Owns: `src/renderer/src/components/Settings/SettingsPanel.tsx`, `src/renderer/src/components/Settings/LimitsEditor.tsx`, `src/renderer/src/components/Settings/settings.css`, `src/renderer/src/components/Settings/LimitsEditor.test.tsx`, `src/renderer/src/components/Settings/SettingsPanel.test.tsx`, `src/renderer/src/components/Settings/SettingsPanel.gaps.test.tsx`
- Read first: `src/renderer/src/components/Settings/SettingsPanel.tsx`, `src/renderer/src/components/Settings/ChecksEditor.tsx`, `src/renderer/src/components/Settings/settings.css`, `src/renderer/src/components/Settings/SettingsPanel.test.tsx`, `src/shared/settings.ts`
- Depends on: T2
- Done when: `npm test -- src/renderer/src/components/Settings`
- Acceptance criteria:
  - Given saved settings When the form loads Then "Workers at once", "Max turns per task" and "Time limit per task (minutes)" show the saved values, or 2, 40 and 20 when absent.
  - Given a value outside 1 to 4, 5 to 100 or 1 to 120, or a non-integer When Save is clicked Then nothing is sent and the field shows its own error.
  - Given valid values When Save is clicked Then `settingsSet` carries the three integers together with the existing fields (model, protected paths, flags, checks).
  - Given the hints When rendered Then the workers field says that cost and load grow with the number, that it applies to the next run, and the Model hint says it is the default for the chat and for pipeline tasks whose plan has no `Model` (a task's `Model` wins).
  - Given the existing settings tests When they run Then they pass with updated payload expectations, and editing another setting and saving keeps the checks and the new values.

### T6: Pipeline tab: parallel display and status hook fixes
- Status: [ ] todo
- Worker: frontend-developer
- Size: M
- Sensitive: no
- Contract: pipeline:status, pipeline:event, pipeline:cancel (unchanged)
- Owns: `src/renderer/src/components/Pipeline/`, `src/renderer/src/hooks/usePipeline.ts`, `src/renderer/src/hooks/usePipeline.test.ts`
- Read first: `src/renderer/src/components/Pipeline/PipelinePanel.tsx`, `src/renderer/src/components/Pipeline/pipeline.css`, `src/renderer/src/hooks/usePipeline.ts`, `src/renderer/src/hooks/usePipeline.test.ts`, `src/shared/ipc.ts`
- Depends on: none
- Done when: `npm test -- src/renderer/src/components/Pipeline src/renderer/src/hooks/usePipeline.test.ts`
- Acceptance criteria:
  - Given a run with tasks in several states When shown Then the header says how many tasks are running, queued, done and failed (for example "2 running, 1 queued, 1 done") and the total cost of the tasks that report one (with `~`), and several tasks show `running` at the same time.
  - Given status responses arriving out of order When the older one resolves last Then it is dropped and the newer state stays (request counter).
  - Given a burst of 5 `pipeline:event` signals within 150 ms When handled Then at most two fetches happen (leading and trailing) and the final state is always fetched (fake timers).
  - Given Cancel was clicked When a re-fetch returns the run still active Then the button keeps "Cancelling..." and it clears only when the run is no longer active or another run is shown.
  - Given a run whose status is `running` When shown Then Discard is not rendered even if `active` is false.
  - Given the existing tests When they run Then they pass (start, errors, cancel, discard, labels "Committed, not reviewed").

## Wave 3: integration test

### T7: Parallel flow over real git
- Status: [ ] todo
- Worker: node-developer
- Size: M
- Sensitive: no
- Contract: none
- Owns: `tests/phase-4c-flow.test.ts`
- Read first: `tests/phase-4b-1-flow.test.ts`, `tests/phase-4a-flow.test.ts`, `src/main/pipeline/orchestrator.ts`, `src/main/pipeline/queue.ts`, `src/main/pipeline/worktrees.ts`
- Depends on: T3, T4
- Done when: `npm test -- tests/phase-4c-flow.test.ts`
- Acceptance criteria:
  - Given a temp git repo and a plan with a wave of 3 tasks with disjoint `Owns` followed by a wave-2 task depending on two of them, a fake runner that holds each task for about 150 ms, and `maxParallel` 2 When the run finishes Then the observed maximum of concurrent runners is 2, the integration branch holds all four files with four merge commits, `main` and the primary checkout are untouched and the `node_modules` sentinel is intact.
  - Given `maxParallel` 1 and then 4 on the same plan When run Then the maximum concurrency is 1 and 3 respectively and the final content is identical.
  - Given a cancel in the middle of wave 1 When the run ends Then every worker was aborted, queued tasks are `cancelled`, the run is `cancelled`, no task is `running`, and `removeRun` succeeds afterwards.
  - Given one task whose runner fails When the run ends Then its siblings are `done`, its dependent is `blocked` and the run is `failed`.
  - Given two tasks that both edit the same unowned file When both finish Then the first merges, the second is `failed` with `merge conflict`, and the integration worktree is clean.
  - Given the real manager When 4 tasks start at once Then no git lock error appears in any task reason across the run.

## Wave 4: smoke

### T8: Live timing and launch check
- Status: [ ] todo
- Worker: node-developer
- Size: M
- Sensitive: no
- Contract: none
- Owns: `tests/live/phase-4c-live.test.ts`, `docs/notes/phase-4c-timing.md`, `docs/notes/phase-4c-manual-check.md`
- Read first: `tests/live/phase-4a-live.test.ts`, `docs/notes/phase-4a-timing.md`, `docs/notes/phase-4b-1-manual-check.md`, `docs/notes/phase-4c-spike.md`, `tests/phase-4c-flow.test.ts`
- Depends on: T5, T6, T7
- Done when: `npm run build && npm test -- tests/live/phase-4c-live.test.ts`
- Acceptance criteria:
  - Given no `CLAUDE_DESK_LIVE` When `npm test` runs Then the live test is skipped and the suite stays green; given `CLAUDE_DESK_LIVE=1`, `CLAUDE_TOOLKIT_PATH` and the login Then it runs the same 3-task wave with `maxParallel` 1 and with 3 through the real orchestrator, asserts every task is `done` with the expected file content, and prints a table of per-task and total wall-clock and cost.
  - Given the measured table When `docs/notes/phase-4c-timing.md` is read Then it records both runs, the speedup, and a one-line decision that confirms or changes the default `maxParallel`, with the reason.
  - Given `docs/notes/phase-4c-manual-check.md` When read Then it has numbered steps with expected results: launch with `npm run dev`, set "Workers at once" to 3 and the caps in Settings and save, start a plan with 3 independent tasks, see 3 tasks `running` at once with the header counts and a total cost, cancel mid-run and see every task stop within about 3 seconds with no task left `running`, run again with "Workers at once" 1 and see them run one by one, discard the finished run, and confirm `main` is untouched.
  - Given a plan task with `Model: haiku` while the project model is Opus When run live Then the note records the observed cost level as evidence that the task model was applied (a result line is left to fill in), and the decision about the default.
  - Given the note When read Then it has a "Results" section that says whether the steps were run, and says "built and verified by tests and review, not launched" if they were not.

## Follow-ups
