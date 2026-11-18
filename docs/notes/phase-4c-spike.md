# Phase 4c spike (T1)

Measured on 2026-11-18, Windows 11, git 2.55.0.windows.5, Node 24.21, `@anthropic-ai/claude-agent-sdk` 0.3.323, existing login, toolkit `flow` plugin from the local `claude-toolkit` checkout. All scripts live in the session scratch folder (outside the repo); nothing under `src/` changed. Every git call used the hardened argv and env from `docs/notes/phase-4a-spike.md` section 4. Temp repos were created under `os.tmpdir()` (native-resolved long paths).

## 1. Concurrent `git worktree add -b` in one repo, no mutex
Temp repo with a `run/abcd1234` branch; 20 rounds of 4 simultaneous `worktree add -b task/abcd1234-r<N>t<M> <path> run/abcd1234` (80 calls, nothing removed between rounds, so the repo ended with 81 worktrees).
- Failures: **0 of 80**. No error text of any kind.
- Afterwards `worktree list` showed 81 entries (1 + 80), 80 `task/` branches, `git fsck` clean.
- Conclusion: on this machine the mutex is not strictly required for `worktree add`. The plan builds it anyway (it also guards `memo`/`setup` state and merges, which do conflict in the same worktree), and one clean run does not prove safety on other filesystems or under load. Keep the mutex.
- Cost side note: 80 `worktree add` calls took about 50 s in total here (about 0.6 s each, run 4 at a time), so creation is not free; the mutex serializes it per run.

## 2. Four sibling worktrees: `add` plus `commit` at the same moment
4 worktrees of one repo, 20 rounds; each round every worktree writes a new file and runs `add -- <path>`, `rev-parse --abbrev-ref HEAD`, `commit --no-verify -m .. --only -- <path>` simultaneously (240 git calls, `GIT_TRACE=1` on add and commit).
- Failures: **0 of 240**. No lock error (`index.lock`, `Unable to create`, ref lock) in any stderr.
- Each worktree ended with 21 commits (1 base + 20), `git fsck` clean.
- **`gc --auto` did not run** (no `gc` in any trace, loose objects 266, `gc.auto` default 6700), but **every commit spawned `git maintenance run --auto --no-quiet --detach`** (80 of 80 commits). That is a detached background process that can start `gc` or other maintenance when thresholds are crossed, in the shared object store, possibly while a sibling task is merging or a worktree is being removed (on Windows a leftover process can hold a lock on the repo and make `worktree remove` fail).
- **Decision:** add `-c gc.auto=0 -c maintenance.auto=false` to the git prefix for task-worktree and integration commands (commit, merge, worktree add/remove). It is a defence-in-depth change, small, and removes background writers from the user's repository during a run. Not required for correctness in this measurement. Needs a follow-up edit in `worktrees.ts` and `workerTools.ts` (not part of this spike's `Owns`).

## 3. Three worktrees sharing the primary `node_modules` through a junction, real vitest
Primary `node_modules` = this repo's (vitest installed). 5 rounds; each round 3 fresh temp worktree folders, each with a `node_modules` junction to the primary, a tiny `a.test.js` (`vitest run`, 200 ms async test), all 3 run at the same moment (15 runs). Junctions were unlinked with `unlinkSync` after each round; the primary `node_modules` survived.
- Failures: **0 of 15** (each run reported 1 passed).
- Files written under the shared `node_modules` (mtime after the run started), 16 in total:
  - `.vite/vitest/<hash>/results.json` (vitest's results cache; the hash is the same for all three runs, so they overwrite the same file),
  - 15 hash-named files under `.vitest-cache/` (content cache, written by the runs).
- No other package files were touched. Concurrent writes of the same cache file did not fail a run in this measurement. Not covered: a worker's own check commands (for example a build that writes `node_modules/.cache`) and a much larger suite.
- **Decision:** no `run_check` lock needed; no STOP. Keep a note in the Pipeline tab help that checks share one `node_modules` cache.

## 4. Three live haiku worker sessions, concurrent vs serial
Each session: `model: 'haiku'`, `settingSources: []`, `plugins` = `flow`, `tools: [Read, Grep, Glob, Write, Edit]`, `permissionMode: 'acceptEdits'`, `maxTurns: 15`, an in-process `work` MCP server with a `git_commit` tool (`add` plus `commit --only`, same argv as the app), its own worktree of a temp repo, task "create `src/oneN.txt` with one line, commit it". The path guard hook was not used (it is not what is measured). Script differs from the app's runner only in that.

| Mode | Wall clock | Sum of task times | Cost (USD) | Turns per task | Errors |
|---|---|---|---|---|---|
| 3 concurrent | 11.8 s | 31.2 s (10.7 / 10.1 / 10.5) | 0.00787 | 3, 3, 3 | none |
| 3 serial | 24.0 s | 24.0 s (8.6 / 7.7 / 7.7) | 0.00431 | 3, 3, 3 | none |

- No rate-limit, overload or other error in either mode; all 3 commits landed in the right worktree in both modes.
- Speed-up: about 2.0x for 3 workers on tiny tasks (wall 11.8 s vs 24.0 s). Per-task time grew about 30% under concurrency (10.4 s against 8.0 s average), so the gain is below the ideal 3x.
- Cost: concurrent total was about 1.8x the serial total (0.0079 against 0.0043). In the concurrent run the first task paid 0.0048 and the others 0.0015 to 0.0016; the serial tasks each cost 0.0014. The difference matches prompt-cache warm-up: sessions started at the same moment cannot read each other's cache, a serial run reuses it. One sample, tiny tasks, so treat the cost ratio as indicative; for real tasks (larger prompts, more turns) the cache effect is relative to a bigger bill, so keep the cost counter visible.
- Only 3 sessions were tested, not 4, and only one run of each mode. No error at 3 means the default of 2 is safe; the maximum of 4 is the plan's cap and was not exercised live.

## Decision index
| Question | Decision |
|---|---|
| Is a mutex needed for concurrent `git worktree add` in one repo? | Not observed to fail (0 of 80, 4 at a time); build the mutex anyway (also guards manager state and merges) |
| Lock errors when 4 sibling worktrees `add` and `commit` together? | None in 240 calls; no `index.lock`, fsck clean |
| Did `gc --auto` run? | No, but every commit spawns a detached `git maintenance run --auto`; add `-c gc.auto=0 -c maintenance.auto=false` to the task-worktree and integration argv (follow-up edit in `worktrees.ts`/`workerTools.ts`) |
| Concurrent vitest over the shared `node_modules` junction | 0 of 15 failed; writes only `.vite/vitest/<hash>/results.json` and `.vitest-cache/*`; no `run_check` lock, no STOP |
| 3 concurrent live haiku sessions | No rate-limit or overload errors; wall 11.8 s against 24.0 s serial (about 2.0x); cost about 1.8x (cache warm-up) |
| Recommended default `maxParallel` | 2 (matches the plan) |
| Recommended maximum `maxParallel` | 4 (the plan's cap; 3 was verified live without errors, 4 was not) |
| Does the plan need a re-plan? | No: no STOP condition hit |
