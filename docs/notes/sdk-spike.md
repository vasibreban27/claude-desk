# SDK spike (T3)

Sources: code.claude.com Agent SDK docs (overview, typescript, streaming-output) plus a live run
of `query()` from `@anthropic-ai/claude-agent-sdk` ^0.3.323 with `ANTHROPIC_API_KEY` unset.

- **Auth:** works with the existing Claude Code login. A live run with no API key returned a
  `result` with `subtype: "success"`. The SDK spawns the bundled Claude Code binary, which reads
  the login itself. The app never reads, stores or logs a key.
  - Policy caveat: the docs say third parties may not offer claude.ai login or its rate limits in
    their products without approval, and point to API-key auth. This app is a personal tool, so it
    uses the login. Revisit before distributing it to anyone else.
- **cwd:** `options.cwd` (string, default `process.cwd()`). Set to the project path.
- **Local plugin:** `options.plugins: [{ type: 'local', path: '<absolute path>' }]`. The app passes
  `CLAUDE_TOOLKIT_PATH`. Not verified live that the `flow` skills load (no toolkit clone was used
  in the spike); the option shape is from the docs.
- **Model:** `options.model`, alias (`'haiku'`, `'sonnet'`, `'opus'`) or full name; default comes
  from the CLI. Phase 1 leaves it unset (CLI default).
- **Streaming:** set `options.includePartialMessages: true`. Message types seen live:
  `system:init`, `system:status`, `rate_limit_event`, `stream_event`, `assistant`, `result:success`.
  Text arrives as `stream_event` with `event.type === 'content_block_delta'` and
  `event.delta.type === 'text_delta'`, text in `event.delta.text`. `assistant` carries the whole
  block (ignored, it would duplicate the deltas). `result` ends the turn (`is_error`, `subtype`).
- **Continuity:** messages carry `session_id`; pass it as `options.resume` to continue a session.
- **Cancel:** `options.abortController`.
- **Safety:** Phase 1 passes `allowedTools: []`; tool-call display and permissions are out of scope.
