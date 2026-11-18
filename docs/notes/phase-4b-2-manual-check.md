# Phase 4b-2 manual check (discard a run)

Component and hook tests cover the button, the confirmation and the error messages with a mocked bridge. The real removal is covered by the 4b-1 service tests. This note covers what only the launched app shows.

## Setup

- Same setup as `docs/notes/phase-4b-1-manual-check.md` (project added, small plan, `check.mjs`, `node_modules` ignored).
- Note `git rev-parse main` and `git status --porcelain` before starting.

## Steps and expected results

1. Start the small plan and wait until the run is `done`. Run `git branch --list "run/*" "task/*"` and `git worktree list`. Expect `run/<id8>`, the task branches and their worktrees under `.worktrees/`.
2. In the Pipeline tab click Discard. Expect a confirmation that names `run/<id8>` and each `task/<id8>-<task>` branch, says commits on them are lost and that the base branch is not touched, with Cancel and Discard buttons.
3. Click Cancel. Expect the confirmation to close, the run still shown, and git unchanged.
4. Click Discard, then Discard in the confirmation. Expect the run view to be replaced by the plan list, with focus on the "Plans" heading.
5. Run `git branch --list "run/*" "task/*"` and `git worktree list`. Expect no `run/*` or `task/*` branches and no run worktrees. `git rev-parse main` and `git status --porcelain` are the same as before.
6. Start a run that fails (for example a task whose check fails, or close the app mid-run and reopen it so the run shows `failed` with reason `interrupted`). Expect a Discard button on the failed run; discard it as in steps 2-5 with the same expected result.
7. Start a run and, while it is `running`, look for Discard. Expect no Discard button (only Cancel run). After cancelling, expect Discard to appear.
8. Optional failure path: make a worktree undeletable (for example open a file inside it in another program on Windows) and discard. Expect an alert saying some worktrees or branches could not be removed, the run still shown, and Discard working again after the lock is released.

## Results

### Steps 1-8: run on 2026-11-18

Driven through Playwright against the built app (`out/`, launched with `electron .`) on Windows, with a throwaway git repo and a temp `--user-data-dir`. Real SDK runs on Haiku (about $0.03 in total). The native folder picker was stubbed in main.

**The first pass failed and found a real bug.** On the 4b-2 build as first written, Discard on a finished run always ended in "Some worktrees or branches could not be removed". The main process logged `could not unlink node_modules link: Path is a directory`. Cause (src/main/pipeline/worktrees.ts, a 4a bug): the worktree's `node_modules` junction was removed with `fs.rmSync(link, { recursive: false })`, which throws `ERR_FS_EISDIR` inside Electron 45 (Node 24.22.2) on Windows although it works in plain Node 24.21, so the unit tests passed. Fixed in 8591e09 with `fs.unlinkSync(link)` (checked inside the Electron main process: it removes only the link and keeps the target) plus a regression test that simulates the Electron error. A second bug was also reproduced and fixed (877883b): a failed discard's alert stayed on screen when another run was displayed. The steps below are the second pass, on the fixed build.

| Step | Result | Observed |
|---|---|---|
| 1 | pass | A `done` run shows a Discard button and no Cancel; branches `run/<id8>`, `task/<id8>-t1`, `-t2` and their worktrees exist. |
| 2 | pass | Confirmation "Discard this run?" lists `run/<id8>` and each `task/<id8>-<task>`, says commits are lost and `main` is not touched, with Cancel and Discard; focus starts on Cancel. |
| 3 | pass | Cancel closes it; the run is still shown; git unchanged. Focus falls back to the page body (minor, see Follow-ups of the plan). |
| 4 | pass | Confirming removes the run and the view returns to the plan list (when an older run exists, that run is shown next, because the tab shows the latest run per project); focus lands on the "Plans" heading. |
| 5 | pass | No `run/*` or `task/*` branches, no run worktrees, `.worktrees/` empty; `main` unchanged, `git status` clean, the project's `node_modules` untouched. |
| 6 | pass | A run interrupted by a force kill shows `failed` / `interrupted` with Discard and no Cancel; discarding it works as above. |
| 7 | pass | While `running` there is a Cancel button and no Discard; after cancelling the run is `cancelled` and Discard appears. |
| 8 | pass, with a limitation | With a worktree locked (a process whose working directory is inside it), Discard shows the alert, keeps the run and its Discard button, and logs git's `Permission denied`. Nothing is half-deleted at the run level (the integration worktree is only removed after the task worktrees). **Limitation:** git had already emptied and de-registered the locked worktree, so after the lock is released a retry fails with `'<path>' is not a working tree` and the alert's "try Discard again" cannot succeed. Workaround (verified): delete the empty leftover folder under `.worktrees/` by hand, then Discard works. Proper fix: when git does not know the folder, run `git worktree prune` and remove the empty folder (this is the 4a follow-up "W2 reviewer F7" in `phase-4a-pipeline-engine.md`). |

Other observations:
- Starting a run takes about 3 s before the run appears in the tab (worktree creation); during that time the previous run is still displayed.
- A probe of the status API at 40 ms intervals saw no moment where a new run was `running` but not `active`, so the stale `active` flag race in the 4b-1 Follow-ups was not reproduced here.
