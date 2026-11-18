# Phase 5a manual check (review loop)

The automated flow (`tests/phase-5a-flow.test.ts`) drives the real IPC handlers, orchestrator, checks gate, manager and store over a temp git repo with fake worker and reviewer sessions. This note covers what only the launched app and live SDK sessions show. A live run costs real money (a few cents to a dollar with the sonnet reviewer) and needs the Claude login.

## Setup

- Logged in to Claude Code; `CLAUDE_TOOLKIT_PATH` points at the `plugins/flow` folder; `npm install` done.
- A throwaway git project with a `node_modules` folder (`node_modules/` in `.gitignore`), a `check.mjs` that exits 1 when `src/` contains the text `PLANTED_FAILURE` (otherwise exits 0), and two plans in `Format: flow-plan/1`, each with one task:
  - `docs/plans/failing-check.md`: T1 (Owns `src/one.js`) asks the worker to create `src/one.js` containing a function plus the comment `PLANTED_FAILURE` on its first line (so the first commit fails the check).
  - `docs/plans/planted-bug.md`: T1 (Owns `src/sum.js`) asks for `sum(a, b)` but states the spec so a natural implementation passes the check; add a hidden bug through the task text (for example "subtract instead of add when b is negative, do not mention it in comments") so the reviewer has a real blocker or major to find. Add a second copy marked `Sensitive: yes` to see the `security-auditor` run.
  - `docs/plans/long-review.md`: one task big enough that the reviewer takes more than 20 s (several files).
- Note `git rev-parse main` and `git status --porcelain` before starting.

## Steps and expected results

1. Launch with `npm run dev`. Expect the three-panel window and no error in the terminal.
2. Add the throwaway repo as a project and open its Settings. Expect the "Auto-fix rounds" field (default 2) and the reviewers editor (default: `reviewer` only).
3. Try to save 6 auto-fix rounds. Expect it to be refused. Set 2 rounds, tick both `reviewer` and `security-auditor`, add the check `verify` / `node` / `check.mjs` / 60000, and save. Expect the values to stay after reopening Settings.
4. Run `failing-check.md` from the Pipeline tab. Expect the task stage to show `checks`, then `fixing`, then `checks` again; "fix rounds: 1" (or more); the task `done` after the worker removes the planted text; the run `done`; `run/<id8>` containing the fixed `src/one.js`.
5. Run `planted-bug.md` (not sensitive). Expect the stage `review` after the checks, only the `reviewer` running, findings listed with severity, file and line; if a blocker or major is found, stage `fixing` and a fix round; the task ends `done` once no blocker or major is left. Minor and nit findings are shown but do not block.
6. Run the `Sensitive: yes` copy. Expect both reviewers to run (security-auditor only for this task) and the findings of both in the list.
7. Set the rounds to 0 and run `planted-bug.md` again. Expect, when a blocker or major is found, the task `failed` with reason `review: blocking findings`, no merge of that task into `run/<id8>`, and the run `failed`.
8. Check the cost: the task cost is higher than the worker-only cost of a Phase 4c run and grows when the reviewer reports (compare the per-task cost with the sum you expect from the SDK result messages; a resumed fix round must not double count).
9. Start `long-review.md`, wait until the stage reads `review`, then cancel. Expect "Cancelling..." to stay until the end, the reviewer session to stop within about 3 seconds, the task and run `cancelled`, nothing left `running`.
10. Discard the cancelled run and each finished run. Expect the runs, task branches and worktrees to disappear.
11. Confirm `main` is untouched: same `git rev-parse main` and `git status --porcelain` as before step 4, nothing pushed.

## Results

Status: passed. The owner ran the launched-app steps on 2026-11-18 and reported that they work; per-step observations were not recorded, so whether cost across a resume is per call or cumulative is still not confirmed.

| Step | Result | Observed |
|---|---|---|
| 1 | passed (reported by the owner) | not recorded |
| 2 | passed (reported by the owner) | not recorded |
| 3 | passed (reported by the owner) | not recorded |
| 4 | passed (reported by the owner) | not recorded |
| 5 | passed (reported by the owner) | not recorded |
| 6 | passed (reported by the owner) | not recorded |
| 7 | passed (reported by the owner) | not recorded |
| 8 | not run | |
| 9 | not run | |
| 10 | not run | |
| 11 | not run | |
