# Phase 2 manual check

Confirms "done when": watch each agent act live, then see what it cost. Live SDK only; the rest is automated.

1. Logged in to Claude Code; `CLAUDE_TOOLKIT_PATH` set; `npm install`; `npm run build` succeeds; `npm run dev`. DevTools: `window.api` has `activityHistory`, `usageSummary`, `onActivityEvent`, no console errors.
2. Add a project. Ask something that makes Claude read files and call a subagent (e.g. "use the Explore agent to summarize src/").
3. Activity tab: rows appear live, labelled `main` or the subagent type. Expect (a) tool rows show durations and the subagent row shows a summary (`duration_ms` on PostToolUse, `last_assistant_message` on SubagentStop).
4. Open Usage after the run: totals, per-day and per-agent rows, costs shown as "~$" estimates, subagent output tokens marked "~".
5. Restart the app. Usage is still there; the Activity feed is empty.
6. Ask Claude to edit a file. Expect a "Denied" row, no file change, and (b) exactly one finished row for it (no duplicate `tool-finished`).
7. (c) Prompt: "Delegate to a subagent: have it run `echo hi` in a shell and report the output." Expect the subagent's Bash call to show a "Denied" row with the subagent label (hooks fire for subagent tool calls); its Read/Grep rows appear too.
8. (d) In a scratch project create `.claude/skills/bang-test/SKILL.md` whose body is a dynamic-context shell injection (a line with an exclamation mark and backticks around `echo hi`), then ask Claude to "use the bang-test skill". Expect denied or inert; if the command runs before a "Denied" row, stop: the guard is bypassed.
9. (e) Ask Claude to read a file inside the project folder: expect ALLOWED. Ask it to read a file OUTSIDE the project folder (e.g. `~/.gitconfig`): expect DENIED (S10 path scoping).
10. settingSources is `['project']`: the `init` message lists the `flow` plugin skills AND the project's own CLAUDE.md is in effect (ask the chat what the project's CLAUDE.md says about commands).
