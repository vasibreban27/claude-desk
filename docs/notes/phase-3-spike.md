# Phase 3 spike (T1)

Live runs of `query()` from `@anthropic-ai/claude-agent-sdk` ^0.3.323 with the existing login, `model: 'haiku'` (one resume run used `sonnet`), `settingSources: []`, temp project dirs, scratch scripts outside the repo. Windows 11, git 2.55.

## 1. Write tool: path string and parent dirs
- The tool sends an **absolute** `file_path` built from the cwd with the platform separator, even when the prompt said `docs/plans/x.md`. Example: `C:\Users\...\p3w-xxxx\docs\plans\x.md` (backslashes on win32). `tool_input` keys seen: `file_path`, `content`.
- `Write` **creates missing parent directories** (`docs/` and `docs/plans/` did not exist).
- Without a deny-by-default hook the model prefers `PowerShell` (it is in the tool list; `allowedTools` only pre-approves). The guard must stay deny-by-default.
- Note: a cwd containing an 8.3 short name (`SERGIU~1`) made the CLI itself refuse a shell write ("suspicious Windows path pattern"); use real long paths.
- **Decision (T8):** accept `Write` only when the raw `file_path` equals the absolute form `path.join(cwd, 'docs', 'plans', '<slug>.md')` built from the exact `cwd` string (the relative form `docs/plans/<slug>.md` may also be accepted but was not observed). Because `Write` creates parents, the guard must lstat `docs` and `docs/plans` when they exist (real dirs, no links) and treat missing ones as fine.

## 2. Resume with changed options
Same `session_id` returned on resume. The `system:init` message of each run reports `model`, `tools`, `mcp_servers`.
- `model`: **honoured** on resume (haiku -> sonnet -> haiku, init and the answer matched). Side effect: the old history still contains the earlier model's system text, so the model may mention the conflict (cosmetic); prompt cache is lost (run cost ~0.10 USD vs ~0.001).
- `allowedTools`: **honoured** (an MCP tool allowed only in the resumed run ran without a prompt; removing it later removed it from use).
- `mcpServers`: **honoured** (server added on resume appears connected in init; removed on the next resume and gone from init).
- **Decision (T9/T4):** no session reset is needed for `model`, tools or MCP servers; `sessionReset` is always `false` for now. Keep the field in the contract and the rule function, so it can turn on if a later SDK version changes this.

## 3. In-process MCP server
- `createSdkMcpServer({ name: 't', ... })` + `tool('ping', ...)` with `settingSources: []`: final tool name `mcp__t__ping`; init shows `mcp_servers: [{ name: 't', status: 'connected', source: 'sdk' }]`.
- `allowedTools` needs the exact entry `mcp__<server>__<tool>` (the three git tools: `mcp__<server>__git_status`, `..._git_log`, `..._git_diff`).
- The `PreToolUse` hook **sees** the call: `tool_name: 'mcp__t__ping'`, `tool_input: { word: 'abc' }`. The model may call `ToolSearch` first to load the MCP tool (hook sees `ToolSearch` with `{ query, max_results }`); the guard must allow `ToolSearch`, or the model cannot find the tools. Allow it as read-only metadata (the app's current allowlist does not include it).
- **Decision (T6/T8):** server name `git`, tools prefixed `mcp__git__`; guard allows these three names plus `ToolSearch` only when `allowGitRead`.

## 4. Git argv against a hostile `.git/config`
Temp repo with `core.fsmonitor`, `diff.external`, a `diff.x.textconv` driver (via `.gitattributes`) and `core.pager` set to marker-writing commands. Control (naive `status`, `diff`, `log -p`): markers written for fsmonitor, ext-diff and textconv. With the argv below, **no marker** was written for any command, alone or all together.

Common prefix (before the subcommand): `--no-pager -c core.fsmonitor=false -c core.pager=cat -c core.hooksPath= -c diff.external= -c core.untrackedCache=false -c core.quotepath=false`
Env additions: `GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_PAGER=cat GIT_EXTERNAL_DIFF=` (empty).
- `git_status`: `status --short --porcelain=v1 --untracked-files=normal --no-renames`
- `git_log`: `log --no-patch --no-ext-diff --no-textconv --format=%h %ad %an %s --date=short -n <maxCount>` (the format is one argv element)
- `git_diff`: `diff --no-ext-diff --no-textconv --no-color --no-renames` (+ `--cached` when staged, then `--` and explicit pathspecs)
- name listing for filtering: `diff --name-only -z --no-ext-diff --no-textconv` (+ `--cached`)
- **Review findings (post-T6), all reproduced with marker files and fixed:**
  - Filter drivers: `.gitattributes` `* filter=evil` plus `filter.evil.clean=<cmd>` in `.git/config` runs `<cmd>` when `diff` (listing and diff) re-hashes modified files; `status` can too when index stat data is stale. `--no-ext-diff`/`--no-textconv` do not cover filters. Fix: before every run, `git config --get-regexp -z "^filter\..*\.(clean|smudge|process)$"` (executes nothing; exit 1 = none) and pass `-c filter.<name>.clean= -c filter.<name>.smudge= -c filter.<name>.process= -c filter.<name>.required=false` per name. Fail closed (tool refuses with a short error) if the listing fails or a name is not `[A-Za-z0-9_.-]+`. `core.attributesFile` only points at attributes (it can only select a filter or diff driver, both neutralized), so it needs no flag; tested.
  - `log.showSignature=true` + `gpg.program=<script>` runs the script for any commit with a `gpgsig` header (forgeable with `git hash-object -t commit`); `--no-patch`/`--format` do not stop it. Fix: `-c log.showSignature=false -c gpg.program= -c gpg.ssh.program= -c gpg.x509.program=` in the common prefix (empty program, nothing to spawn).
  - Submodules: `status`/`diff` descend into a submodule and honour its own config (its own filters are not in the parent listing). `-c` options propagate to the child, so fsmonitor was already blocked, but a submodule-local filter ran (control proven in the test). Fix: `--ignore-submodules=all` on status and diff. `diff.<driver>.command` is covered by `--no-ext-diff` plus `GIT_EXTERNAL_DIFF=`/`diff.external=`; tested.
  - Paths: status uses `--porcelain=v1 -z` (NUL separated, never quoted); porcelain paths are repo-root relative, so the project prefix from `rev-parse --show-prefix` is stripped, status is limited with `-- .`, and diff gets `--relative`.
- **Final argv.** Prefix = the common prefix above plus `-c log.showSignature=false -c gpg.program= -c gpg.ssh.program= -c gpg.x509.program=`, followed by the `-c filter.<name>.*=` overrides (all tools):
  - `git_status`: `rev-parse --show-prefix` (prefix only), then `status --porcelain=v1 -z --untracked-files=normal --no-renames --ignore-submodules=all -- .`
  - `git_log`: unchanged (`log --no-patch --no-ext-diff --no-textconv --format=%h %ad %an %s --date=short -n <maxCount> [-- <path>]`)
  - `git_diff` listing: `diff --name-only -z --relative --ignore-submodules=all --no-ext-diff --no-textconv [--cached] [-- <path>]`; diff: `diff --relative --ignore-submodules=all --no-ext-diff --no-textconv --no-color --no-renames [--cached] -- <files>`
  - Each tool run is preceded by the filter listing call (`<prefix> config --get-regexp -z ^filter\..*\.(clean|smudge|process)$`).
- **Decision (T6, superseded where the findings above differ):** use these, `execFile('git', args, { cwd, env, timeout, maxBuffer })`. Tests assert the argv. Not covered: the pager (not triggered without a tty; `--no-pager` set anyway) and `core.sshCommand`/network (no network subcommand is used).

## 5. Grep and Glob versus protected paths
Folder `src/` with a protected-style file `hidden.dat` and `ok.txt`, both containing the search word.
- Baseline: Grep returns lines from the protected file; Glob lists its name.
- **Grep mitigation works:** a `PreToolUse` hook returning `{ permissionDecision: 'allow', updatedInput: { ...input, glob: '!**/hidden.dat' } }` kept the file out of the results (ripgrep exclude glob). A multi-pattern glob string `*.dat *.txt !**/hidden.dat` also worked (space separated, exclusion wins), so an existing user `glob` can be kept by appending the exclusions.
- **Glob cannot be filtered:** `updatedInput` has no exclude; the protected file's **name** is listed (content is not exposed). No mitigation found.
- **Decision (T8):** for `Grep`, rewrite `glob` with one `!**/<pattern>` exclusion per protected pattern that converts to an rg glob (keep the user's glob first, space separated); deny when the target path itself is protected. `!` re-allow entries are not converted (stay excluded; safe direction). For `Glob`, deny a protected path or pattern prefix and accept that results may list protected file names.
- **UI wording (T7):** "Protected paths block Read and direct access. Search tools are best-effort: Grep excludes matching files, but Glob can still list their names."

## Decision index
| Question | Decision |
|---|---|
| Write path string | absolute, `path.join(cwd,'docs','plans',slug+'.md')`, backslashes on win32 |
| Write creates parents | yes; guard checks existing dirs, missing is fine |
| Resume honours model / allowedTools / mcpServers | yes / yes / yes; no session reset needed |
| MCP tool names | `mcp__git__git_status`, `mcp__git__git_log`, `mcp__git__git_diff`; hook sees `tool_input`; allow `ToolSearch` |
| Git argv | section 4; no marker written |
| Grep / Glob | Grep: `updatedInput` exclude globs; Glob: names may leak, best-effort wording above |
