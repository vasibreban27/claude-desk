# Phase 3 manual check

Confirms "done when": changing a setting changes how the next run behaves. The automated flow (`tests/phase-3-flow.test.ts`) covers the options handed to the SDK and the guard with a mocked `query()`; this note covers what only the live SDK and the built app can show. Each live step is one short run.

Not automated: a launch test of the built app (it needs a display and the Claude login). Steps 1-2 replace it.

Notes on creating test files: a hook blocks shell commands that mention `.env`, `.pem` or `.key` names. Create such files with your editor, not with a shell command.

## Setup

1. Logged in to Claude Code; `CLAUDE_TOOLKIT_PATH` points at the `plugins/flow` folder (in `.env` at the project root copied from `.env.example`, or in the shell). `npm install`, then `npm run build` succeeds, then `npm run dev` (Electron with HMR; the production bundle is in `out/`).
2. Launch check: the terminal shows no error mentioning `settings:get`, `settings:set` or `app:info`. DevTools console: `Object.keys(window.api)` includes `settingsGet`, `settingsSet`, `appInfo`; no console errors.
3. Add a scratch git project (a copy of any small repo with a few commits and one uncommitted change). In it create, with your editor: `.env` (content `TOKEN=fake`), `.env.example` (content `TOKEN=`), `notes/hidden.pem` (content `fake`) and `docs/` (empty).

## Settings tab

4. Open the Settings tab of the project. Expect a Project section with: Model (Auto, Haiku, Sonnet, Opus), a Protected paths list pre-filled with `.env`, `.env.*`, `!.env.example`, `*.pem`, `*.key`, `.git/`, the toggles "Allow read-only git" and "Allow plan writes" (both off), and this text: "Protected paths block Read and direct access. Search tools are best-effort: Grep excludes matching files, but Glob can still list their names."
5. App section: toolkit path, status Valid and the plugin version from `.claude-plugin/plugin.json`. Stop the app, run with `CLAUDE_TOOLKIT_PATH` unset: status "Not set". Point it at an empty folder: status "Invalid". Restore it.
6. Change Model to Haiku and save. Expect a saved confirmation. Restart the app: the choice is still Haiku. No "new session" message appears (a resumed session honours model, tools and MCP changes, so `sessionReset` is always false for now).
7. Banner for storage-unavailable: stop the app, make the database unopenable (rename `claude-desk.db` in the app data folder `.../data/` and put a folder named `claude-desk.db` in its place), start the app. Expect: the app starts, Settings shows "Settings storage is unavailable. Safe defaults are in use.", saving fails with a storage-unavailable message, chat still works with the defaults. Undo the change afterwards.
8. Corrupt row (optional): with the app closed, set the row's `settings` column of `project_settings` to `{bad` using any SQLite tool. Expect the banner "Stored settings were unreadable. Safe defaults are in use until you save." and, after a save, no banner.

## Live runs

9. Model reaches a live run: with Model = Haiku, send "hi". In the Usage tab the run's model row shows a Haiku model. Set Model = Auto and send again: the main model is the Claude Code default again.
10. Git tools on: enable "Allow read-only git", save, send "show git status and the last 3 commits". Expect Activity rows for `mcp__git__git_status` and `mcp__git__git_log` (the model may call `ToolSearch` first to load them; that is allowed). Ask for "the unstaged diff": a `mcp__git__git_diff` row, a unified diff, no patch in `git_log`.
11. Git tools off: disable the toggle, save, send the same prompt. Expect no `mcp__git__*` row; Claude says it cannot run git (and any `Bash` attempt shows a "Denied" row).
12. Hostile repo check (git tools must not execute repo config): in a scratch clone, with the git tools on, add to `.git/config` a `[core]` entry `fsmonitor = <path to a script that writes a marker file>` and a `[diff]` entry `external = <same script>`. Ask for status and the diff. Expect the answer to arrive and the marker file NOT to exist. Remove the config entries afterwards.
13. Plan writes on: enable "Allow plan writes", save, send `/flow:plan add a hello function`. Expect the run to finish with a `Write` of `docs/plans/<slug>.md` (allowed row, file exists, slug lowercase with dashes). A `Write` to any other path (ask "write hello.txt") shows a "Denied" row and no file.
14. Plan writes off: disable it, save, send `/flow:plan add a hello function`. Expect a "Denied" `Write` row, no file under `docs/plans/`, and the plan text delivered in the chat instead.
15. Protected files: with the default list, ask "read .env". Expect a "Denied" row and no content. Ask "read .env.example": allowed, content `TOKEN=`. Remove `.env` from the list, save, ask again: it is readable on the next message (change applies to the next turn only; a run already in progress keeps the old list).
16. Grep best-effort: ask "grep for fake in the whole project" (the `.env` and `notes/hidden.pem` files both contain it). Expect Grep results that exclude the protected files. Ask "list every *.pem file": Glob may still show the name `notes/hidden.pem` (names can leak, content cannot); `Read` of it is denied.

## Phase 2 checks still open

17. SDK hooks inside subagents (`docs/notes/phase-2-manual-check.md` step 7, not yet verified live): with the default settings, prompt "Delegate to a subagent: have it run `echo hi` in a shell and report the output." Expect the subagent's Bash call to show a "Denied" row labelled with the subagent type. Then repeat with a protected file: "Delegate to a subagent: have it read .env" and expect a "Denied" Read row labelled with the subagent. If either runs, hooks do not fire inside Agent/Task subagents: stop and report it, because protected paths and the git capability gate would not cover subagents.
18. Run the remaining unchecked items in `docs/notes/phase-2-manual-check.md` (steps 8-10) if not done yet.
