# Phase 4a manual check (live pipeline run)

The automated flow (`tests/phase-4a-flow.test.ts`) covers the orchestrator, real git worktrees, the real worker tools and guard with fake workers. This note covers what only the live Agent SDK can show. A run costs real money (haiku, a few cents) and needs the Claude login.

Status: **not yet run** (see `docs/notes/phase-4a-timing.md`).

## Setup

1. Logged in to Claude Code; `CLAUDE_TOOLKIT_PATH` points at the `plugins/flow` folder; `npm install` done.
2. Automated variant: `CLAUDE_DESK_LIVE=1 npm test -- tests/live/phase-4a-live.test.ts` (PowerShell: `$env:CLAUDE_DESK_LIVE=1; npm test -- tests/live/phase-4a-live.test.ts`). Without the variable the test shows as skipped. It builds a temp repo, seeds the check, runs a two-task plan and prints a timing table; copy that table into `docs/notes/phase-4a-timing.md`. The temp folder path is printed and kept.
3. 4a has no UI. To run by hand, use a small script (outside the repo) or the live test as a template. Seed the check through `SettingsStore`, never a repo file:
   `settings.set(projectId, { ...defaultSettings(), model: 'haiku', checks: [{ name: 'verify', executable: 'node', args: ['check.mjs'], timeoutMs: 60000, acceptsTestPath: false }] })`.
   The project needs a `node_modules` folder (the worker worktrees get a junction to it) and a `.gitignore` entry for it.

## Steps and expected results

4. Happy path: plan with T1 (`src/one.txt`) and T2 (`src/two.txt`, depends on T1). Expect both `done`, `checksResult` `passed`, run `done`.
5. Inspect: `git -C <project> branch --list "run/*" "task/*"` lists `run/<id8>` and `task/<id8>-t1`, `task/<id8>-t2`; `git -C <project> show run/<id8>:src/one.txt` and `...:src/two.txt` show the files; `git -C <project> log --oneline --graph run/<id8>` shows two `--no-ff` merges by `claude-desk`. `main` and the primary checkout (including uncommitted files) are unchanged; worktrees are under `<project parent>/.worktrees/<id8>-integration` and `<id8>-t1`, `<id8>-t2` (`git worktree list`).
6. Deliberately failing task: add T3 (wave 2, `src/three.txt`) whose acceptance says "the file must be empty". The `verify` check then fails. Expect the worker to report or commit anyway; whichever happens, the record shows `checksResult` `failed` and the run is not silently green. Add T4 depending on T3: expect `blocked` if T3 failed, and the run `failed`.
7. Cancel: start a plan whose first task is long (for example "write 30 small files one by one", Owns a directory), call `orchestrator.cancel(runId)` after a few seconds. Expect the running task to stop within about 2 s (the runner uses `query.close()`), the task `cancelled`, queued tasks `cancelled`, run `cancelled`; partial files stay in that task's worktree and are not merged.
8. Out-of-Owns: a task whose prompt asks the worker to edit `README.md` (not in Owns). Expect a denied `Write`/`Edit`, then `report_blocked`: the task is `failed: blocked: ...`.
9. `testPath`: with a check `{ name: 'unit', executable: 'npx', args: ['vitest', 'run'], acceptsTestPath: true, timeoutMs: 120000 }`, ask a worker to run it with a testPath. The path is passed as `./<rel>` (plan follow-up: vitest may not match `./src/x.test.ts` as a substring filter). Record the result: if vitest reports "no test files found", change `workerTools.ts` to pass the path without `./` for runners that need it.
10. Environment allowlist: the check child sees only an allow-listed environment (`checkEnv`). If a real toolchain check fails with missing `TMPDIR`, `LANG`, `ProgramFiles`, proxy or CA variables, extend the allowlist (plan follow-up W2 round-2 F1) and record which variable was missing.
11. `permissionMode: 'acceptEdits'`: the runner sets it. To re-check whether it is needed (T1 was uncertain), temporarily run the live test with `permissionMode` removed in `workerRunner.ts` (do not commit that). If `Write`/`Edit` calls stall or are refused with a permission prompt, it is needed; record the outcome here and in the spike note.
12. Cancel racing the final merge (plan follow-up F3): the automated flow test shows a cancel that lands while the last task finishes leaves the task `done` but the run `cancelled`. Decide whether that is acceptable for 4b.

## Accepted behaviour

- Checks write caches through the `node_modules` junction into the **primary checkout's** `node_modules` (for example `.vite`, `.cache`). This is accepted for 4a: the junction avoids a 7.5 min `npm ci` per task, and the files are ignored by git. A check can therefore alter the shared `node_modules`. Worktree removal unlinks the junction first (tested), so the primary `node_modules` survives cleanup.
- `run_check` runs worker-written code unsandboxed as the user (env allowlist only); accepted risk from the 4a security review.
- "Done" means committed and merged into `run/<id>`, not reviewed.

## Cleanup

13. `git -C <project> worktree list` then for each leftover: `git -C <project> worktree remove --force <path>` (a `node_modules` junction inside it: delete the junction itself first, `cmd /c rmdir <wt>\node_modules` on Windows, `rm <wt>/node_modules` elsewhere, never a recursive delete through it). Then `git -C <project> branch -D run/<id8> task/<id8>-t1 task/<id8>-t2`, `git -C <project> worktree prune`, and delete the empty `.worktrees` folder. Confirm `<project>/node_modules` is intact.

## Results

Not recorded yet. Fill in date, model, outcome per step, and any follow-ups.
