# Odyssey

A desktop control panel for working with Claude Code agents. You describe what you want in a chat, a planner turns it
into a plan, and Odyssey runs a small team of agents on isolated branches, checks and reviews their work, and hands you
a feature branch. Your `main` branch is never touched.

Odyssey does not contain the agents' know-how. It **runs, guards and observes** Claude Code sessions through the
[Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview), using your existing Claude Code login. The
agents themselves (how to plan, write Java or TypeScript, review code) live in a separate plugin repository,
**claude-toolkit**, which Odyssey loads into every session.

> The repository and package are still named `claude-desk`; the app is called Odyssey.

## Contents

- [What it does](#what-it-does)
- [How a run works](#how-a-run-works)
- [How it works with claude-toolkit](#how-it-works-with-claude-toolkit)
- [Safety model](#safety-model)
- [Install](#install)
- [First steps](#first-steps)
- [Development](#development)
- [Packaging](#packaging)
- [Project layout](#project-layout)
- [Status and limits](#status-and-limits)

## What it does

Three panels: **projects** on the left, a **workspace** in the middle, **chat** on the right.

| Area | What you get |
|---|---|
| **Chat** | Ask questions about a project (read-only), or switch to **Plan** mode, where the toolkit planner (Opus) writes a plan to `docs/plans/`. Paste screenshots, drop files, or dictate: speech is transcribed on your PC with Whisper. Start a new project just by describing it. |
| **Pipeline** | Runs a plan: tasks in waves, several workers in parallel, each in its own git worktree. Checks, reviewers, automatic fix rounds, Resume for a stopped run, and at the end **Save as branch**, **Open pull request** or (if you allow it) merge. |
| **Activity** | Every step of every agent, like the Claude Code CLI: text, tool calls with input and output previews, edit diffs, nested subagents, time and tokens. Previews only, secrets hidden; kept for 2 days, plus each project's last 5 runs. |
| **Usage** | Your real plan limits (from Claude Code's `/usage`) and where the tokens went: chat, planning, workers and reviewers. |
| **Toolkit** | The toolkit's agents and skills per project: each agent's model, project **house rules**, per-agent extra instructions, and a preview of exactly what a session receives. |
| **Settings** | App: default model, projects folder, toolkit folder (with git status and update), MCP connections. Project: checks (with a list of common ones), reviewers, limits, what happens after a run, models, protected paths. |

## How a run works

```
Plan chat ──► the planner writes docs/plans/<plan>.md
              (waves of small tasks; each task names its worker, the files it owns and its acceptance criteria)
   │  "build it"
   ▼
run branch run/<id>
 ├─ wave 1 ─┬─ T1 ─► worktree task/<id>-t1 ─► worker agent (e.g. java-developer)
 │          └─ T2 ─► worktree task/<id>-t2 ─► worker agent            (in parallel)
 │              each task: write code ─► run the checks ─► commit
 │              ─► the app runs the checks again ─► reviewers read the diff
 │              ─► blocking findings go back to the worker (fix rounds) ─► merged into run/<id>
 ├─ wave 2 … starts when wave 1 is merged
 ▼
Run finished ─► Save as branch (feature/<plan>) · Open pull request · Merge (only when the project allows it)
```

Run branches and worktrees are removed once you keep the result. A failed or cancelled run can be **resumed**: tasks
that were already merged are not run again.

## How it works with claude-toolkit

claude-toolkit is a Claude Code plugin (the `flow` plugin) with:

- **skills** such as `plan`, `build`, `verify`, `review` and `debug`;
- **worker agents**: `java-developer`, `node-developer`, `python-developer`, `frontend-developer`,
  `database-engineer` and `general-developer`;
- **reviewers**: `reviewer` and `security-auditor`; and helpers such as `test-writer`.

Odyssey uses it in three ways:

1. **Every session loads the plugin.** Chat, Plan, workers and reviewers start with the toolkit as a plugin. Odyssey
   never redefines the toolkit's agents or skills; agent behaviour is changed in the toolkit repository.
2. **Planning is the toolkit's `plan` skill.** Plan mode runs `/flow:plan` on Opus. Odyssey adds the plan format, the
   instruction to start the pipeline when you say "build it", and your project's house rules. The plan is then parsed,
   and only workers the toolkit knows can be assigned.
3. **Workers and reviewers get their agent, resolved per project.** Each session's instructions are built in layers:
   1. the toolkit agent's own instructions (its `.md` file, for example your Java conventions);
   2. the project's **house rules**;
   3. the project's **extra instructions** for that agent;
   4. Odyssey's own rules, last and always winning (only owned files, no shell, how to commit).

   Model choice follows the same order: the plan task's model, then the project's choice for the agent, then the
   toolkit file, then the project model, then the app default.

Choose the toolkit folder in **Settings → App → Toolkit** (your `claude-toolkit` clone; Odyssey finds the plugin
inside it). `CLAUDE_TOOLKIT_PATH` still works as a fallback for development.

## Safety model

- **Deny by default.** Every tool call from every agent goes through a `PreToolUse` guard. Chat can only read; Plan can
  also write `docs/plans/`; workers can create, edit, move and delete only the files their task owns, inside their own
  worktree. Agents have no general shell and no push, merge or checkout tool.
- **Protected paths** (for example `.env`, keys, `.git/`) can't be read or written. Links and junctions out of the
  worktree are refused.
- **`main` is never touched.** Work happens on `task/…` and `run/…` branches. Merging into the base branch is off
  unless a project turns it on.
- **Processes and git** run with `execFile` and argument lists, never shell strings.
- **Secrets** (MCP tokens and keys) are encrypted with the operating system's keychain and hidden from logs and
  Activity. No API key is needed: Odyssey uses your Claude Code login.
- **Local only.** No server of its own: SQLite for runs, usage, activity and agent settings, JSON for projects and app
  settings, and on-device speech-to-text.

See [docs/threat-model.md](docs/threat-model.md) for details.

## Install

Requirements:

- **Windows 10 or 11 (x64).** The installer is built and tested on Windows; macOS and Linux are not packaged yet.
- **Claude Code**, logged in once (`claude` then `/login`). Odyssey ships the matching Claude Code binary and uses that
  login.
- **git** on `PATH`.
- A clone of **claude-toolkit**.
- Optional: `gh` (GitHub) or `glab` (GitLab), logged in, to open pull requests from Odyssey.

Then run `Odyssey-Setup-<version>.exe` (see [Packaging](#packaging) to build it). The app isn't code-signed yet, so
Windows SmartScreen asks for confirmation: **More info → Run anyway**.

Your projects, settings and database are kept in `%APPDATA%\claude-desk`.

## First steps

1. **Settings → App → Toolkit → Choose folder…** and pick your `claude-toolkit` clone.
2. Optionally set a **Projects folder** (where new projects are created) and a **Default model**.
3. **Add project** to open an existing repository, or type what you want to build in the chat to start a new one.
4. **Settings → Project → Quality**: add the project's checks (for example `mvn -q test` or `npm test`). Without
   checks, tasks are reviewed but never tested.
5. Optional: **Toolkit → House rules** for the project's conventions (package layout, libraries, naming).
6. Switch the chat to **Plan**, describe the change, review the plan, and say **build it**.
7. Follow the run in **Pipeline** and **Activity**; when it finishes, **Save as branch** or **Open pull request**.

## Development

Requires Node.js 22 or newer (developed with Node 24) and npm.

```bash
npm install
cp .env.example .env    # set CLAUDE_TOOLKIT_PATH, or choose the toolkit in Settings later
npm run dev             # Electron with hot reload
```

| Command | What it does |
|---|---|
| `npm run dev` | Electron with hot reload; main and preload changes restart the app |
| `npm run build` | Production build into `out/` (electron-vite) |
| `npm run typecheck` | TypeScript for the main/preload and renderer projects |
| `npm run lint` | ESLint |
| `npm test` | Fast test suite (Vitest, about 30 s) |
| `npm run test:slow` | Real-git, flow and live tests |
| `npm run test:all` | Both suites (run before a pull request) |
| `npm run dist` | Windows installer (see below) |

Conventions (TypeScript strict, validation at every boundary, IPC defined once in `src/shared/ipc.ts`, Conventional
Commits, feature branches only) are described in [CLAUDE.md](CLAUDE.md).

## Packaging

```bash
npm run dist
```

This builds the app and runs electron-builder (`electron-builder.yml`):

- `release/Odyssey-Setup-<version>.exe`: installer with a choice of folder, Start menu and desktop shortcuts, and an
  uninstaller (about 280 MB);
- `release/win-unpacked/Odyssey.exe`: runs without installing.

The Claude Code binary shipped with the SDK and the native modules (`better-sqlite3`, `onnxruntime-node`, `sharp`) are
kept outside the app archive so they can run; `src/main/sdk.ts` points the SDK at the unpacked binary. The app icon is
`build/icon.svg`; `npm run icon` renders it to `build/icon.ico`.

## Project layout

```
src/
  main/       Electron main process: chat (SDK sessions), pipeline (orchestrator, workers, reviewers,
              worktrees), trace (Activity), toolkit (catalog and agent resolver), db (SQLite), mcp,
              speech (Whisper), ipc (handlers), projects
  preload/    the only bridge between main and renderer (typed window.api)
  renderer/   React UI
  shared/     types and zod schemas shared by all three, IPC contract
tests/        integration tests (unit tests sit next to their source)
docs/         vision, threat model, plans and spike notes
build/        app icon
```

## Status and limits

- Personal project, under active development; Windows is the only packaged platform.
- Not code-signed; no auto-update yet (install a new version over the old one).
- Pipeline workers have no shell: they run the project's checks and, when a project enables them, allow-listed setup
  commands (npm, npx, python/pip/uv, mvn, gradle, dotnet, go and cargo, with limited subcommands and no git).
- Helper agents (such as `test-writer`) run as subagents inside Chat and Plan; project overrides don't apply to them
  yet.
- MCP connections apply to every project and are available to Chat and Plan only, never to pipeline workers.
