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

Status: steps 1-10 run and passed on 2026-11-18; step 11 (optional) not run; crash recovery gap found and fixed (below).

Driven through Playwright against the built app (`out/`, `electron .`) on Windows, with a throwaway git repo (`parallel3.md` with 3 independent tasks, `long3.md` with 3 long tasks) and a temp `--user-data-dir`. Real SDK sessions on Haiku (set in Settings), total cost about $0.03. The native folder picker was stubbed in main.

| Step | Result | Observed |
|---|---|---|
| 1 | pass | Window launched, no console errors. |
| 2 | pass | Settings show "Workers at once", "Max turns per task" and "Time limit per task (minutes)" with 2, 40 and 20; the hints say cost and load grow with the number, that it applies to the next run, and that a task's `Model` wins. |
| 3 | pass | 5 workers is refused ("Enter a whole number from 1 to 4."); 3, 15 and 10 save and stay after reopening Settings, together with the check and the model. The save message still reads "They apply to the next message" (wrong for the limits; plan Follow-ups, phase review F2). |
| 4 | pass | The run appears at once as `running`; the first 4 s go to serialized worktree creation. |
| 5 | pass | All 3 tasks `running` at the same time (header "3 running"), total cost grew as tasks reported ($0.0029, $0.0055, $0.0080), each done task "Committed, not reviewed", run `done` in 36 s. |
| 6 | pass | With 3 tasks `running`, Cancel showed "Cancelling..." at once and never flipped back; all 3 tasks and the run were `cancelled` about 3.8 s after the click; the button disappeared; nothing left `running`. |
| 7 | pass | With "Workers at once" 1 the tasks ran strictly one by one (never 2 `running`) in 75 s, against 36 s with 3 workers. |
| 8 | pass | `run/<id8>` holds one.txt, two.txt and three.txt, with one merge per task by `claude-desk`, in completion order; 3 task branches. |
| 9 | pass | Discard removed the run, its 3 task branches and worktrees (about 10-14 s for 3 tasks; the dialog stays up meanwhile). |
| 10 | pass | `main` unchanged after all runs, `git status` clean, no remote, nothing pushed. |
| 11 | not run | Optional. The live timing test (`phase-4c-timing.md`) gave the cost-level evidence. |

### Crash recovery gap, found by the review and reproduced here

Seeding two crashed runs into the app's database (one killed between waves with no task `running`, one killed mid-wave) and starting the previous build showed two problems: the between-waves run stayed `running` forever (database `finished_at` empty), showing neither Discard nor Cancel, so nothing in the app could clear it; and a mid-wave run showed "1 queued, 2 failed" (a task that never started stayed `queued` under a `failed` run). Cause: `markInterrupted` in `src/main/db/pipelineStore.ts` only failed a run that still had a `running` task and only touched `running` tasks. Fixed: every `running` run becomes `failed`; its `running` tasks fail and its `queued` tasks are cancelled, both with reason `interrupted`. Confirmed on the rebuilt app with the same data: the stuck run became `failed` ("1 done, 2 cancelled"), the mid-wave run read "2 failed, 1 cancelled", and Discard worked on both.
