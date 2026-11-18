# Phase 4c timing (T8)

Command: `CLAUDE_DESK_LIVE=1 npm test -- tests/live/phase-4c-live.test.ts --silent=false` (PowerShell: `$env:CLAUDE_DESK_LIVE=1; npm test -- tests/live/phase-4c-live.test.ts --silent=false`), with `CLAUDE_TOOLKIT_PATH` set to the `flow` plugin folder and the Claude login active. Needs `npm run build` first. Real cost (a few cents).

The test runs the same plan twice through the real orchestrator: 3 independent tasks in one wave (T1 `src/one.txt`, T2 `src/two.txt`, T3 `src/three.txt`), first with `maxParallel` 1, then with 3. Every plan task carries `Model: haiku` while the project model is set to `opus`, so a low cost is evidence that the task model won over the project model.

Reference from the spike (`docs/notes/phase-4c-spike.md` section 4, fake `work` server, no worktree/merge overhead): 3 concurrent haiku sessions 11.8 s against 24.0 s serial (about 2.0x), cost about 1.8x (prompt-cache warm-up).

## Results

Measured live on 2026-11-18 (real SDK sessions, real git worktrees and merges, Claude login of the owner). Kept temp repos: `p4c-live-1-*` and `p4c-live-3-*` in the OS temp folder.

| Run | Task | Status | Duration (ms) | Turns | Cost (USD) | Checks |
|---|---|---|---|---|---|---|
| maxParallel 1 | T1 | done | 14354 | 5 | 0.00626 | passed |
| maxParallel 1 | T2 | done | 14913 | 6 | 0.00221 | passed |
| maxParallel 1 | T3 | done | 15960 | 6 | 0.00244 | passed |
| maxParallel 1 | total wall | | 51038 | | 0.01092 | |
| maxParallel 3 | T1 | done | 17481 | 5 | 0.00281 | passed |
| maxParallel 3 | T2 | done | 17822 | 4 | 0.00184 | passed |
| maxParallel 3 | T3 | done | 21849 | 5 | 0.00232 | passed |
| maxParallel 3 | total wall | | 25511 | | 0.00697 | |

- Speedup (wall, serial / parallel): 2.00x (51.0 s vs 25.5 s), includes worktree creation and merge overhead.
- Cost ratio (parallel / serial): 0.64x (no cache-warm-up penalty seen; the serial run paid a higher first task, 0.0063 USD).
- Model evidence: with project model Opus and `Model: haiku` on each task, observed cost per task was 0.0018 to 0.0063 USD (haiku level in 4a was about 0.003 USD per small task; an Opus session would be several times higher). Result line: task model applied: yes (inferred from the cost level only; the run does not report the model name).

## Decision

Default `maxParallel`: keep 2, because 3 parallel tasks gave 2.0x wall speedup (about 0.67 per extra slot) at no extra cost, so the spike's recommendation stands (default 2, maximum 4). Per-task duration grew about 20 percent under 3-way concurrency (14-16 s to 17-22 s), so returns diminish; N=3 is a reasonable user-chosen value.
