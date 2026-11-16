# Phase 2 manual check

Confirms "done when": watch each agent act live, then see what it cost. Live SDK only; the rest is automated.

1. Logged in to Claude Code; `CLAUDE_TOOLKIT_PATH` set; `npm install`, `npm run dev`. DevTools: `window.api` has `activityHistory`, `usageSummary`, `onActivityEvent`, no console errors.
2. Add a project. Ask something that makes Claude read files and call a subagent (e.g. "use the Explore agent to summarize src/").
3. Activity tab: rows appear live, labelled `main` or the subagent type. Expect (a) tool rows show durations and the subagent row shows a summary (`duration_ms` on PostToolUse, `last_assistant_message` on SubagentStop).
4. Open Usage after the run: totals, per-day and per-agent rows, costs shown as "~$" estimates, subagent output tokens marked "~".
5. Restart the app. Usage is still there; the Activity feed is empty.
6. Ask Claude to edit a file. Expect a "Denied" row, no file change, and (b) exactly one finished row for it (no duplicate `tool-finished`).
7. (c) Inside a subagent run, its Read/Grep rows appear with the subagent label, and a subagent asked to use Bash is denied too (hooks fire for subagent tool calls).
8. (d) Invoke a toolkit `Skill` whose body has a shell injection (`!`echo hi``) or `allowed-tools: Bash`. Expect it to be denied or inert; if the command runs before a "Denied" row, stop: the guard is bypassed.
9. (e) KNOWN GAP, expected ALLOWED today: ask Claude to read a file outside the project folder (e.g. `~/.gitconfig`). Path scoping is open follow-up S10; do not treat as a regression.
