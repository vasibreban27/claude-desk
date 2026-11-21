# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

claude-desk is a desktop control panel (Electron + React + TypeScript strict) for a personal agentic workflow. It orchestrates and observes Claude Code agents; it does not implement agent logic. Three-panel UI: projects (left), workspace (middle), chat (right).

## Working with docs/vision.md

Plans live in `docs/plans/`.

- Read the **Phase** you are asked about plus *Principles*, *Stack* and *Open questions*. Later phases are intent, not commitments: do not plan or build beyond the requested phase.
- Open questions (SDK auth/billing, plugin loading options, `claude --worktree`, `better-sqlite3` rebuild under Electron, concurrent sessions) must be verified against current docs before designing around them.

## Architecture constraints (from the vision)

- `@anthropic-ai/claude-agent-sdk` runs in the Electron **main process**. Fallback: spawn `claude -p --output-format stream-json` and parse its output.
- Agent, skill and hook definitions live in the separate `claude-toolkit` plugin repo (the `flow` plugin: skills plan/build/verify/debug, workers, reviewer, test-writer, security-auditor). The app clones the toolkit into its data folder and loads it as a plugin per session. Never redefine toolkit agents or skills in this repo.
- Persistence is local SQLite via `better-sqlite3` (projects, settings, runs, costs). No own server.
- Git via the `git` CLI with `execFile` and argument arrays (or `simple-git`). Parallel work uses one worktree and branch per task (`git worktree add ../.worktrees/<task> -b task/<id>`), each with its own SDK session whose `cwd` is that worktree.
- Agents never work directly on `main`; nothing is pushed or merged unless the per-project policy allows it. Protected file patterns are enforced by a `PreToolUse` hook.
- Pipeline: planner writes `docs/plans/<slug>.md` -> orchestrator dispatches workers (max N parallel) -> reviewers -> blocking findings return to the worker for auto-fix rounds -> merge/push per policy.
- Token-aware defaults: small tasks, short reports, cheap models by default, usage always visible.

## Stack and layout
Electron + React + TypeScript (strict). Agent SDK and SQLite (`better-sqlite3`) in the main process.
- `src/main/` Electron main process: `chat/` (SDK session service), `git/`, `projects/` (JSON store behind `ProjectStore`), `ipc/` (handlers), `db/` (SQLite via `better-sqlite3`, `RunStore`), `config.ts`
- `src/preload/` preload scripts, the only bridge between main and renderer
- `src/renderer/` React UI
- `src/shared/` types shared by all three (IPC channel names, payload types, zod schemas)
- `tests/` integration tests (unit tests sit next to their source)
Scaffold and bundler: electron-vite.

## Commands
Workers and `verify` run these, so keep them accurate.
- Install: `npm install`
- Dev (Electron with HMR): `npm run dev` (`--watch`: main and preload changes rebuild and restart Electron; the renderer hot-reloads)
- Build: `npm run build` (electron-vite, output in `out/`)
- Package (Windows): `npm run dist` (electron-builder: installer in `release/`, runnable app in `release/win-unpacked/`; config in `electron-builder.yml`, icon from `build/icon.svg` via `npm run icon`). Native modules and the SDK binary are kept out of app.asar (`asarUnpack`); `src/main/sdk.ts` points the SDK at the unpacked `claude.exe`.
- Typecheck: `npm run typecheck` (`tsc --noEmit` for `tsconfig.node.json` and `tsconfig.web.json`)
- Lint: `npm run lint`
- Test: `npm test` (Vitest, fast suite ~30 s: excludes real-git, flow and live tests listed in `vitest.slow.ts`). `npm run test:slow` runs only those; `npm run test:changed` runs tests related to changes vs `main`; `npm run test:all` = fast + slow (run before a PR)
- SQLite: `better-sqlite3` ships prebuilt binaries for Node and Electron, so there is no rebuild script; see `docs/notes/sqlite-spike.md` (fallback: `npx @electron/rebuild -f -w better-sqlite3`).
- Single test file: `npm test -- src/shared/ipc.test.ts`; by name: `npm test -- -t "<test name>"`
- TypeScript is pinned to 6.0.x because `typescript-eslint` does not yet support 7.

## Conventions
- TypeScript strict, no `any`. Validate data at every boundary (IPC payloads, JSON, DB rows, process output) and type it after.
- All IPC channels and payload types are defined once in `src/shared/ipc.ts`. The renderer never sees Node APIs: `contextIsolation: true`, `nodeIntegration: false`, expose a minimal typed API through `contextBridge`. Validate every payload in the main-process handler.
- Child processes and git: `execFile`/`spawn` with argument arrays, never shell strings. Set `cwd`, handle non-zero exit and timeouts.
- SQLite: parameterized statements only, transactions for multi-step writes, versioned migrations for schema changes.
- Secrets (API keys): never logged, never in the renderer, never committed. Use `safeStorage` or environment variables. Never read or write `.env`; keep `.env.example` current.
- Paths must work on Windows, macOS and Linux (use `path`/`os`).
- Tests: Vitest for main and shared code, Testing Library for the renderer. Mock process, filesystem and network boundaries; use temp dirs or in-memory SQLite. Cover failure paths.
- Commits: Conventional Commits with the task id, e.g. `feat(projects): list projects over IPC (T2)`.

## Workflow
- Use the `flow` plugin: `plan` per phase, then `build`, then `verify`. One plan per phase, 5-8 small tasks.
- Worker routing: `src/main`, `src/preload`, `src/shared` → `node-developer`; `src/renderer` → `frontend-developer`; SQL/migrations → `database-engineer`.
- Always work on a feature branch (`phase-N-<name>`), never on `main`.
- Do not read `node_modules`, `dist`, `out`, `.git` (hooks block it).
- When an agent misbehaves, fix its `.md` or skill in the toolkit repo, not just the code.
flow-autonomy: checkpoints
