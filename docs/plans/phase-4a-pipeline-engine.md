# Plan: Phase 4a - Pipeline engine (headless, serial)

Branch: `phase-4a-pipeline-engine` (never `main`; cut from `phase-3-project-settings` while it is unmerged). Do not push and do not open a PR unless asked.

Phase 4 of `docs/vision.md` ("the pipeline") is cut into three plans because one plan would be about 15 tasks (the budget is 5-8):

- **4a (this plan):** the engine, headless. Parse a plan, run its tasks serially, each in its own worktree and branch, through an integration branch. No IPC, no UI.
- **4b (not planned yet):** IPC, Pipeline tab (pick a plan, parse errors, status), checks editor in the Settings tab, cancel and discard buttons, honest "committed, not reviewed" labels.
- **4c (not planned yet):** the queue with `maxParallel` from settings (parallel workers). Planned with the timing numbers from 4a.

Later sub-phases are intent only; nothing in them is built here.

## 1. Goal

As the owner of claude-desk I want a plan from `docs/plans/` to run task by task, each worker on its own branch and worktree, with the results collected on one throwaway integration branch, so that Phase 5 can review and merge one branch and `main` is never touched.

Outcomes:
- A plan parses strictly (or fails with a message naming the line) and a plan whose tasks in one wave have overlapping `Owns` is rejected.
- A serial run of a multi-wave plan (including a task with two dependencies) ends with every task committed on `task/*` branches and merged into `run/<id>`; `main` and the user's primary checkout are unchanged.
- A worker can only write inside its task's `Owns` in its own worktree, has no `Bash`, runs only the project's configured checks, and commits only explicit paths on its own branch.
- A worker that hits the turn or time cap, is cancelled, reports blocked or leaves no commit becomes `failed` (reason recorded), its partial work stays in the worktree, and its dependents are `blocked`.
- Per task duration, cost and turns are recorded and a timing note exists for the 4c plan.

Done when (this slice): a real plan runs serially end to end on a test repo with a live SDK, and the timing log is written.

## 2. Scope

In:
- Plan parser and validator (the plan format is a contract with the toolkit's `plan` skill).
- SQLite tables for pipeline runs and tasks (status, reason, branch, worktree, commit, timings, cost, checks result).
- `checks` project setting (additive, no version bump), stored in SQLite, edited only through the Settings tab (editor is 4b).
- Worktree manager: base commit recorded at run start, integration worktree for `run/<id>`, one task worktree and branch per task, hook-free merges into `run/<id>`, removal.
- Worker tools: in-process MCP tools `run_check`, `git_commit`, `report_blocked`, plus a guard policy confining `Write`/`Edit` to `Owns`.
- Serial orchestrator with turn cap, time cap, cancel, blocked dependents, interrupted-run recovery, timing log.
- Spike first (T1), end-to-end test and a live check (T8).

Out (do not build):
- IPC, preload, renderer, Pipeline tab, buttons (4b). Parallel queue and `maxParallel` setting (4c).
- Running checks before review, reviewers, auto-fix rounds, merging `run/<id>` into `main`, push, removing the integration worktree after merge (Phase 5). Writing `[x]` back to the plan file (Phase 5).
- A planner agent or a planner chat change: the existing chat with `allowPlanWrites` already writes plans.
- Repo-defined checks (never; checks are trusted configuration).
- Installing dependencies in worktrees beyond what the spike decides.

Explicit note for reviewers: the app creates merge commits on `run/<id>`. That is not "merging" in the policy sense: they never touch `main` or any user branch, run in a dedicated worktree with hooks disabled, and are the mechanism that lets later waves see earlier work. Phase 4 still does not merge into the project's branches.

## 3. Architecture

**Orchestrator is plain main-process code** (no LLM): it parses the plan, keeps task state in SQLite and starts one SDK session per task. Plan files are never edited by workers or by the app in this phase (each worktree has its own copy; status lives in SQLite).

**Branches and worktrees.** On run start: record the base branch and its commit hash (`git rev-parse`); the base moving later changes nothing. Create `run/<runId8>` at that hash in an integration worktree at `../.worktrees/<runId8>-integration` (outside the repo, per `CLAUDE.md`). Per task: create `task/<runId8>-<taskId>` from the current tip of `run/<runId8>` in `../.worktrees/<runId8>-<taskId>` (lowercase task id). The run id prefix avoids collisions between runs; this deviates from the literal `task/<id>` in `CLAUDE.md`, and the deviation is intentional. After a task commits, the app merges its branch into `run/<runId8>` in the integration worktree (`--no-ff`, hooks disabled, app identity). A merge conflict fails that task and blocks its dependents; with disjoint `Owns` it is a plan bug. The user's primary checkout is never used for any of this.

**Plan format contract** (owned by the toolkit `plan` skill; this app parses it, so a change there must be mirrored here; the parser fails loudly, naming the line):
- Waves are `### Wave <n>` headings (n ascending from 1) under the plan's tasks section; tasks are `### T<n>: <title>` blocks under a wave.
- Each task has the fields `Status`, `Worker`, `Contract`, `Owns`, `Depends on`, `Acceptance criteria` (bullets). `Owns` lists paths in backticks, comma separated; a path ending in `/` is a directory prefix. `Depends on` is `none` or task ids.
- Rejected: unknown or missing field, duplicate id, unknown dependency, dependency in the same or a later wave, `Worker` not one of the toolkit workers, empty `Owns`, an `Owns` path that is absolute, contains `..` or a drive colon or matches the protected-path defaults, and **overlapping `Owns` between two tasks in the same wave** (a directory prefix overlaps every file under it).
- Output: `{ title, waves: [{ n, tasks: [{ id, title, worker, owns[], dependsOn[], acceptance[], contract }] }] }`.

**Worker policy** (stricter than Phase 3's guard, built on its path machinery in `src/main/chat/tools.ts`):
- Allowed built-ins: `Read`, `Grep`, `Glob` (protected paths still apply), `Write`/`Edit` only when the real target path is inside the worktree, not a link, and covered by the task's `Owns`. Everything else is denied: `Bash`, `PowerShell`, `Agent`/`Task`, `Skill`, other MCP tools. If a worker needs a file outside `Owns` it calls `report_blocked`.
- MCP server `work` (in-process, `createSdkMcpServer`) with: `run_check { name, testPath? }`, `git_commit { paths[], message }`, `report_blocked { reason }`. The existing read-only git tools (`git_status`, `git_log`, `git_diff`) are also available.
- `run_check` runs a command from the project's `checks` setting by `name` (the model picks a name, never a command): `execFile` with `{ executable, args }`, `cwd` the worktree, the command's own timeout, output capped. Optional `testPath` is validated to lie inside the worktree and is appended as one argument only for a check that declares it takes one. Empty `checks` means the tool replies "no checks configured". The tool records the last result per task (`passed`, `failed`, `none`).
- `git_commit` commits explicit paths (each inside `Owns`, each with a change) on the worktree's expected `task/...` branch only (it first verifies HEAD), with hooks disabled, a fixed app identity and the task id appended to the message. No push, merge or checkout tool exists.
- Caps: `maxTurns` and a wall-clock timeout (constants in code for 4a: 40 turns, 20 minutes; they become settings with the 4b/4c UI). Hitting a cap fails the task with `limit reached`.
- "Done" means: the worker committed and the app merged the task branch into `run/<id>`. The recorded `checks` result says whether its targeted checks passed. It does not mean reviewed.

**Hardening reused from Phase 3** (`docs/notes/phase-3-spike.md` section 4): every git call by the app uses the hostile-config argv prefix and env there (`--no-pager --no-lazy-fetch`, `-c core.fsmonitor=false ... -c core.hooksPath=`, filter overrides, `GIT_TERMINAL_PROMPT=0`, ...). `gitTools.ts` does not export it, so T5 builds the same prefix in its own module; deduplicating is a follow-up.

**Rejected:** an orchestrator LLM agent (tokens, prompt-dependent); a narrow `Bash` allowlist (not a real boundary; revisit only if the spike shows workers cannot function without it); branching each task from `main` (later waves would not see earlier work); branching from a single dependency's branch (breaks with two dependencies); merging in the user's primary checkout (may have uncommitted work); status written into the plan file (a conflict magnet across worktrees); running only wave 1.

## 4. Changes per layer

- **API / IPC:** none (4b). Internal module contracts are in section 3.
- **Service (main):** new `src/main/pipeline/` (`planParser.ts`, `worktrees.ts`, `workerTools.ts`, `workerGuard.ts`, `orchestrator.ts`, `workerRunner.ts`, `prompts.ts`); `src/shared/settings.ts` gains optional `checks`.
- **Database:** migration 3 creates `pipeline_runs` and `pipeline_tasks`; `PipelineStore` (parameterized statements, one transaction per write); `SettingsStore.set` preserves stored `checks` when an incoming object has none (the 4a Settings tab does not know the field yet).
- **UI:** none (4b).
- **Dependencies:** none expected; the spike may decide otherwise for worktree dependencies (then a separate task is added).
- **Docs:** `docs/plans/phase-3-project-settings.md` out-of-scope note updated (T4).

## 5. Risks

| Risk | Mitigation |
|---|---|
| A worker needs `Bash` and structured tools are not enough | T1 spike runs a representative worker on the structured tools; only then consider a narrow allowlist, in a new plan. |
| New worktrees have no `node_modules` (npm ci is slow and runs install scripts; a junction reopens link concerns) | T1 decides one option with its audit notes; if it needs code, T5/T6 pick it up from the note; no silent default. |
| On Windows `execFile` refuses `npm.cmd` without a shell | T1 picks one option deliberately (run `node` on npm's JS entry, or `cmd.exe /d /s /c` with fixed arguments the model never supplies) and records why against the "no shell strings" rule; `run_check` implements exactly that. |
| Overlapping `Owns` would produce merge conflicts | Parser rejects overlap per wave; a conflict at merge time fails the task, blocks dependents and is reported as a plan bug. |
| Repo config or hooks execute code during app git calls (fsmonitor, filters, hooks, lazy fetch) | Hardened argv prefix from Phase 3, hooks disabled for commits and merges, argv asserted in tests. |
| Checks run repo code (`npm test`) in the worktree | Accepted: they are the user's own configured commands, not model input; model supplies a check name and an in-worktree test path only. |
| A prompt-injected plan makes a worker write or run something harmful | Writes confined to `Owns` in the worktree, no shell, no push, protected paths enforced, nothing merges to `main`. The plan itself is user-reviewed before running (4b shows it). |
| Runaway worker (the 2-hour runs) | Turn cap, time cap, cancel; the task fails with the reason and partial work is kept. |
| App crash leaves tasks `running` | On start `PipelineStore` marks `running` rows `failed: interrupted`; worktrees are kept. |
| Orphaned worktrees pile up | The manager has `removeTask`/`removeRun` (used by the 4b discard button); 4a only exercises them in tests. |
| SDK honours `maxTurns`/agent selection differently than assumed | T1 measures; T7 follows the note. |
| Plan format drifts between toolkit and app | Parser errors name the line; the contract is stated above and in the parser's header comment. |

## 6. Test strategy

- **Unit (Vitest, next to source):** parser (valid plan, every rejection, overlap including directory prefixes, real `docs/plans/phase-3-project-settings.md` as a fixture that must parse), `PipelineStore` on in-memory SQLite, `SettingsStore` preserving `checks`, worktree manager against temp repos (base hash fixed when the base moves, conflict, removal), worker guard (inside/outside `Owns`, links, protected paths, denied tools), worker tools (argv asserted, no shell, path validation, branch check, empty checks), orchestrator with a fake worker runner (order, blocked dependents, caps, cancel, interrupted recovery).
- **Integration:** `tests/phase-4a-flow.test.ts`: temp git repo, a plan with a dependency chain and a task with two dependencies, a fake worker runner that edits and commits through the real tools; asserts the integration branch content, `main` untouched, primary checkout untouched.
- **Live (skipped unless `CLAUDE_DESK_LIVE=1`):** `tests/live/phase-4a-live.test.ts` runs a tiny real plan with the SDK; steps and expected results in `docs/notes/phase-4a-manual-check.md`; timings in `docs/notes/phase-4a-timing.md`.
- **Smoke:** there is no UI or IPC wiring in 4a, so there is no launch smoke task; the 4b plan ends with one.
- **Deliberately not tested:** SDK internals, reviewers, merge into `main`, parallel runs, anything in 4b/4c.

## 7. Tasks

Test files sit next to their source and do not count toward the "at most 3 files per task" budget.

### Wave 1

### T1: Spike - SDK, worktree and npm behaviour the design depends on
- Status: [x] verified
- Worker: node-developer
- Contract: none
- Owns: `docs/notes/phase-4a-spike.md` (scratch scripts stay outside the repo)
- Depends on: none
- Acceptance criteria:
  - Given a live `query()` with the toolkit plugin loaded When a session is started as the plugin agent `flow:node-developer` Then the note states whether the SDK can run a session as a named plugin agent (option name or prompt mechanism), what the init message shows, and a decision; the fallback is a worker prompt built by the app, never a redefinition of the agent.
  - Given a session with `maxTurns` set small and another aborted by `AbortController` When they stop Then the note records the result `subtype` and how partial work and the session id look, and how the time cap is implemented.
  - Given two `query()` sessions with different `cwd` started at once When both write a file Then the note records whether they run concurrently without interference (input for 4c; one run only).
  - Given the Phase 3 hardened git prefix When `git worktree add -b`, `git merge --no-ff` and `git commit` run in a temp repo with a hostile `.git/config` (`core.hooksPath`, `core.fsmonitor`, a filter driver) and a `post-checkout` and `pre-commit` hook that write marker files Then no marker appears; the note lists the final argv for worktree add, merge, abort, commit and removal, and states whether `claude --worktree` exists and why the app uses `git worktree` anyway.
  - Given the project is on Windows When `execFile('npm', ...)` and `execFile('npm.cmd', ...)` are tried Then the note records the failure, compares (a) `node` on npm's JS entry and (b) `cmd.exe /d /s /c` with fixed arguments, and decides one with the reason against the "never shell strings" rule.
  - Given a fresh worktree with no `node_modules` When a check needs dependencies Then the note compares `npm ci --ignore-scripts`, a junction/symlink to the primary checkout's `node_modules`, and no install, with time, risks and a decision.
  - Given a live worker with `Write`, `Edit` and the MCP tools only (no `Bash`) When it does a tiny edit-and-test task Then the note records the exact `tool_input` keys for `Edit` and `Write`, whether it can finish, and whether a narrow `Bash` allowlist is needed (expected: no).
  - Given the note When read Then every question has a one-line decision that later tasks can cite.

### T2: Plan parser and validator
- Status: [x] verified
- Worker: node-developer
- Contract: none (plan format contract, section 3)
- Owns: `src/main/pipeline/planParser.ts`, `src/main/pipeline/planParser.test.ts`
- Depends on: none
- Acceptance criteria:
  - Given `docs/plans/phase-3-project-settings.md` as a fixture When parsed Then it returns 6 waves and 11 tasks with `Owns` as a path list and dependencies by id.
  - Given a plan with a missing field, a duplicate id, an unknown dependency, a dependency in the same or a later wave, an unknown worker, an empty `Owns` or an `Owns` path that is absolute, has `..`, a drive colon or matches the default protected list When parsed Then each returns an error naming the line and the rule, and nothing throws.
  - Given two tasks in the same wave When their `Owns` overlap (the same file, or one is a directory prefix of the other) Then the plan is rejected naming both task ids and the path; disjoint tasks in different waves may share a file.
  - Given the exported `ownsCovers(owns, relativePath)` When called Then a directory prefix covers files under it, an exact path covers only itself, comparison is case-insensitive on win32 only, and paths with `..` or absolute paths are never covered.
  - Given a plan larger than 512 KiB or more than 200 tasks When parsed Then it is rejected before parsing.

### T3: Migration 3 and PipelineStore
- Status: [x] verified
- Worker: database-engineer
- Contract: none
- Owns: `src/main/db/migrations.ts`, `src/main/db/migrations.test.ts`, `src/main/db/pipelineStore.ts`, `src/main/db/pipelineStore.test.ts`, `src/main/db/index.ts`
- Depends on: none
- Acceptance criteria:
  - Given a database at version 2 When `migrate` runs Then `pipeline_runs` (id, project_id, plan_path, plan_sha256, base_branch, base_commit, integration_branch, integration_path, status, created_at, finished_at) and `pipeline_tasks` (run_id, task_id, title, worker, wave, depends_on JSON, status, reason, branch, worktree_path, commit_sha, checks_result, turns, cost_usd, started_at, finished_at, duration_ms) exist, `user_version` is 3, `runs` and `project_settings` data is untouched, and a second run applies nothing.
  - Given `PipelineStore` When a run and its tasks are created Then statuses are limited by CHECK constraints to `queued`, `running`, `done`, `failed`, `blocked`, `cancelled` for tasks and `running`, `done`, `failed`, `cancelled` for runs, with `checks_result` limited to `passed`, `failed`, `none`.
  - Given a status change or timing update When written Then it is one parameterized transaction; an invalid status or unknown run is rejected without touching rows; a SQLite error returns an error result instead of throwing.
  - Given tasks left `running` When `markInterrupted()` runs Then they become `failed` with reason `interrupted` and their run `failed`, other rows unchanged.
  - Given a store created without a database When called Then every method returns the unavailable result and nothing throws.

### T4: `checks` setting, store preservation, Phase 3 note
- Status: [x] verified
- Worker: node-developer
- Contract: none
- Owns: `src/shared/settings.ts`, `src/shared/settings.test.ts`, `src/main/db/settingsStore.ts`, `src/main/db/settingsStore.test.ts`, `docs/plans/phase-3-project-settings.md`
- Depends on: none
- Acceptance criteria:
  - Given the schema When `checks` is absent Then it parses (version stays 1, default `[]`); each check is `{ name, executable, args[], timeoutMs, acceptsTestPath? }` with `name` matching `^[a-z0-9-]{1,32}$` and unique, `executable` 1..260 chars without NUL, at most 16 `args` of 1..500 chars without NUL, `timeoutMs` 1000..600000, at most 8 checks; a violation of any of these fails.
  - Given `defaultSettings()` When read Then `checks` is `[]`; stored v1 rows without `checks` still parse as valid.
  - Given `SettingsStore.set` with an object that has no `checks` When a row with checks exists Then the stored checks are preserved; with `checks: []` they are cleared; with a list they are replaced.
  - Given `docs/plans/phase-3-project-settings.md` When read Then its out-of-scope line about the checks command says an optional `checks` field was added in Phase 4a without a version bump, and the contract's `ProjectSettings` block shows it.
  - Given no repo file path When settings are read Then no code path reads `checks` from the project folder (asserted by a test that a `package.json` with scripts has no effect).

### Wave 2

### T5: Worktree manager with integration branch
- Status: [x] verified
- Worker: node-developer
- Contract: none
- Owns: `src/main/pipeline/worktrees.ts`, `src/main/pipeline/worktrees.test.ts`
- Depends on: T1
- Acceptance criteria:
  - Given a project repo and a base branch When `startRun` runs Then it returns the base commit hash recorded at that moment, creates `run/<runId8>` at that hash in `../.worktrees/<runId8>-integration`, and later commits to the base branch do not change the run's base or branch.
  - Given a run When `createTaskWorktree(taskId)` runs Then `task/<runId8>-<taskId>` is created from the current tip of `run/<runId8>` in `../.worktrees/<runId8>-<taskId>`, an existing branch or path fails with a clear error, and the user's primary checkout (even with uncommitted changes) is untouched.
  - Given two task branches that touch disjoint files When `mergeTask` merges them in order Then `run/<runId8>` contains both, each with a `--no-ff` merge commit made with hooks disabled and the app identity; given a conflict Then the merge is aborted, the integration worktree is clean and the result is `conflict`.
  - Given a temp repo with hostile config and hooks (T1's fixtures) When any manager operation runs Then no marker is written; tests assert the exact argv and env from `docs/notes/phase-4a-spike.md`, with `execFile` argument arrays, `cwd`, a timeout and an output cap, and no shell.
  - Given a base branch that does not exist, a project that is not a git repo, or git older than the required version When `startRun` runs Then it returns a short error and creates nothing; `removeTask` and `removeRun` delete the worktree and branch and are safe to repeat.
  - Given a worktree location When it would be inside the project folder, or the name contains a path separator or `..` Then it is rejected.
  - (Added after T1, per owner) Given a task worktree with a `node_modules` junction to the primary checkout (T1 decision) When `removeTask`/`removeRun` run Then the junction is unlinked first (never recursively deleted), a sentinel file in the junction target survives, and the manager refuses to remove a worktree whose junction could not be unlinked. Use `realpathSync.native` for worktree paths (8.3 temp paths break `Edit`).
  - (Added after T1, per owner) Given the primary checkout has no `node_modules` When a task worktree is created Then it returns a clear error and creates no dangling junction.

### T6: Worker tools and worker guard
- Status: [x] verified
- Worker: node-developer
- Contract: none (tool contracts, section 3)
- Owns: `src/main/pipeline/workerTools.ts`, `src/main/pipeline/workerTools.test.ts`, `src/main/pipeline/workerGuard.ts`, `src/main/pipeline/workerGuard.test.ts`
- Depends on: T1, T2, T4
- Acceptance criteria:
  - Given `guardWorkerToolUse(input, { worktree, owns, protectedPatterns })` When `Write` or `Edit` targets a file covered by `Owns` inside the worktree Then it is allowed; a file outside `Owns`, outside the worktree, a protected path, a link or junction (skipped with `ctx.skip()` on `EPERM`/`EACCES`/`ENOSYS`), a hardlink or `.git/**` is denied.
  - Given `Bash`, `PowerShell`, `Agent`, `Task`, `Skill`, an unknown MCP tool or malformed input When the guard runs Then each is denied and the guard never throws; `Read`, `Grep`, `Glob` follow the Phase 3 rules and the `work` and `git` MCP tools are allowed.
  - Given `run_check { name }` When `name` is in the project's checks Then `execFile` is called with that check's `executable` and `args` per T1's Windows decision, `cwd` the worktree, its timeout and an output cap, no shell string built from model input; an unknown name, a `testPath` outside the worktree or on a check that does not accept it is rejected before `execFile`; empty `checks` replies "no checks configured".
  - Given `run_check` outcomes When a check passes, fails (non-zero), times out or cannot start Then the reply says which in a short text, never throws, and the last result per task is `passed`, `failed` or `none`.
  - Given `git_commit { paths, message }` When every path is covered by `Owns` and has a change, HEAD is the expected `task/...` branch Then it commits only those paths with hooks disabled, the app identity and the task id appended; a path outside `Owns`, an unchanged path, a `..` or absolute path, HEAD on another branch or an empty or oversized message is rejected before any git call.
  - Given `report_blocked { reason }` When called Then the reason (capped at 500 chars) is recorded and returned to the orchestrator callback; no tool for push, merge, checkout or branch changes exists (asserted on the tool list).
  - (Added after T1, per owner) Given `run_check` on Windows When it runs `npm`/`npx` Then it resolves the system `node` and npm's `npm-cli.js` (never `process.execPath` under Electron, which is the Electron binary, and never `cmd.exe`), with a test for the resolution, and returns a clear "cannot run npm" error when either cannot be found.
  - (Added after T1, per owner) The worker guard stays the boundary; the SDK `tools` list is only a second layer.

### Wave 3

### T7: Serial orchestrator and worker runner
- Status: [x] verified
- Worker: node-developer
- Contract: none
- Owns: `src/main/pipeline/orchestrator.ts`, `src/main/pipeline/orchestrator.test.ts`, `src/main/pipeline/workerRunner.ts`, `src/main/pipeline/workerRunner.test.ts`, `src/main/pipeline/prompts.ts`
- Depends on: T2, T3, T4, T5, T6
- Acceptance criteria:
  - Given a parsed plan and a fake worker runner When a run starts Then a `pipeline_runs` row is created with the base commit, tasks run one at a time in wave order, each only after its dependencies are `done`, and statuses and timings (duration, turns, cost, checks result) are written for every task.
  - Given a task whose worker commits When it finishes Then the task branch is merged into `run/<id>` and the task becomes `done`; given no commit, a `report_blocked` call, a merge conflict, a failed worker or a cap Then it becomes `failed` with the reason (`no commit`, `blocked: <reason>`, `merge conflict`, `worker error`, `limit reached`), its worktree is kept and every task that depends on it (transitively) becomes `blocked` without starting.
  - Given the turn cap (40) or the time cap (20 min, with fake timers) When reached Then the session is aborted and the task fails with `limit reached`; given `cancel(runId)` Then the running session is aborted, the task and run become `cancelled`, queued tasks become `cancelled` and nothing new starts.
  - Given `workerRunner` When it builds SDK options Then `cwd` is the task worktree, `plugins` loads the toolkit, `maxTurns` is set, `model` follows the project's model setting, the guard hooks come from `workerGuard.ts`, the `work` MCP server is the only added server, `allowedTools` lists exactly the permitted tools, and the worker is selected as T1 decided; the prompt built in `prompts.ts` contains the task title, acceptance criteria, `Owns`, the contract and the instruction to call `report_blocked` instead of editing outside `Owns`.
  - Given the app restarts after a crash When the orchestrator starts Then `markInterrupted()` is called and nothing resumes automatically.
  - Given settings or a plan that fail to load, a database that is unavailable, or a thrown error inside a task When the run executes Then the run fails with a short reason and never throws out of the orchestrator.

### Wave 4

### T8: End to end - integration test, live check, timing log
- Status: [ ] todo
- Worker: node-developer
- Contract: none
- Owns: `tests/phase-4a-flow.test.ts`, `tests/live/phase-4a-live.test.ts`, `docs/notes/phase-4a-manual-check.md`, `docs/notes/phase-4a-timing.md`
- Depends on: T7
- Acceptance criteria:
  - Given a temp git repo, in-memory database and a plan with wave 1 (two tasks), wave 2 (one task depending on both) and a fake worker runner that edits and commits through the real worker tools When the run completes Then `run/<id>` contains all three tasks' changes, `main` and the primary checkout (with an uncommitted file) are byte-identical to before, and all tasks are `done`.
  - Given a worker that edits a file outside its `Owns` When it tries Then the guard denies it and the task ends `failed: blocked` with dependents `blocked`; given two tasks forced to conflict (hand-built plan bypassing the parser) Then the second becomes `failed: merge conflict`.
  - Given the base branch moves while a run is in progress When later waves start Then they still branch from `run/<id>`, whose recorded base commit is unchanged.
  - Given `CLAUDE_DESK_LIVE=1` and a tiny real plan (two dependent tasks that each add a small file and run a configured check) When the live test runs Then the real SDK sessions use the plan's worker, commit, and the integration branch contains both changes; without the variable the test is skipped visibly.
  - Given `docs/notes/phase-4a-manual-check.md` When read Then it lists exact steps and expected results for the live run (how the checks are seeded through `SettingsStore`, how to inspect the branches and worktrees, how to remove them), including a deliberately failing task and a cancel. It also records as accepted that checks write caches through the `node_modules` junction into the primary checkout's `node_modules`, and re-checks whether `permissionMode: 'acceptEdits'` is needed (T1 was uncertain).
  - Given the live run When finished Then `docs/notes/phase-4a-timing.md` holds per-task duration, turns, cost and total for the real run (the input for planning 4c), or states plainly that the live run was not done.

## 8. Wave summary

| Wave | Tasks | Parallel |
|---|---|---|
| 1 | T1, T2, T3, T4 | yes, disjoint: spike note, `planParser.ts`, `db/migrations`+`pipelineStore`, `shared/settings`+`settingsStore`+Phase 3 plan |
| 2 | T5, T6 | yes, disjoint: `worktrees.ts`; `workerTools.ts`+`workerGuard.ts` |
| 3 | T7 | single task: orchestrator, runner, prompts |
| 4 | T8 | end-to-end and live check |

Workers: `node-developer` for T1, T2, T4-T8 (`src/main`, `src/shared`, tests, notes); `database-engineer` for T3 (migration and SQL). No `frontend-developer` task in 4a. Commits: Conventional Commits with the task id, for example `feat(pipeline): parse and validate plans (T2)`.

If T1 decides that worktrees need an installed `node_modules`, `build` adds a task to wave 2 for it before T6/T7 rely on it.

## 9. Follow-ups
- W1 T4 `src/main/db/settingsStore.test.ts`: the "no repo file read" test only asserts `get` returns `[]` with no row; it has no `package.json` fixture (weak).
- W1 T4 `src/shared/settings.ts`: `checks` is `.optional()` (type `checks?:`), not `.default([])`; readers must default to `[]`.
- W1 T3 `src/main/db/migrations.test.ts`: migration 2 test now uses `MIGRATIONS.slice(0, 2)`.
- W1 T1 spike: `permissionMode: 'acceptEdits'` need unverified (re-check in T8 live run); `git worktree remove --force` with a junction untested (T5 test added); packaged-Electron npm resolution untested.
- W1 T2 `planParser.ts`: toolkit worker list should later come from the plugin's `agents/` folder (parameter exists, default five workers).
- W1 flaky: one full `npm test` run had 1 failing test (not reproduced on re-run; file not identified); watch for it.
- W2 reviewer F1 `workerTools.ts:291`: output overflow (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, `killed=true`) is reported as a timeout; check the MAXBUFFER code first and test it.
- W2 reviewer F2 `worktrees.ts:261-269,426`: task id `integration` collides with the integration worktree path; reject it as reserved.
- W2 reviewer F4 `workerTools.ts:365-397`: `git_commit` does not check paths against protected patterns (the Write guard is the only protected-path boundary).
- W2 reviewer F5 `workerTools.ts:361-363`: `rev-parse --abbrev-ref HEAD` gives `heads/task/...` when a tag shares the branch name; use `symbolic-ref --short -q HEAD`.
- W2 reviewer F6 `workerTools.ts:391-397`: if `git commit` fails after `git add`, paths stay staged; reset them best-effort.
- W2 reviewer F7 `worktrees.ts:290-297`: an on-disk worktree folder git does not know (crashed add) makes `removeTask`/`removeRun` fail; prune, then delete after unlinking the junction.
- W2 reviewer F8 `workerGuard.test.ts`: no tests for UNC/device, ADS, trailing dot/space, 8.3/case alias and Edit through a link.
- W2 auditor S2 (residual): `run_check` runs worker-written code unsandboxed as the user (env allowlist added; accepted risk). Later: planner refuses `Owns` over files that define how checks run (`package.json`, `.npmrc`, `vitest.config.*`, `.gitattributes`); OS sandbox or approval gate before `run_check`. Add to Risks in 4b.
- W2 round-2 reviewer F1 `workerTools.ts:155`: env allowlist is narrow for real toolchains (TMPDIR, LANG, windir, ProgramFiles, HOMEDRIVE/HOMEPATH, proxy/CA, npm_config_*); expand or make configurable if a live check fails on it (T8).
- W2 round-2 reviewer F2 `workerTools.ts:266`: `testPath` is passed as `./<rel>`; may not match as a substring filter in some runners (vitest); verify in T8 live run.
- W2 round-2 reviewer F3 `workerTools.test.ts`: add accept case `src/my-dir/a-b.test.ts` and a `Path`-key casing case.
- W2 T5: git filter overrides are read once per public operation, not before every git call (deviation from spike); git prefix and identity duplicated in `worktrees.ts` and `workerTools.ts` (dedupe).
- W2 T6: a failed-to-start check is recorded as `failed`; file-symlink test skipped on this machine (EPERM).
- W2 T5 tests: the real-git `worktrees.test.ts` takes up to ~300 s on this machine (60 s per-test timeout set).
- W3 reviewer F3 `orchestrator.ts:236-239`: `handle.cancelled` forces the run to `cancelled` even when every task finished `done` (cancel racing the final merge). Check in T8.
- W3 reviewer F5 `orchestrator.ts:167,201,214-218`: git errors (`resolveRef`, merge exception) are recorded as `worker error`; consider `git error`.
- W3 reviewer F6 `workerRunner.test.ts`: missing tests for sync `queryFn` throw, `q.close()` throwing, time cap racing a cancel (`limit` should win), abort-listener removal on every exit. Check in T8.
- W3 T7: extra reasons `merge failed: <error>` and `worktree error: <error>` are not in the plan's list; read-only git MCP tools are not added to the worker (`work` is the only server); `permissionMode: 'acceptEdits'` kept, re-check in T8 live run.
- W3: the reviewer found F1 (failure-path tests), fixed with F2 (setRunStatus retry) and F4 (cleanup on failed start) in one round; no re-review per the speed rules.
