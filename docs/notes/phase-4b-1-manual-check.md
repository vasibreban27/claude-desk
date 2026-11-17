# Phase 4b-1 manual check (launch, run, cancel)

The automated flow (`tests/phase-4b-1-flow.test.ts`) drives the real IPC handlers, service, store and orchestrator over a temp git repo with a fake worker. This note covers what only the launched app and the live Agent SDK can show. A live run costs real money (haiku, a few cents) and needs the Claude login.

Status: **not yet run**.

## Setup

- Logged in to Claude Code; `CLAUDE_TOOLKIT_PATH` points at the `plugins/flow` folder (set it in the shell or in `.env`); `npm install` done.
- A small plan in `docs/plans/` in `Format: flow-plan/1` with two tiny tasks (for example T1 owns `src/one.txt`, T2 owns `src/two.txt` and depends on T1), and a deliberately broken plan (a task missing required fields) saved as `docs/plans/broken.md`.
- A `check.mjs` file in the project root that exits 0 (`process.exit(0)`).
- The project has a `node_modules` folder (task worktrees get a link to it) and `node_modules/` in `.gitignore`.

## Steps and expected results

1. Launch with `npm run dev`. Expect the three-panel window and no error in the terminal.
2. Add this repo as a project (folder picker). Expect it in the left panel with its branch.
3. Open Settings for the project, add a check: name `verify`, executable `node`, args `check.mjs`, timeout 60000, test path off, then save. Expect the save to succeed, the check to stay listed after reopening Settings, and the "workers run these as you" hint next to the editor.
4. Open the Pipeline tab. Expect the plan list with each file name, its format and task count.
5. Look at `broken.md`. Expect it marked as invalid with the error count and the first errors with their line numbers, and its Start button disabled.
6. Start the small plan. Expect the run to appear at once as `running`, tasks `queued` then `running` then `done` as they finish, without a manual refresh, with a short commit id per finished task.
7. Check the labels. Expect "Committed, not reviewed" on done tasks (never "verified" or "merged"), the check result next to a task, and turns, cost and duration once known.
8. After the run is `done`, check git: `git branch --list "run/*" "task/*"` shows `run/<id8>` and the task branches; `git show run/<id8>:src/one.txt` shows the file. Expect `main` and the working tree (including uncommitted files) unchanged: `git rev-parse main` is the same as before the run and `git status --porcelain` is unchanged.
9. Start a run of a plan whose first task is long (for example "write 30 small files one by one", Owns a directory), then press cancel after a few seconds. Expect the running task to stop within about 2 s, tasks `cancelled`, the run `cancelled`, the cancel button gone, and no task left `running`.
10. While a run is active, try starting the plan again. Expect a "busy" message and no second run.
11. Close the app during a run, reopen it and open the Pipeline tab. Expect the run shown as `failed` with task reason `interrupted`, not `running`.
12. Confirm `main` is untouched once more: same `git rev-parse main`, same `git status --porcelain`.

## Live check: `permissionMode: 'acceptEdits'`

The worker runner sets `permissionMode: 'acceptEdits'` (`src/main/pipeline/workerRunner.ts`). It is not known whether it is needed.

13. Run the live test with the setting: `CLAUDE_DESK_LIVE=1 npm test -- tests/live/phase-4a-live.test.ts` (PowerShell: `$env:CLAUDE_DESK_LIVE=1; npm test -- tests/live/phase-4a-live.test.ts`), with `CLAUDE_TOOLKIT_PATH` set. Expect both tasks `done`.
14. Temporarily remove `permissionMode: 'acceptEdits'` from `workerRunner.ts` and run the same command again. Never commit this change; restore it with `git checkout -- src/main/pipeline/workerRunner.ts`. If `Write` or `Edit` calls stall or are refused with a permission prompt, the setting is needed.
15. Decision: if the run without the setting works the same, remove the setting in a follow-up; otherwise keep it.

Result line to fill in: `acceptEdits` with: <pass/fail>; without: <pass/fail>; decision: <keep | remove in a follow-up>; date: <date>.

## Accepted behaviour

- "Done" means committed in the task branch and merged into `run/<id>`, not reviewed. Reviewers, checks before review, merge into `main` and push come in Phase 5.
- `run_check` runs worker-written code unsandboxed as the user (env allowlist only); accepted risk from the 4a security review.
- Only the latest run per project is shown; the discard button comes in 4b-2.

## Results

Not recorded yet. Fill in date, model, outcome per step, and any follow-ups.
