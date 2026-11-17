# Phase 4a spike (T1)

Live runs of `query()` from `@anthropic-ai/claude-agent-sdk` ^0.3.323 (Claude Code 2.1.326) with the existing login, `model: 'haiku'`, `settingSources: []`, temp dirs, scratch scripts outside the repo. Windows 11, git 2.55.0.windows.5, Node 24.21, npm 11.19. Toolkit plugin: the installed `flow` 0.7.0.

Windows trap seen again: `os.tmpdir()` returns an 8.3 short path (`SERGIU~1`); `fs.realpathSync` does not expand it, `fs.realpathSync.native` does. With the short form the CLI refused `Edit` ("suspicious Windows path pattern"). Worktree paths and `cwd` must be long, native-resolved paths (T5).

## 1. Run a session as the plugin agent `flow:node-developer`
- `options.agent: 'flow:node-developer'` (with `plugins: [{ type: 'local', path }]`) works: the init message lists `agents: [..., 'flow:node-developer', ...]` (init has no `agent` key) and the session answered in the agent's persona. The bare name `node-developer` also resolved.
- **Side effect that matters:** with `agent` set, the session's tool list became exactly the agent's frontmatter tools (`Read, Edit, Write, Grep, Glob`). An in-process MCP server passed in `mcpServers` was not usable: the model's `run_check` call returned `No such tool available`. So `agent` cannot be combined with the `work` MCP tools.
- Without `agent`, the init tool list is the full Claude Code set (including `PowerShell`, `Task`, `Skill`); `allowedTools: []` does not restrict it.
- **Decision (T7):** do not use `options.agent`. Use the worker prompt built by the app (`prompts.ts`), `plugins` loaded, and `tools: ['Read','Grep','Glob','Write','Edit']` (see section 7). Never redefine the toolkit agent. Optional later improvement: read the plugin's `agents/node-developer.md` body at run time and append it to the system prompt; not needed for 4a.

## 2. Caps: `maxTurns`, abort, time cap
- `maxTurns: 2` with a task needing 4 writes: two files were written, then a `result` message with `subtype: 'error_max_turns'`, `is_error: true`, `num_turns: 3`, `errors: ['Reached maximum number of turns (2)']`, empty `result`. After yielding it, the async iterator **throws** `Error: Claude Code returned an error result: Reached maximum number of turns (2)`. Partial files stay on disk; `session_id` is the same as in init and on the result message.
- `abortController.abort()` is **not prompt**: aborted after the 2nd tool call, the session kept going for 7 more writes (about 7 s) and then the iterator threw `Error: Operation aborted`. A 3 s timer abort did the same (the short task simply finished first). Do not rely on it as the only stop.
- `query.close()` stopped within about 2 s (one more file written), the loop ended **normally with no result message**.
- `query.interrupt()` stopped at once: `result` with `subtype: 'error_during_execution'`, `is_error: true`, then the iterator threw `Claude Code returned an error result: [ede_diagnostic] ...`.
- **Decision (T7):** cancel and time cap both call `query.close()` (and also abort the controller as a backup), set a flag (`cancelled` or `limit reached`) before closing so the runner can tell the cause, and treat "loop ended without a result message" as stopped-by-us. The time cap is a `setTimeout` (20 min, fake timers in tests) cleared in `finally`. The turn cap is `maxTurns: 40`; map `error_max_turns` (result message or the thrown error text) to `limit reached`. Always catch the throw that follows a result with `is_error`. Partial work stays in the worktree.

## 3. Two sessions with different `cwd` at once
Two `query()` calls (`Promise.all`), each writing one file in its own temp dir: both finished within 9 ms of each other (3836 / 3845 ms), each file in the right directory with the right content, no interference. One run only; this is input for 4c, not proof under load. **Decision:** serial in 4a; nothing blocks parallel sessions with distinct `cwd` in 4c.

## 4. Git argv against a hostile config (worktree, merge, commit, removal)
Temp repo with `core.hooksPath` pointing at a repo dir with hooks, default `.git/hooks` hooks (`post-checkout`, `pre-commit`, `commit-msg`, `post-commit`, `post-merge`, `pre-merge-commit`, `prepare-commit-msg`, `reference-transaction`), `core.fsmonitor`, and a filter driver (`.gitattributes` `*.txt filter=evil`, `filter.evil.clean|smudge|process`), all writing marker files.
- Control (plain `git worktree add -b`): markers written for `fsmonitor`, `filter-process`, `hooksPath-post-checkout`, `hooksPath-reference-transaction`.
- Hardened argv below, through the whole flow (rev-parse, 5 `worktree add`, 4 `add`, 4 `commit`, 3 `merge`, 1 conflicting `merge` + `merge --abort`, 5 `worktree remove`, 5 `branch -D`, `worktree prune`): **no marker**.
- Merge made by `ort`, merge commit author and committer `claude-desk <claude-desk@localhost>`, two parents; the integration tree held both tasks' files. The conflict merge exited non-zero; after `merge --abort` `status` was empty.

Prefix (before the subcommand) is the Phase 3 prefix (`docs/notes/phase-3-spike.md` section 4):
`--no-pager --no-lazy-fetch -c core.sshCommand= -c core.gitProxy= -c core.fsmonitor=false -c core.pager=cat -c core.hooksPath= -c diff.external= -c core.untrackedCache=false -c core.quotepath=false -c log.showSignature=false -c gpg.program= -c gpg.ssh.program= -c gpg.x509.program=`
then, for every call, the filter overrides from `git config --get-regexp -z "^filter\..*\.(clean|smudge|process)$"` (`-c filter.<n>.clean= -c filter.<n>.smudge= -c filter.<n>.process= -c filter.<n>.required=false`; fail closed on a bad name), then for commit and merge the identity `-c user.name=claude-desk -c user.email=claude-desk@localhost -c commit.gpgsign=false`.
Env additions: `GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_PAGER=cat GIT_EXTERNAL_DIFF= GIT_NO_LAZY_FETCH=1 GIT_LITERAL_PATHSPECS=1`.

Subcommands (after prefix + overrides; `cwd` shown):
- base hash: `rev-parse --verify --end-of-options <branch>^{commit}` (cwd project)
- integration worktree: `worktree add -b run/<runId8> <path> <baseHash>` (cwd project)
- task worktree: `worktree add -b task/<runId8>-<taskId> <path> run/<runId8>` (cwd project)
- add: `add -- <path>...` (cwd task worktree)
- commit: `commit --no-verify -m <message> --only -- <path>...` (cwd task worktree; HEAD checked first with `rev-parse --abbrev-ref HEAD`)
- merge: `merge --no-ff --no-verify -m <message> -- <taskBranch>` (cwd integration worktree)
- abort: `merge --abort` (cwd integration worktree)
- removal: `worktree remove --force -- <path>`, `branch -D -- <branch>`, `worktree prune` (cwd project)
- `--no-verify` is defence in depth on top of the empty `core.hooksPath`; both were set in the run.

`claude --worktree [name]` exists (Claude Code 2.1.326 CLI flag, also `--tmux`): it creates a worktree for an interactive session. No SDK option for it was confirmed. **Decision:** the app uses `git worktree` itself, because it needs a recorded base commit, a location outside the repo, a branch cut from the integration tip, the hardened argv and its own lifecycle (merge, remove, interrupted-run recovery).

## 5. `npm` on Windows (`execFile`)
- `execFile('npm', ['--version'])` fails: `ENOENT` (only `npm`, `npm.cmd` and a bash script exist, no `.exe`).
- `execFile('npm.cmd', ['--version'])` fails: `EINVAL` (Node refuses to spawn `.cmd`/`.bat` without a shell since the 2024 security fix).
- (a) `execFile(process.execPath, [<nodeDir>/node_modules/npm/bin/npm-cli.js, ...args])`: works, 1.5 s for `--version`; no shell at all; an argument `a&echo PWNED` reached npm verbatim.
- (b) `execFile('cmd.exe', ['/d','/s','/c','npm', ...args])`: works, similar time; Node quoted the `&` argument, but cmd.exe still expands `%VAR%` and `^` inside arguments, so any model-supplied argument would need a strict character whitelist.
- **Decision (T6):** (a). For a check whose `executable` is `npm` (or `npx`) on win32, run `node` plus the JS entry located next to the Node binary (`path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')`, `npx-cli.js` likewise), argument array unchanged; in packaged Electron `process.execPath` is Electron, so set `ELECTRON_RUN_AS_NODE=1` in that child's env (not exercised here, 4a runs from the dev tree and the live test). This keeps the "no shell strings" rule without exception. Any other executable runs directly with `execFile`; a `.cmd`/`.bat` executable is refused with a clear message ("use a node or exe command"). Do not use (b).

## 6. Dependencies in a fresh worktree
Measured with a `git clone --local` of this repo (no `node_modules`), `npm test -- src/shared/ipc.test.ts`:
- No install: fails at once (vitest not found, exit 1, about 1 s).
- Junction (`fs.symlinkSync(primary/node_modules, wt/node_modules, 'junction')`): created in 1 ms, tests passed (10/10, 2.4 s). Removing the junction with a non-recursive `fs.rmSync` left the primary `node_modules` intact. Risks: a check can write into the shared `node_modules` (caches), a junction makes `git worktree remove --force` and recursive deletes dangerous if they follow it (not tested; unlink the junction first), and the worker guard must keep denying paths through links.
- `npm ci --ignore-scripts --no-audit --no-fund`: **450 s (7.5 min)** for this repo, tests passed afterwards (10/10, 2.8 s). Safe from install scripts but too slow per task (a plan with 8 tasks would add about an hour) and needs network.
- **Decision (T5/T6):** junction by default, created by the worktree manager right after `createTaskWorktree` only when the primary checkout has a `node_modules` directory; removal (`removeTask`/`removeRun`) unlinks the junction first with a non-recursive `rmSync` and a test asserts the primary `node_modules` survives. If the primary has no `node_modules`, create nothing and let the check report the missing dependencies. No `npm ci` in 4a. Reason: 450 s per task is not acceptable; the junction risk is confined to files that `.gitignore` already excludes and that the user's own configured check writes.

## 7. Worker with no `Bash` (edit and test)
Session: `model: 'haiku'`, `tools: ['Read','Grep','Glob','Write','Edit']`, `allowedTools` = those plus `mcp__work__run_check`, `mcp__work__git_commit`, `mcp__work__report_blocked`, `permissionMode: 'acceptEdits'`, deny-by-default `PreToolUse` hook, a fake in-process `work` server, a one-line bug fix task.
- The `tools` option removes the other built-ins from the session entirely: init `tools` was `Edit, Glob, Grep, Read, Write, mcp__work__git_commit, mcp__work__report_blocked, mcp__work__run_check` (no `Bash`, `PowerShell`, `Task`, `Skill`, `ToolSearch`). The hook never saw `ToolSearch` here. Keep the guard deny-by-default anyway.
- Exact `tool_input` keys seen by the hook: `Read { file_path }`, `Edit { file_path, old_string, new_string, replace_all }`, `Write { file_path, content }`, `mcp__work__run_check { name }`, `mcp__work__git_commit { paths, message }`. `file_path` is absolute with backslashes on win32 (as in Phase 3).
- It finished: Read, Edit, `run_check` (passed), Write a new file, `git_commit`, 6 turns, about 11 s, 0.006 USD on haiku. No `Bash` needed. **Decision:** no narrow `Bash` allowlist.
- `permissionMode: 'acceptEdits'` was needed so Edit and Write are not blocked waiting for approval; the hook `allow` alone was not enough in the first run (that run also hit the 8.3 path issue, so treat `acceptEdits` plus the guard as the setup to use and re-check in T8's live run).

## Decision index
| Question | Decision |
|---|---|
| Run as plugin agent `flow:node-developer` | Works via `options.agent` but it restricts tools to the agent's list and hides MCP tools; do not use it. App-built worker prompt, `plugins` loaded, `tools: [Read,Grep,Glob,Write,Edit]` |
| `maxTurns` result | `result.subtype = 'error_max_turns'`, `is_error: true`, `num_turns` = cap + 1; the iterator throws afterwards; partial files kept; same `session_id` |
| Stopping a session | `abortController.abort()` is slow (kept working about 7 s); use `query.close()` (loop ends without a result) for cancel and time cap, abort as backup; flag the reason first |
| Time cap | `setTimeout` 20 min -> flag `limit reached` -> `close()`; cleared in `finally` |
| Concurrent sessions, different `cwd` | Ran at the same time without interference (one run); serial in 4a |
| Git argv | Section 4 (Phase 3 prefix, filter overrides, identity, `--no-verify`); no marker in the whole flow |
| `claude --worktree` | Exists as a CLI flag; app uses `git worktree` for control over base, location, branch and lifecycle |
| `npm` on Windows | `execFile('npm')` ENOENT, `npm.cmd` EINVAL; use (a) `node` + npm's JS entry; refuse `.cmd`; no `cmd.exe` |
| Worktree dependencies | Junction to the primary `node_modules` (1 ms), unlinked before removal; no `npm ci` (450 s) |
| `tool_input` keys | `Edit { file_path, old_string, new_string, replace_all }`, `Write { file_path, content }` |
| Narrow `Bash` allowlist | Not needed: the worker finished edit, check and commit without it |
