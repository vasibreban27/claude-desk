# Phase 4a timing (T8)

Measured on 2026-11-17 with `CLAUDE_DESK_LIVE=1 npm test -- tests/live/phase-4a-live.test.ts --silent=false` (two dependent tasks, real SDK sessions, merged into `run/<id>`). Model: haiku. Claude Code 2.1.326, `@anthropic-ai/claude-agent-sdk` ^0.3.323, Windows dev machine. Without `--silent=false` vitest hides the printed table. One run; whole test took about 31 s.

| Task | Status | Duration (ms) | Turns | Cost (USD) | Checks |
|---|---|---|---|---|---|
| T1 | done | 12602 | 5 | 0.00278941 | passed |
| T2 | done | 13553 | 6 | 0.00250009 | passed |
| Total | done | 26155 | 11 | 0.0052895 | passed |

Single sample, tiny tasks: treat as an order-of-magnitude reference for 4c, not a benchmark. Roughly 13 s and 0.003 USD per small haiku task, serial.

Reference only (not a pipeline measurement): the Phase 4a spike (`docs/notes/phase-4a-spike.md` section 7) saw a single haiku worker finish edit, check and commit in 6 turns, about 11 s, 0.006 USD, with a fake `work` server.

Also measured without the SDK: `tests/phase-4a-flow.test.ts` (real git, fake workers) takes roughly 90 s on the Windows dev machine, almost all of it git worktree operations. Worktree creation and merge overhead per task is therefore not negligible; include it in 4c planning.
