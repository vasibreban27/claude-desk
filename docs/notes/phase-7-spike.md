# Phase 7 spike: workspace assistant (code-reading only, not run live)

Decisions
- cwd: an app-owned empty folder `<userData>/assistant` (created on demand). No project files, so nothing to read or leak.
- Tool limit: reuse the worker pattern (`tools: [...]` set to in-process MCP tools only plus deny-by-default PreToolUse guard). The chat runner today uses `allowedTools` + `buildHooks`/`guardPreToolUse` with `settingSources: []`; the assistant needs its own runner options (no Read/Write/Bash). Account `mcp__claude_ai_*` tools still appear and must be denied by the guard.
- Session: `session_id` comes from `extractSessionId` (first message), cost/usage from `parseResultMessage`; `resume` is supported. The assistant session is keyed by a fixed id (e.g. `assistant`) in ChatService, which currently requires a project path (`resolveProjectPath`) -> needs a project-less path (`projectId = null`).
- Hand-off: the new project session gets only `brief` (short string) as its first message, no history.

Open / to verify live
- `tools: []` plus an `mcpServers` in-process server (`createSdkMcpServer`) restricts the model as intended.
- Whether `plugins` should be loaded for the assistant (probably not).

Build order: projectsRoot setting -> `createProject` (validated, realpath-checked, git init) -> `create_project` pending tool + confirmation card -> chat with `projectId = null` -> hand-off.
