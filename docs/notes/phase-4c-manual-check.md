# Phase 4c manual check (parallel workers)

The automated flow (`tests/phase-4c-flow.test.ts`) drives the real IPC handlers, orchestrator, manager and store over a temp git repo with fake workers. This note covers what only the launched app and live SDK sessions show. A live run costs real money (haiku, a few cents) and needs the Claude login.

## Setup

- Logged in to Claude Code; `CLAUDE_TOOLKIT_PATH` points at the `plugins/flow` folder; `npm install` done.
- A throwaway git project with `check.mjs` (`process.exit(0)`), a `node_modules` folder, `node_modules/` in `.gitignore`, and `docs/plans/parallel3.md` in `Format: flow-plan/1` with one wave of 3 independent tasks (T1 owns `src/one.txt`, T2 `src/two.txt`, T3 `src/three.txt`, all `Depends on: none`). For step 6 a second plan whose tasks each write about 30 small files one by one (Owns a directory each).
- Note `git rev-parse main` and `git status --porcelain` before starting.

## Steps and expected results

1. Launch with `npm run dev`. Expect the three-panel window and no error in the terminal.
2. Add the throwaway repo as a project and open its Settings. Expect the "Workers at once", turn cap and time limit fields with the defaults 2, 40 and 20.
3. Set "Workers at once" to 3, the turn cap to 15 and the time limit to 10, add the check `verify` / `node` / `check.mjs` / 60000, and save. Expect the save to succeed and the values to stay after reopening Settings. Values outside the range (for example 5 workers) must be refused.
4. Open the Pipeline tab and start `parallel3.md`. Expect the run to appear at once as `running`.
5. Expect all 3 tasks `running` at the same time, the header showing the running count (3 running) and a total cost that grows as tasks report, tasks ending `done` with "Committed, not reviewed", and the run `done`.
6. Start the long plan, wait until 3 tasks are `running`, then press cancel. Expect "Cancelling..." to stay until the end (it must not flip back), every running task to stop within about 3 seconds, all tasks `cancelled`, the run `cancelled`, the cancel button gone, and no task left `running`.
7. Set "Workers at once" to 1, save, and run `parallel3.md` again. Expect the tasks to run one by one (never 2 `running` at the same time) and the run to take visibly longer than step 5.
8. Check git after the finished run: `git show run/<id8>:src/one.txt` (and two, three) shows the file contents; `run/<id8>` has one merge per task.
9. Discard the finished run. Expect the run, its task branches and worktrees to disappear.
10. Confirm `main` is untouched: same `git rev-parse main` and same `git status --porcelain` as before step 4, nothing pushed.
11. Optional model check: in a plan add `Model: haiku` to a task while the project model is Opus. Expect the task cost to be at haiku level (cents or less); record it in `phase-4c-timing.md`.

## Results

Status: built and verified by tests and review, not launched. Steps 1-11 have not been run by hand yet.

Fill in after running: date <date>; steps passed <list>; failed steps and observations <text>.
