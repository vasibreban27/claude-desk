# Plan: Phase 3 - Project settings panel

Branch: `phase-3-project-settings` (never `main`; cut from `phase-2-tracking-usage` while PR #2 is open). Do not push and do not open a PR unless asked.

## 1. Goal

As the owner of claude-desk I want to set, per project, which model the chat uses, which paths the chat may not touch and which extra capabilities it has, so that the next run behaves the way I configured it.

Outcomes:
- A Settings tab in the workspace edits and saves four per-project settings in SQLite: model, protected paths, read-only git, plan writes.
- The next run uses the saved values: the model option is passed to the SDK, protected paths are denied by the `PreToolUse` guard, and the two toggles add exactly one capability each (default off).
- Broken or unreadable stored settings never loosen anything: the run uses the safe defaults and the UI shows a notice.
- The toolkit path (global, read-only) is shown in an "App" section with a valid/invalid status and the plugin version.

Done when (from the vision): changing a setting changes how the next run behaves.

## 2. Scope

In:
- Settings: `model` (Auto/Haiku/Sonnet/Opus), `protectedPaths` (gitignore-style list), `allowGitRead`, `allowPlanWrites`.
- Protected paths deny `Read`, `Grep`, `Glob` and the one allowed `Write` shape, matched on the resolved real path.
- `allowGitRead`: three in-process SDK MCP tools `git_status`, `git_log`, `git_diff`, no `Bash`.
- `allowPlanWrites`: the built-in `Write` allowed only for the exact shape `docs/plans/<slug>.md`.
- Storage: one new migration, `project_settings` with a JSON text column validated by a versioned zod schema.
- Read-only App section: toolkit path, status, `plugin.json` version.
- A spike (T1) that verifies the SDK and tool behaviour this design depends on before any guard code is written.

Out (do not build; later phases or separate plans):
- Push policy, merge policy, checks command, auto-fix rounds, parallel worktrees, which reviewers run, plans location (files/Linear). They have no consumer until Phase 4/5; their fields are added then (versioned schema).
- Cloning and pulling the toolkit, a toolkit source setting, a per-project trust setting for `settingSources` (Phase 6).
- `Edit`, `Bash` or any other tool. `write_plan` is not built. No planner pipeline, orchestrator or worktrees.
- Model choice for subagents: the setting applies to the main chat session only; toolkit agents keep their own model.
- Reviewers calling the git tools (see Risks and Follow-ups).

## 3. Architecture

Settings are one JSON object per project (`ProjectSettings`, `version: 1`), validated with zod at every boundary (IPC, DB read). Defaults: model `auto`, `protectedPaths` = the default list, both toggles `false`. The chat service reads the project's settings at the start of every turn and builds a per-turn `ToolPolicy`; the SDK options and the guard are derived from it. A change therefore applies to the next turn and never to a run in progress.

Fail closed: if the database is unavailable, the row is missing, or the JSON is invalid or fails the schema, the turn uses the safe defaults and `settings:get` returns a notice. A corrupt row is not overwritten until the user saves.

Protected paths use the `ignore` package (real gitignore semantics: no slash matches at any depth, `!` re-allows, order matters). The guard first resolves the target to its real path with the existing containment machinery, denies anything outside the project, then matches the real path relative to the real project root. Case-insensitive on win32 only. Default list:
`.env`, `.env.*`, `!.env.example`, `*.pem`, `*.key`, `.git/`.

Git tools: `createSdkMcpServer` with three tools run by the main process via `execFile` with fixed argument arrays and the config-execution paths disabled (exact flags set by T1). They also pass through the `PreToolUse` guard. `git_diff` and `git_status` omit protected files by listing names first, filtering them with the matcher, then diffing explicit pathspecs. `git_log` never emits patches. Output and time are capped.

Plan writes: the guard accepts `Write` only when the raw `file_path` string equals an accepted shape exactly (the relative `docs/plans/<slug>.md`, and the absolute form built from the exact `cwd` string if the spike shows the tool passes absolute paths), with `<slug>` matching `^[a-z0-9]+(-[a-z0-9]+)*$` (max 64). No normalisation, no lexical emulation: a string that does not match is denied. Then the filesystem checks: existing `docs` and `docs/plans` are real directories (not links) whose real path is inside the project, an existing target is a regular file, not a link, with `nlink === 1`; protected paths still apply; only the keys `file_path` and `content` are allowed and `content` is capped.

Sessions: when an option that the spike shows is not honoured on `resume` changes (model, tools or MCP servers), the next turn starts a fresh session instead of resuming. Protected paths live in hooks, which run per `query()` call, so they never need a reset.

Rejected: `Bash` with a git allowlist (config-execution on untrusted repos, reopens the audit surface); a `write_plan` MCP tool (makes `/flow:plan` prompt-dependent); `picomatch` (glob matcher, not gitignore semantics); one column per setting or one migration per setting (schema churn in Phase 4/5); storing the unused Phase 4/5 settings now (locks a schema for undesigned phases).

### API contract (IPC)

All in `src/shared/ipc.ts` (schema and defaults in `src/shared/settings.ts`, re-exported); channel names added to `IPC`; payloads validated with zod in the main handlers; `DeskApi` gains matching methods.

```
ProjectSettings = {
  version: 1,
  model: "auto" | "haiku" | "sonnet" | "opus",
  protectedPaths: string(1..200, no NUL)[]   // max 100 entries; may be empty
  allowGitRead: boolean,
  allowPlanWrites: boolean
}
DEFAULT_PROTECTED_PATHS = [".env", ".env.*", "!.env.example", "*.pem", "*.key", ".git/"]

settings:get   invoke
  req:  { projectId: uuid }
  res:  { ok: true, settings: ProjectSettings, notice: null | "defaults-applied" | "storage-unavailable" }
        | { ok: false, error: "not-found" }
  // no row -> defaults, notice null; invalid row -> defaults + "defaults-applied"; db down -> defaults + "storage-unavailable"

settings:set   invoke
  req:  { projectId: uuid, settings: ProjectSettings }
  res:  { ok: true, settings: ProjectSettings, sessionReset: boolean }
        | { ok: false, error: "invalid" | "not-found" | "storage-unavailable" }
  // sessionReset: the next message starts a new session (set only when an option the spike shows is not honoured on resume changed)

app:info       invoke
  req:  none
  res:  { toolkit: { status: "valid" | "invalid" | "unset", path: string | null, version: string | null } }
  // valid = directory exists and .claude-plugin/plugin.json (bounded read, 64 KiB) parses with a name; never throws
```

MCP tools (names finalised by T1, prefix `mcp__<server>__`), enabled only when `allowGitRead`:
```
git_status  {}                                   -> short status text, protected paths omitted (count reported)
git_log     { maxCount?: int 1..100, path?: string }  -> one-line entries, never patches
git_diff    { staged?: boolean, path?: string }       -> unified diff, protected paths omitted, output capped (200 KB)
  path: relative, checked by the same path and protected-path guard as Read
  errors: not a git repo | timeout | too many files | output truncated (stated in the text)
```

Tasks that touch the contract say `Contract: <channel or tool>`.

## 4. Changes per layer

- **API / IPC:** new channels `settings:get`, `settings:set`, `app:info` (`src/shared`, `src/main/ipc`, `src/preload`).
- **Service (main):** `src/main/chat/` gets the matcher, the git tools, the extended guard and per-turn policy; `service.ts` and `runner.ts` read settings per turn, pass `model`, tools and MCP servers, and apply the session-reset rule; `src/main/config.ts` gets the toolkit info reader.
- **Database:** migration 2 creates `project_settings (project_id TEXT PRIMARY KEY, settings TEXT NOT NULL, updated_at INTEGER NOT NULL)`; `SettingsStore` with parameterized statements and one transaction per write.
- **UI:** Settings tab with a project section (model, protected paths editor, two toggles, notice, best-effort note) and an App section (toolkit).
- **Dependencies:** `ignore` (pinned).

## 5. Risks

| Risk | Mitigation |
|---|---|
| Grep/Glob protected-path denial is best-effort: a Grep over a folder can return matching lines from a protected file inside it | T1 spike tests mitigations (`updatedInput`, ripgrep exclude globs). If none works, the guard denies what it can (path, glob prefix, Read) and the UI and notes say plainly that search tools are best-effort. Do not claim more. |
| Git executes code from an untrusted repo's `.git/config` (`core.fsmonitor`, pager, `diff.external`, textconv) | No `Bash`; fixed argument arrays, `-c` overrides and `--no-ext-diff --no-textconv --no-pager`, `GIT_OPTIONAL_LOCKS=0`; flags verified live in T1; tests assert exact argv. |
| `Write` guard bypass via links, junctions, hardlinks or odd path strings | Exact-shape raw-string match (a weird string simply does not match), link and `nlink` checks on the existing target and parent dirs, real-path containment; tests include a junction. |
| The `Write` tool may pass absolute paths, which a relative-only shape would always deny | T1 records the exact string the tool sends; the accepted shapes are finalised from that. |
| Settings read fails or JSON is corrupt and the run becomes more permissive | Fail closed to the safe defaults, notice in the UI, test for each failure mode. |
| `ignore` semantic gaps or an unmaintained package | T2 checks maintenance and pins the version; T5 tests the semantics that matter (`!.env.example`, `.git/`, nested `.env`, backslash paths, junction). |
| Resumed sessions ignore a changed `model`/tools/MCP option | T1 measures it; the reset rule only covers options that are not honoured. The UI tells the user the next message starts a new session and loses conversation context. |
| Toolkit reviewer agents have an explicit tool list (`Read`, `Grep`, `Glob`, `Bash`) and cannot call the MCP git tools, so `/flow:review` still cannot run `git diff` itself in the app | Not promised by this plan. Recorded as a toolkit follow-up; the git tools let the chat itself read and discuss status, history and diffs. |
| Live SDK checks cost tokens and need the login | Spike and manual checks are short, one run each. |

## 6. Test strategy

- **Unit (Vitest, next to source):** settings schema and defaults, `SettingsStore` against in-memory SQLite (get/set, invalid JSON, missing row, migration from version 1), `protectedPaths` matcher, git tools with a mocked `execFile` and temp repos, guard cases for `Write` shape, link and protected-path denials, toolkit info reader, session-reset rule, per-turn policy.
- **Component (Testing Library):** Settings tab with a mocked `window.api` (save, notice, sessionReset message, empty project state, App section states).
- **Integration:** `tests/phase-3-flow.test.ts` with in-memory DB and a mocked runner: saved settings change the next run's SDK options and guard; corrupt row falls back to defaults.
- **Manual (`docs/notes/phase-3-manual-check.md`):** live SDK checks that cannot be automated: model honoured, git tools through the real MCP path, `/flow:plan` finishing a plan with `Write`, Grep best-effort behaviour.
- **Deliberately not tested:** SDK internals, `ignore` beyond the cases we rely on, the toolkit reviewer agents, anything on Phase 4/5 settings.

## 7. Tasks

### Wave 1

### T1: Spike - SDK and tool behaviour the design depends on
- Status: [ ] todo
- Worker: node-developer
- Contract: none
- Owns: `docs/notes/phase-3-spike.md` (scratch scripts stay outside the repo)
- Depends on: none
- Acceptance criteria:
  - Given a live run with `allowPlanWrites` style `allowedTools: ['Write']` and a hook that logs `tool_input` When Claude is asked to write `docs/plans/x.md` Then the note records the exact `file_path` string sent (relative or absolute, separators) and whether `Write` creates missing parent directories.
  - Given a session started with one `model`, tool list and MCP server set When it is resumed with different values Then the note states per option (`model`, `allowedTools`, `mcpServers`) whether the resumed session honours the change.
  - Given an in-process server from `createSdkMcpServer` with a trivial tool When enabled with `settingSources: []` and the deny-by-default guard Then the note records the final tool names, the `allowedTools` entry needed, and that the `PreToolUse` hook sees the call with its `tool_input`.
  - Given a temp repo whose `.git/config` sets `core.fsmonitor`, `diff.external` and a textconv driver to a marker-writing command When the proposed fixed argv (`-c` overrides, `--no-ext-diff --no-textconv --no-pager`, `GIT_OPTIONAL_LOCKS=0`) runs `status`, `log` and `diff` Then no marker is written; the note lists the final argv per tool.
  - Given an ignored-style protected file (`.env`) in a folder When Grep or Glob targets the folder Then the note records whether `updatedInput` or ripgrep exclude globs keep the file out of results, and a decision: mitigation X, or best-effort with the exact wording for the UI.
  - Given the note When read Then every question above has a one-line decision that later tasks can cite.

### T2: Add the `ignore` dependency
- Status: [ ] todo
- Worker: node-developer
- Contract: none
- Owns: `package.json`, `package-lock.json`, `tests/ignore-smoke.test.ts`
- Depends on: none
- Acceptance criteria:
  - Given `npm view ignore` When the version is chosen Then it is pinned exactly (no range) and the commit message states the release date and that the package is still maintained.
  - Given the dependency When `npm run build` runs Then it succeeds and `ignore` is loadable from the main bundle.
  - Given `tests/ignore-smoke.test.ts` When it runs Then it shows `ignore().add(['.env', '.env.*', '!.env.example']).ignores('.env.local')` is true, `.env.example` is false, and `ignorecase: false` makes `.ENV` not match.
  - Given `npm install` on a clean checkout When `npm test` runs Then it passes with no manual step.

### T3: Settings schema and IPC contract
- Status: [ ] todo
- Worker: node-developer
- Contract: settings:get, settings:set, app:info
- Owns: `src/shared/settings.ts`, `src/shared/settings.test.ts`, `src/shared/ipc.ts`, `src/shared/ipc.test.ts`
- Depends on: none
- Acceptance criteria:
  - Given the schema When parsed with a valid object Then it passes; with `version` 2, an unknown `model`, a pattern of 201 chars, a NUL, more than 100 patterns or a non-boolean toggle Then it fails.
  - Given `parseSettingsOrDefaults(raw)` When `raw` is `undefined`, non-JSON, or fails the schema Then it returns the defaults and a flag saying which case; defaults are `auto`, `DEFAULT_PROTECTED_PATHS`, both toggles `false`.
  - Given `needsSessionReset(old, new)` When only `protectedPaths` changed Then false; the options that T1 will name are parameters of one small table in the file, defaulting to model, `allowGitRead`, `allowPlanWrites` until T1's findings narrow it.
  - Given `IPC` and `DeskApi` When read Then they contain `settings:get`, `settings:set` and `app:info` with request and response types matching the contract, and request payload schemas reject a non-uuid `projectId`.

### Wave 2

### T4: Migration 2 and SettingsStore
- Status: [ ] todo
- Worker: database-engineer
- Contract: none
- Owns: `src/main/db/migrations.ts`, `src/main/db/migrations.test.ts`, `src/main/db/settingsStore.ts`, `src/main/db/settingsStore.test.ts`, `src/main/db/index.ts`
- Depends on: T3
- Acceptance criteria:
  - Given a database at version 1 When `migrate` runs Then `project_settings` exists, `user_version` is 2 and existing `runs` data is untouched; running it again applies nothing.
  - Given `SettingsStore.get(projectId)` When no row exists Then it returns the defaults with notice `null`; When the stored JSON is invalid or fails the schema Then the defaults with notice `defaults-applied` and the row is left unchanged.
  - Given `SettingsStore.set(projectId, settings)` When called Then it upserts in one parameterized transaction, rejects a value that fails the schema without touching the row, and a thrown SQLite error returns `storage-unavailable` instead of throwing.
  - Given a store created without a database (open failed) When `get` is called Then it returns defaults with notice `storage-unavailable` and `set` returns `storage-unavailable`.

### T5: Protected-path matcher
- Status: [ ] todo
- Worker: node-developer
- Contract: none
- Owns: `src/main/chat/protectedPaths.ts`, `src/main/chat/protectedPaths.test.ts`
- Depends on: T2
- Acceptance criteria:
  - Given `createProtectedMatcher(patterns, { realRoot, platform })` When `isProtected(realTarget)` runs with the default list Then `.env`, `.env.local`, `a/b/.env`, `x.pem`, `k.key`, `.git`, `.git/config` are protected and `.env.example`, `src/env.ts` are not.
  - Given a target outside `realRoot` When checked Then the matcher reports it as outside (the caller denies); it never calls `ignore` with a `..` or absolute path (the package throws on those).
  - Given win32 When the target is `A/.ENV` and backslashes are used Then it is protected; on posix `A/.ENV` is not.
  - Given an empty pattern list When checked Then nothing is protected; a pattern list with an invalid entry is handled without throwing and fails closed (the matcher treats the whole list as unusable and the caller falls back to the defaults).
  - Given a junction or symlink inside the project pointing at a protected file (skipped with `ctx.skip()` on `EPERM`/`EACCES`/`ENOSYS`) When the caller passes the real path Then it is protected.

### T6: Git MCP tools
- Status: [ ] todo
- Worker: node-developer
- Contract: git_status, git_log, git_diff
- Owns: `src/main/chat/gitTools.ts`, `src/main/chat/gitTools.test.ts`
- Depends on: T1
- Acceptance criteria:
  - Given the argv decisions in `docs/notes/phase-3-spike.md` When any tool runs Then `execFile` is called with that exact fixed argument array, `cwd` set to the project, a 10 s timeout and an output cap; no shell is used and user input only appears as a validated `--` pathspec.
  - Given `git_diff` in a temp repo with a modified `.env` and a modified `a.txt` When the protected-file filter is applied Then only `a.txt` is diffed and the text says one protected file was omitted.
  - Given `git_log` with `maxCount: 500` or a non-integer Then it is rejected; with valid input the format is one line per commit and `--no-patch`/no `-p` is always present.
  - Given a directory that is not a git repo, a timeout, and output above the cap When called Then each returns a short error or a truncation marker, never throws.
  - Given a `path` argument When it contains `..`, is absolute or starts with `-` Then it is rejected before `execFile` runs.

### T7: Settings tab (renderer)
- Status: [ ] todo
- Worker: frontend-developer
- Contract: settings:get, settings:set, app:info
- Owns: `src/renderer/src/components/Settings/`, `src/renderer/src/hooks/useSettings.ts`, `src/renderer/src/components/Workspace/Workspace.tsx`, `src/renderer/src/components/Workspace/workspace.css`, `src/renderer/src/App.tsx`
- Depends on: T3
- Acceptance criteria:
  - Given the workspace When rendered Then a third tab "Settings" exists, follows the same tab keyboard and aria pattern as the other two, and the stored tab key accepts it.
  - Given a selected project and a mocked `window.api` When the tab opens Then it loads the settings and shows: model select (Auto/Haiku/Sonnet/Opus), a protected-paths textarea (one pattern per line, empty allowed), the two toggles (both off by default) each with a one-line explanation, and a Save button.
  - Given edited values When Save is clicked Then `settings:set` is called once with the parsed object; on `ok: true` the saved values are shown, and when `sessionReset` is true a visible message says the next message starts a new session and loses conversation context; on `invalid` or `storage-unavailable` an error is shown and the form keeps its values.
  - Given `notice` `defaults-applied` or `storage-unavailable` When loaded Then a banner says safe defaults are in use.
  - Given the protected-paths field When shown Then a note states plainly that search tools (Grep, Glob) are best-effort, with the exact wording decided in T1.
  - Given no selected project When the tab opens Then an empty state is shown and `settings:get` is not called; switching projects loads that project's settings and never shows the previous project's values.
  - Given `app:info` When loaded Then an App section shows the toolkit path read-only, a valid/invalid/unset status and the plugin version when known.

### Wave 3

### T8: Guard policy - protected paths, git tools, plan writes
- Status: [ ] todo
- Worker: node-developer
- Contract: git_status, git_log, git_diff
- Owns: `src/main/chat/tools.ts`, `src/main/chat/tools.test.ts`
- Depends on: T1, T5, T6
- Acceptance criteria:
  - Given `guardPreToolUse(input, cwd, policy)` with no policy argument When called Then behaviour is identical to Phase 2 (the existing tests pass unchanged), except the default protected list now applies.
  - Given a policy with the default protected list When `Read` targets `.env`, `a/.env.local`, `k.pem`, `.git/config` or a link whose real path is protected, `Grep`/`Glob` use a protected path or a literal glob prefix that is protected Then each is denied; `.env.example` is allowed; targets outside the project still get the existing denial first.
  - Given `allowGitRead` is false When a git tool is called Then it is denied; when true Then the three tool names are allowed, their `path` argument goes through the same path and protected-path checks, and any other MCP tool is still denied.
  - Given `allowPlanWrites` is false When `Write` is called Then it is denied; when true Then only the exact accepted shapes from the spike are allowed with a slug matching `^[a-z0-9]+(-[a-z0-9]+)*$` (max 64).
  - Given `allowPlanWrites` is true When `Write` gets `docs/plans/../x.md`, `docs/plans/x.md.`, `docs\plans\x.md`, `./docs/plans/x.md`, a different case, `docs/plans/sub/x.md`, a non-`.md` name, an extra input key, or `content` above the cap Then each is denied with 0 filesystem calls (asserted with the fs spy).
  - Given `allowPlanWrites` is true and an exact-shape path When `docs` or `docs/plans` is a link or junction, the target is a link, a hardlink (`nlink > 1`) or a directory, or the parent's real path is outside the project (link cases skipped with `ctx.skip()` on `EPERM`/`EACCES`/`ENOSYS`) Then `Write` is denied; When the folders do not exist yet or the target is a new file or an existing regular file Then it is allowed; a protected pattern matching the target denies it.
  - Given a malformed policy or any thrown error When the guard runs Then it still returns a deny and never throws.

### Wave 4

### T9: Runner and service - per-turn settings, model, tools, session rule
- Status: [ ] todo
- Worker: node-developer
- Contract: none
- Owns: `src/main/chat/runner.ts`, `src/main/chat/runner.test.ts`, `src/main/chat/service.ts`, `src/main/chat/service.test.ts`
- Depends on: T4, T6, T8
- Acceptance criteria:
  - Given the service has a settings reader dependency (`SettingsReader.get(projectId)` returning settings plus notice) When a turn starts Then settings are read once for that turn; a thrown reader or an invalid result uses the safe defaults and the turn still runs.
  - Given `model` `haiku`, `sonnet` or `opus` When the turn runs Then the SDK `query()` options contain that alias; with `auto` they contain no `model` key.
  - Given `allowGitRead` and `allowPlanWrites` When each is on Then `allowedTools` and `mcpServers` contain exactly that capability (`Write`, or the git server and its three tool names) and nothing else is added; with both off the options equal Phase 2's.
  - Given the policy When hooks are built Then the guard receives the per-turn policy and protected matcher, and a protected path is denied in the same run it was configured for.
  - Given a project whose stored session id exists When an option that the spike shows is not honoured on resume changed since that session started Then `resume` is omitted and a new session starts; when only protected paths changed Then `resume` is kept.
  - Given settings change while a run is in progress When the run continues Then it keeps the settings it started with; the next turn uses the new ones.

### Wave 5

### T10: IPC handlers, preload bridge, toolkit info and bootstrap
- Status: [ ] todo
- Worker: node-developer
- Contract: settings:get, settings:set, app:info
- Owns: `src/main/ipc/handlers.ts`, `src/main/ipc/handlers.test.ts`, `src/main/ipc/register.ts`, `src/main/ipc/register.test.ts`, `src/preload/index.ts`, `src/main/config.ts`, `src/main/config.test.ts`, `src/main/index.ts`
- Depends on: T3, T4, T9
- Acceptance criteria:
  - Given `settings:get` and `settings:set` When called with a non-uuid, an unknown project, or an invalid settings object Then the handler validates the payload and returns `invalid` / `not-found` without touching the store; a valid call round-trips through `SettingsStore`.
  - Given `settings:set` changes only an option that needs a session reset When it succeeds Then `sessionReset` is true; when only `protectedPaths` changed Then false.
  - Given the database failed to open at startup When the app boots Then the store is created in unavailable mode, the app still starts, runs use the safe defaults, `settings:get` returns notice `storage-unavailable` and the Settings tab shows the banner.
  - Given `app:info` When `CLAUDE_TOOLKIT_PATH` is unset, points to a missing folder, a folder with a missing, oversized (> 64 KiB) or unparsable `plugin.json`, or a good plugin Then the status is `unset`, `invalid`, `invalid`, `valid` with the version respectively, the read is bounded, and it never throws or exposes file contents other than the version.
  - Given the preload When inspected Then `window.api` exposes `getSettings`, `setSettings` and `getAppInfo` only through `contextBridge`, matching `DeskApi`, and the existing preload bundle test still passes.

### Wave 6

### T11: Smoke - settings change the next run, end to end
- Status: [ ] todo
- Worker: node-developer
- Contract: settings:get, settings:set, app:info
- Owns: `tests/phase-3-flow.test.ts`, `docs/notes/phase-3-manual-check.md`
- Depends on: T7, T10
- Acceptance criteria:
  - Given the real IPC handlers, an in-memory database and a mocked runner When `settings:set` saves `model: "haiku"` and `allowGitRead: true` and a chat turn is sent Then the runner receives the `haiku` option and the git server, and with both off it receives neither.
  - Given a saved protected-paths list When the guard is exercised through the same service path with `Read` on `.env` and on `.env.example` Then the first is denied and the second is allowed in that turn.
  - Given a corrupt `project_settings` row When a turn is sent Then it runs with the safe defaults and `settings:get` reports `defaults-applied`.
  - Given the app is built and launched (`npm run build`, then start) When the main process starts Then no error is logged for the new channels and `window.api` has the three new methods (checked by the existing launch approach or the manual steps below).
  - Given `docs/notes/phase-3-manual-check.md` When read Then it lists exact steps and expected results for: the model option reaching a live run, the git tools in a live chat, `/flow:plan` finishing with `Write` when `allowPlanWrites` is on and being denied when off, the protected `.env` being refused by `Read`, the Grep best-effort behaviour found in T1, and the session-reset message.

## 8. Wave summary

| Wave | Tasks | Parallel |
|---|---|---|
| 1 | T1, T2, T3 | yes: docs only, dependency files only, `src/shared` only |
| 2 | T4, T5, T6, T7 | yes, disjoint: `src/main/db`, two new files in `src/main/chat`, `src/renderer` (built against the contract with a mocked `window.api`) |
| 3 | T8 | single task: owns `tools.ts` |
| 4 | T9 | single task: owns `runner.ts` and `service.ts` |
| 5 | T10 | single task: IPC, preload, config, bootstrap |
| 6 | T11 | smoke |

Workers: `node-developer` for T1-T3, T5, T6, T8-T11 (`src/main`, `src/preload`, `src/shared`, tests); `frontend-developer` for T7 (`src/renderer`); `database-engineer` for T4 (migration and SQL). Commits: Conventional Commits with the task id, for example `feat(settings): store per-project settings in SQLite (T4)`.

## 9. Follow-ups

- Toolkit (separate repo): the `reviewer` agent has an explicit tool list (`Read`, `Grep`, `Glob`, `Bash`), so it cannot use the in-process git tools and `/flow:review` cannot run `git diff` itself inside the app. Either let the main thread pass the diff in the reviewer's prompt (small toolkit change) or leave reviewers to Phase 5, where the app runs them. Not promised by Phase 3.
