# Plan: Phase 1 - App skeleton

Source: `docs/vision.md`, Phase 1. Nothing beyond this phase is planned here.

## 1. Goal

As the owner I want a desktop window where I add a project folder and chat with Claude about it, so that I have the base the later phases (tracking, settings, pipeline) build on.

Outcomes:
- The app starts with three panels: projects (left), workspace (middle, placeholder), chat (right).
- "Add project" opens a folder picker, rejects non-git folders, and lists the project with its git branch and clean/dirty status. The list survives a restart.
- Selecting a project and sending a message streams a reply from one Agent SDK session whose `cwd` is that project, with the `claude-toolkit` plugin loaded from a local path.
- Switching projects switches chats. Chat history is **in-memory only in Phase 1**: it is lost when the app closes (persistence arrives with SQLite in a later phase).

## 2. Scope

In:
- electron-vite scaffold, strict TypeScript, lint, typecheck, Vitest.
- Typed IPC (one definition file), preload bridge, validated handlers.
- Git status reader, JSON project store behind an interface.
- Agent SDK session service, one session per project, text-only streaming.
- Three-panel layout, project list with "Add project", chat panel.
- SDK verification spike with short notes in `docs/notes/sdk-spike.md`.

Out (do not build):
- SQLite / `better-sqlite3`, hooks, tool-call display, activity feed, usage and cost, per-project settings, worktrees, the pipeline, packaging and installers.
- The app cloning or pulling the toolkit (Phase 3 "toolkit source" setting).
- Persisting chat history.
- API-key handling (auth is the existing Claude Code login).

## 3. Architecture

Chosen: approach B.
- **Scaffold:** electron-vite, with the folders `src/main`, `src/preload`, `src/renderer`, `src/shared` from `CLAUDE.md`.
- **Auth:** the SDK reuses the existing Claude Code login. No key is read, stored or logged. The spike (T3) confirms this works from the SDK before the service is built.
- **Toolkit:** `CLAUDE_TOOLKIT_PATH` env var names a local clone, passed to the SDK as a local plugin. `.env.example` holds a placeholder, never a real path.
- **Projects:** `ProjectStore` interface with a JSON file implementation in Electron `userData`. Phase 2/3 replace the implementation with SQLite; UI and IPC do not change.
- **Chat:** main process keeps `Map<projectId, ChatSession>`. The renderer never sees raw SDK objects, only the typed events below.
- **Boundaries:** every IPC payload, the JSON file and git process output are validated (zod) then typed.

Rejected: A (in-memory project list, feels broken on restart); C (SQLite now, pulls the native-module rebuild into the skeleton phase); Electron Forge and hand-rolled builds (more setup for no Phase 1 gain).

### IPC contract (defined in T1, implemented by T5, consumed by T6)

All channels and types live in `src/shared/ipc.ts`.

```
Project = { id: uuid, path: string(abs), name: string, branch: string|null, dirty: boolean, addedAt: ISO-8601 }
  branch is null on a detached HEAD; works in a repo with no commits (unborn branch name).
ChatMessage = { id: string, role: "user"|"assistant", text: string, at: ISO-8601 }

projects:list           invoke  req: none
  -> Project[]
projects:pick-and-add   invoke  req: none   (opens the folder picker in main)
  -> { ok: true, project: Project }
   | { ok: false, error: "cancelled" | "not-a-git-repo" | "duplicate" | "unreadable" }
projects:refresh        invoke  req: { id: uuid }
  -> { ok: true, project: Project } | { ok: false, error: "not-found" | "unreadable" }
chat:history            invoke  req: { projectId: uuid }
  -> ChatMessage[]                  (in-memory, empty after restart)
chat:send               invoke  req: { projectId: uuid, text: string(1..20000) }
  -> { ok: true, turnId: string } | { ok: false, error: "not-found" | "busy" | "invalid" }
  busy = a turn is already running for that project.
chat:event              main -> renderer (webContents.send)
  { projectId, turnId, type: "text-delta", text: string }
  { projectId, turnId, type: "done" }
  { projectId, turnId, type: "error", message: string }   (message never contains secrets or env values)
```

The preload exposes this as a minimal typed `window.api` (`contextIsolation: true`, `nodeIntegration: false`).

## 4. Changes per layer

- **Main (`src/main`):** window creation, git status service, project store, chat session service, config (env), IPC handlers.
- **Preload (`src/preload`):** typed `contextBridge` API.
- **Shared (`src/shared`):** IPC channel names, payload and event types, zod schemas.
- **Renderer (`src/renderer`):** three-panel layout, projects panel, chat panel, IPC hook.
- **Database:** none (JSON file store only).
- **API / network:** none beyond the SDK's own calls.
- **Docs:** `docs/notes/sdk-spike.md` (new), `CLAUDE.md` Commands section filled in, `.env.example`.

## 5. Risks

| Risk | Mitigation |
|---|---|
| SDK may not accept the Claude Code login, or local-plugin / `cwd` options differ from the docs (open questions 1 and 2) | T3 starts with a spike and writes findings to `docs/notes/sdk-spike.md`. If login auth does not work, T3 stops and reports instead of switching to an API key silently. |
| Unborn branch or detached HEAD breaks branch detection (this repo itself has no commits) | Use `git symbolic-ref --short HEAD` with a fallback to null; tested in T2 against a fresh `git init` repo. |
| Path or folder-picker input is hostile or not a repo | Validate in main, run git with `execFile` + argument array, `cwd` set, timeout, non-zero exit handled. |
| Two sends to one project interleave | Per-project `busy` state; second send returns `busy`. |
| Windows paths in the project list (duplicates by case or slashes) | Normalize with `path.resolve` and compare case-insensitively on win32. |
| Secrets leak through error messages | `chat:event` error text is a sanitized message; no env values logged. |

## 6. Test strategy

- **Unit (Vitest, main and shared):** git status against temp repos (clean, dirty, detached, no commits, not a repo); `ProjectStore` against a temp dir (round trip, corrupt file, duplicate); zod schemas (valid and invalid payloads); session service with the SDK mocked (streams deltas, `done`, `error`, `busy`, `cwd` and plugin path passed).
- **Component (Testing Library):** layout renders three panels; projects panel shows list, branch and dirty badge, and each add-error; chat panel shows streamed text, disabled input while busy, and an error.
- **Integration (T7):** main-side flow in a temp git repo: add project, list, send a chat message with the SDK mocked, history returned.
- **Manual (not automated):** the real end-to-end chat against the live SDK and login. Run `npm run dev`, add a project, send a message, confirm a reply streams. This is the phase's "done when".
- **Deliberately not tested:** Electron window and native folder dialog rendering, the real SDK network call, visual styling.

## 7. Tasks

Verification runs after each wave.

### Wave 1: foundation

### T1: Scaffold, zod, shared IPC types and schemas, CLAUDE.md commands
- Status: [x] verified
- Worker: node-developer
- Contract: IPC contract (all channels; T1 defines it in `src/shared/ipc.ts`)
- Owns: `package.json`, lockfile, `electron.vite.config.ts`, `tsconfig*.json`, ESLint config, `vitest.config.ts`, `.gitignore`, `.env.example`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/src/main.tsx`, `src/renderer/src/App.tsx` (stub only), `src/shared/**`, `CLAUDE.md` (the "Commands" section only)
- Depends on: none
- Note: this is the largest task. Make two commits: the scaffold first, then the shared types and the CLAUDE.md commands.
- Acceptance criteria:
  - Given a fresh checkout When `npm install` then `npm run typecheck` Then it exits 0 under `strict: true`.
  - Given the scaffold When `npm run lint` and `npm test` Then both exit 0 (at least one passing placeholder test).
  - Given the scaffold When `npm run build` Then it exits 0 and produces main, preload and renderer bundles.
  - Given `src/main/index.ts` When the window is created Then `webPreferences` has `contextIsolation: true` and `nodeIntegration: false` (asserted by a test of the window options).
  - Given `.env.example` When read Then it contains `CLAUDE_TOOLKIT_PATH=<absolute path to your claude-toolkit clone>` as a placeholder and no real path or secret.
  - Given `package.json` When read Then it has dependencies `zod`, `@anthropic-ai/claude-agent-sdk`, `react`, `react-dom`, `electron`, and dev dependencies for `vitest`, `@testing-library/react`.
  - Given `.gitignore` When read Then it ignores `node_modules`, `out`, `dist` and `.env`.
  - Given `src/shared/ipc.ts` When imported Then it exports channel-name constants, `Project`, `ChatMessage`, request/response types, the `ChatEvent` union and the `window.api` interface exactly as in the contract.
  - Given each request schema When given a valid payload Then it parses; When given an invalid one (bad uuid, empty text, text over 20000 chars, wrong shape) Then it rejects.
  - Given `chat:send` text of exactly 20000 characters Then it is accepted; 20001 is rejected.
  - Given the shared module When searched Then it contains no `any` and no Node or Electron imports.
  - Given `CLAUDE.md` When read Then its Commands section lists accurate `install`, `dev`, `build`, `typecheck`, `lint`, `test` and single-test commands. Each was run once by the worker, except `dev`, which is checked by the script existing in `package.json` and matching the documented command.

### Wave 2: services and layout (parallel, no shared files)

### T2: Git status service and project store
- Status: [ ] todo
- Worker: node-developer
- Contract: `Project`, `projects:*` semantics
- Owns: `src/main/git/**`, `src/main/projects/**`
- Depends on: T1
- Acceptance criteria:
  - Given a temp repo with commits and no changes When status is read Then `branch` is the branch name and `dirty` is false.
  - Given a temp repo with an untracked or modified file When status is read Then `dirty` is true.
  - Given a detached HEAD When status is read Then `branch` is null.
  - Given a fresh `git init` repo with no commits When status is read Then it succeeds with the unborn branch name.
  - Given a folder that is not a git repo When status is read Then it returns the `not-a-git-repo` error, not a throw.
  - Given the git service When it spawns git Then it uses `execFile` with an argument array, a `cwd` and a timeout (asserted in a test with a mocked child process).
  - Given `ProjectStore` When a project is added, then the store is re-opened from the same directory Then the project is listed.
  - Given a path already stored (same folder, different case or slashes on win32) When added Then it returns `duplicate`.
  - Given a corrupt JSON file When the store opens Then it starts empty and keeps a `.bak` copy of the bad file rather than crashing.

### T3: SDK verification spike and chat session service
- Status: [ ] todo
- Worker: node-developer
- Contract: `chat:send`, `chat:history`, `chat:event` semantics
- Owns: `docs/notes/sdk-spike.md`, `src/main/chat/**`, `src/main/config.ts`
- Depends on: T1
- Acceptance criteria:
  - Given the task start When the spike runs against the current official SDK docs and a tiny script Then `docs/notes/sdk-spike.md` exists, is under 60 lines, and states for each: how auth via the existing Claude Code login works (or does not), how `cwd` is set, how a local plugin path is passed, how to select a model, and what the streamed message types are.
  - Given the spike finds login auth does not work from the SDK When detected Then the worker stops, records it in the notes and reports to the user instead of switching to an API key.
  - Given `config.ts` When `CLAUDE_TOOLKIT_PATH` is unset or the path does not exist Then it returns a clear typed config error and the chat error event says so, with no env values in the message.
  - Given a mocked SDK When a message is sent for a project Then the session starts with `cwd` equal to the project path and the toolkit path loaded as a plugin.
  - Given a mocked SDK stream When it yields text Then `text-delta` events are emitted in order, followed by one `done`; When it throws Then one `error` event with a sanitized message is emitted and the session can be used again.
  - Given a running turn When a second send arrives for the same project Then it returns `busy`.
  - Given two projects When each has a conversation Then `chat:history` returns only that project's messages, and history is empty on a new service instance (in-memory only).

### T4: Three-panel layout
- Status: [ ] todo
- Worker: frontend-developer
- Contract: none
- Owns: `src/renderer/src/App.tsx`, `src/renderer/src/components/Layout/**`, `src/renderer/src/styles/**`
- Depends on: T1
- Acceptance criteria:
  - Given the app renders When inspected in a component test Then three landmarks exist in order: projects (left), workspace (middle), chat (right), each with an accessible name.
  - Given the layout When the window is narrower than 900px Then no panel is hidden and the page does not scroll horizontally (asserted with a style or class test, not a screenshot).
  - Given the workspace panel When nothing is selected Then it shows a placeholder text (for example "Runs, activity and usage will appear here").
  - Given the layout components When read Then they take their content as props or slots, with no data fetching.

### Wave 3: IPC and wiring (parallel, both against the IPC contract)

### T5: IPC handlers and preload bridge
- Status: [ ] todo
- Worker: node-developer
- Contract: all channels in the IPC contract
- Owns: `src/main/ipc/**`, `src/main/index.ts`, `src/preload/index.ts`
- Depends on: T1, T2, T3
- Acceptance criteria:
  - Given a handler When it receives an invalid payload Then it returns the contract's error (or `invalid`) and never throws to the renderer.
  - Given `projects:pick-and-add` When the picker is cancelled Then it returns `cancelled`; When a git repo is chosen Then it returns the project with branch and dirty; When a non-repo is chosen Then it returns `not-a-git-repo`.
  - Given `projects:refresh` for an unknown id When called Then it returns `not-found`.
  - Given `chat:send` When accepted Then `chat:event` messages reach the sender's window only, tagged with `projectId` and `turnId`.
  - Given the preload script When inspected Then it exposes only the `window.api` methods in the contract through `contextBridge`, with no `ipcRenderer` object leaked.
  - Given handlers are tested with the folder dialog, store, git service and chat service mocked When run Then all contract success and error paths pass.

### T6: Renderer wiring: projects panel and chat panel
- Status: [ ] todo
- Worker: frontend-developer
- Contract: all channels in the IPC contract (via `window.api`)
- Owns: `src/renderer/src/components/Projects/**`, `src/renderer/src/components/Chat/**`, `src/renderer/src/hooks/**`, `src/renderer/src/App.tsx`
- Depends on: T1, T4
- Acceptance criteria:
  - Given `window.api` mocked When the app loads Then `projects:list` is called and each project shows name, branch (or "detached") and a clean/dirty badge.
  - Given "Add project" is clicked When the result is `ok` Then the project appears and is selected; When `cancelled` Then nothing changes; When `not-a-git-repo`, `duplicate` or `unreadable` Then a distinct readable message is shown.
  - Given a project is selected When it is clicked Then `projects:refresh` runs and its status updates, and `chat:history` loads that project's messages.
  - Given a message is sent When `text-delta` events arrive Then the assistant text grows in place; on `done` input is re-enabled; on `error` the message is shown and input is re-enabled.
  - Given no project is selected When the chat panel renders Then the input is disabled with a hint to add or select a project.
  - Given events for another project's `projectId` When they arrive Then they do not appear in the current chat.

### Wave 4: end-to-end check and docs

### T7: Main-side integration test and manual check note
- Status: [ ] todo
- Worker: node-developer
- Contract: all channels in the IPC contract
- Owns: `tests/integration/**`, `CLAUDE.md` (the "Stack and layout" section only), `docs/notes/phase-1-manual-check.md`
- Depends on: T5, T6
- Acceptance criteria:
  - Given a temp git repo and the SDK mocked When the integration test adds the project, lists it, sends a message and reads history Then the project has the right branch and dirty state, the stream emits deltas then `done`, and history holds both messages.
  - Given the `CLAUDE.md` "Stack and layout" section When read Then it matches the folders that now exist and no longer says the scaffold is undecided (electron-vite).
  - Given `docs/notes/phase-1-manual-check.md` When read Then it lists the manual steps to confirm "done when" (set `CLAUDE_TOOLKIT_PATH`, `npm run dev`, add a project, chat) in under 15 lines.
  - Given the full set When `npm run typecheck && npm run lint && npm test && npm run build` runs Then all exit 0.

## Done when (from the vision)

I can add a project and chat with Claude about it from inside the app. Automated checks cover everything except the live SDK call; the manual check in T7 covers that.
