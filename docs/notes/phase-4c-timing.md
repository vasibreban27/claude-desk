# Phase 4c timing (T8)

Command: `CLAUDE_DESK_LIVE=1 npm test -- tests/live/phase-4c-live.test.ts --silent=false` (PowerShell: `$env:CLAUDE_DESK_LIVE=1; npm test -- tests/live/phase-4c-live.test.ts --silent=false`), with `CLAUDE_TOOLKIT_PATH` set to the `flow` plugin folder and the Claude login active. Needs `npm run build` first. Real cost (a few cents).

The test runs the same plan twice through the real orchestrator: 3 independent tasks in one wave (T1 `src/one.txt`, T2 `src/two.txt`, T3 `src/three.txt`), first with `maxParallel` 1, then with 3. Every plan task carries `Model: haiku` while the project model is set to `opus`, so a low cost is evidence that the task model won over the project model.

Reference from the spike (`docs/notes/phase-4c-spike.md` section 4, fake `work` server, no worktree/merge overhead): 3 concurrent haiku sessions 11.8 s against 24.0 s serial (about 2.0x), cost about 1.8x (prompt-cache warm-up).

## Results

Not measured yet: the live test needs the owner's login and costs real money, and was not run by the task worker. Fill in after running the command above.

| Run | Task | Status | Duration (ms) | Turns | Cost (USD) | Checks |
|---|---|---|---|---|---|---|
| maxParallel 1 | T1 | | | | | |
| maxParallel 1 | T2 | | | | | |
| maxParallel 1 | T3 | | | | | |
| maxParallel 1 | total wall | | | | | |
| maxParallel 3 | T1 | | | | | |
| maxParallel 3 | T2 | | | | | |
| maxParallel 3 | T3 | | | | | |
| maxParallel 3 | total wall | | | | | |

- Speedup (wall, serial / parallel): <fill in>
- Cost ratio (parallel / serial): <fill in>
- Model evidence: with project model Opus and `Model: haiku` on each task, observed cost per task was <fill in> USD (haiku level in 4a was about 0.003 USD per small task; an Opus session would be several times higher). Result line: task model applied: <yes | no>.

## Decision

Default `maxParallel`: <keep 2 | change to N>, because <reason: speedup and cost ratio, with the worktree and merge overhead included>. Until measured, the spike's recommendation stands: default 2, maximum 4.
