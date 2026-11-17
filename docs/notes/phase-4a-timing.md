# Phase 4a timing (T8)

**The live run was not done.** It costs money and needs the owner's Claude login, so it was not run in the session that built T8. The table below is empty on purpose: there are no measured numbers, and none may be quoted from this file as input for 4c until someone fills it in.

How to fill it in: follow `docs/notes/phase-4a-manual-check.md` (the automated live test prints exactly these columns when run with `CLAUDE_DESK_LIVE=1`), then copy the printed table here with the date, model and SDK/Claude Code versions.

| Task | Status | Duration (ms) | Turns | Cost (USD) | Checks |
|---|---|---|---|---|---|
| T1 | not measured | - | - | - | - |
| T2 | not measured | - | - | - | - |
| Total | not measured | - | - | - | - |

Reference only (not a pipeline measurement): the Phase 4a spike (`docs/notes/phase-4a-spike.md` section 7) saw a single haiku worker finish edit, check and commit in 6 turns, about 11 s, 0.006 USD, with a fake `work` server.

Also measured without the SDK: `tests/phase-4a-flow.test.ts` (real git, fake workers) takes roughly 90 s on the Windows dev machine, almost all of it git worktree operations. Worktree creation and merge overhead per task is therefore not negligible; include it in 4c planning.
