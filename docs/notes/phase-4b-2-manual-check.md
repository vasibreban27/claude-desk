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
