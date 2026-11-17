# Phase 4b-1 manual check (launch, run, cancel)

The automated flow (`tests/phase-4b-1-flow.test.ts`) drives the real IPC handlers, service, store and orchestrator over a temp git repo with a fake worker. This note covers what only the launched app and the live Agent SDK can show. A live run costs real money (haiku, a few cents) and needs the Claude login.

Status: steps 1-12 run and passed on 2026-11-17 (see Results); steps 13-15 (`acceptEdits`) not run.

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
- Older plans (`phase-1-app-skeleton.md`, `phase-2-closeout.md`) show parse errors in the Pipeline tab; that is expected (legacy layout with wave suffixes).

## Results

### Steps 1-12: run on 2026-11-17

Driven through Playwright against the built app (`out/`, launched with `electron .`), on Windows, with a throwaway git repo as the project and a temp `--user-data-dir` (the real project list and database were not touched). The native folder picker was stubbed in main. Model: Haiku (set in Settings). Real SDK runs; total cost about $0.02.

| Step | Result | Observed |
|---|---|---|
| 1 | pass | Three-panel window, no console errors. |
| 2 | pass | Project listed as `proj`, `main`, `clean`. Note: a Windows short (8.3) path `SERGIU~1` was rejected with "That folder could not be read"; the long path works (the real picker returns long paths). |
| 3 | pass | Check `verify` / `node` / `check.mjs` saved, kept after leaving and reopening Settings; the "run as you, no shell, not a sandbox" hint is shown. Toolkit status Valid, plugin 0.9.0. |
| 4 | pass | Plans listed with file name or title, `flow-plan/1` badge, task and wave counts. |
| 5 | pass | `broken.md`: "4 errors" with line numbers, Start disabled. |
| 6 | pass | Run appeared as `running` within 2 s; T1 `queued`, `running`, `done`; T2 started after T1; no manual refresh. Whole run about 35 s. |
| 7 | pass | "Committed, not reviewed" on each done task, run badge "tasks committed, not reviewed", "Nothing is merged into main or pushed"; checks passed, duration and cost (about $0.003-0.007 per task) shown. |
| 8 | pass | `run/<id8>` and both task branches exist; `src/one.txt` = `one`, `src/two.txt` = `two` on the run branch; merges by `claude-desk`; `main` unchanged, working tree clean. |
| 9 | pass | Cancel visible; "Cancelling..." at once; task and run `cancelled` about 2.1 s after the click; no task left `running`; button gone. |
| 10 | pass | All Start buttons are disabled while a run is active, so the "busy" message cannot be reached by clicking; calling the bridge directly returns `{ok:false, error:"busy"}` and no second run exists. |
| 11 | pass | App killed mid-run (real main process, whole tree); after relaunch the run is `failed`, the task reason is `interrupted`, no Cancel button, Start enabled. This also confirms the wave 3 F1 crash-recovery fix in the real app. |
| 12 | pass | `main` still `f7f7d4a` (reflog shows only the initial commit), `git status` clean, no remote, nothing pushed. |

Observations for Follow-ups (none blocks):
- `broken.md` has `Size: L` but the error list shows only the four missing fields: the parser skips the other field checks for a task that is missing fields, so the Size error appears only after those are fixed.
- Step 10's "busy message" is not visible in the UI because Start is disabled; the contract value is only reachable through the bridge.
- Killing only the launcher process (as a first attempt did) leaves the app running and the run finishing; a crash test must kill the process whose command line has the app's flags and no `--type=`.
- Each run leaves its worktrees and branches (`run/*`, `task/*`, `.worktrees/`); discard comes in 4b-2.

### Steps 13-15 (`acceptEdits` live check)

Not run. Result line still to fill in: `acceptEdits` with: <pass/fail>; without: <pass/fail>; decision: <keep | remove in a follow-up>; date: <date>.
