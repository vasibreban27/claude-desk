# Vision: claude-desk

A desktop control panel for my personal agentic workflow. The real work is still done by Claude Code's engine; the app keeps projects and settings, starts agents with my toolkit loaded, shows what they do, and lets me approve, review and merge their work.

> How to use this file: planners read the **Phase** they are asked about plus *Principles*, *Stack* and *Open questions*. Later phases are intent, not commitments. Do not plan beyond the requested phase.

## Principles
- **Control panel, not an engine.** The Agent SDK / Claude Code does the agent work; the app orchestrates and observes.
- **One source of truth for behavior.** Agent, skill and hook definitions come from my `claude-toolkit` plugin repo, so every project behaves the same. The app only passes settings and loads the toolkit.
- **Visible and reversible.** Every agent action is tracked in the UI. Work happens on branches/worktrees, never directly on `main`. Nothing is pushed or merged without the project's policy allowing it.
- **Token-aware.** Small tasks, short reports, cheap models by default, strong models only where judgment matters, usage always visible.
- **Local-first.** Data in a local SQLite database; no server of my own.

## Stack
- Electron + React + TypeScript (strict).
- `@anthropic-ai/claude-agent-sdk` running in the Electron **main process** (Node/TypeScript library).
- SQLite via `better-sqlite3` for projects, settings, runs and costs.
- Git via the `git` CLI (`execFile`, argument arrays) or `simple-git`; worktrees for parallel work.
- Fallback if the SDK does not fit: spawn `claude -p --output-format stream-json` and parse its output.

## Layout of the UI
Three panels: **projects** (left), **workspace** (middle: runs, activity, usage, settings), **chat** (right).

## Agent topology (runtime pipeline the app orchestrates)
```
Me ─► Planner (Opus: brainstorm + plan) ─► docs/plans/<slug>.md
        │
        ▼
Orchestrator (one per project) ─► Workers (Sonnet), each in its own git worktree, max N in parallel
        │
        ▼
Reviewers (reviewer: logic+tests; security-auditor: conditional; UI check later)
        │
blocking findings ─► back to the worker (auto-fix rounds) ─► merge/push per project policy
```
The toolkit already provides: skills `plan`, `build`, `verify`, `review`, `debug`, `pr`; workers `java-developer`, `python-developer`, `node-developer`, `frontend-developer`, `database-engineer`; `reviewer`, `test-writer`, `security-auditor`; and guard hooks. The app reuses them; it does not redefine them.

## Per-project settings (saved in SQLite)
- Pushing: push to main / PRs only / keep local.
- Merging: needs my approval / automatic.
- Protected file patterns (enforced by a `PreToolUse` hook).
- Command to run before review (checks).
- Number of auto-fix rounds.
- Parallel worktrees on/off and the maximum at once.
- Which reviewers run.
- Where plans/stories go: files or Linear.
- Model choice: Auto / Haiku / Sonnet / Opus.
- Toolkit source: the app's own clone of `claude-toolkit` or another git repo.

The **toolkit source** is the key setting: the app clones the toolkit into its data folder, pulls updates, and loads it as a plugin for every session.

## Phases
Each phase ends with something I can run and look at.

### Phase 1: App skeleton
Electron window with the three-panel layout. "Add project": pick a folder, read the git branch and clean/dirty status, list it on the left. One chat that starts a single SDK session with `cwd` set to the selected project and the toolkit loaded from a local clone.
**Done when:** I can add a project and chat with Claude about it from inside the app.

### Phase 2: Tracking and usage
Pass every SDK message to the UI. Register hooks (`PreToolUse`, `PostToolUse`, `SubagentStop`, `Stop`) that report events to the app. Activity view = live feed of what each agent does. Usage tab from the cost/token totals returned at the end of each run, per project, per agent and per day.
**Done when:** during a run I can see each agent's actions live, and afterwards what it cost.

### Phase 3: Project settings panel
The settings above, saved per project, with enforcement where it is a hook (protected paths).
**Done when:** changing a setting changes how the next run behaves.

### Phase 4: The pipeline
Planner chat that ends by writing a plan. Orchestrator assigns plan tasks to workers; each worker gets its own branch and worktree (`git worktree add ../.worktrees/<task> -b task/<id>`) and its own SDK session with `cwd` set to that worktree. A simple queue enforces "at most N at once". Run status shown in the middle panel.
**Done when:** a plan runs end to end with parallel workers on separate worktrees.

### Phase 5: Review loop and merge
When a worker finishes: run the checks command; on failure send the output back to that worker; on success run the enabled reviewers on the diff; blocking findings go back to the worker up to the auto-fix limit; then apply the project's push/merge policy and remove the worktree.
**Done when:** a finished task is reviewed, fixed and merged (or held for my approval) automatically per policy.

### Phase 6: Onboarding pipeline for existing projects
Stages: Map → Baseline → Scope → Audit → Triage → Backlog → Write-up → Done. Each stage is one agent run with a fixed output file. The app shows stages as steps and pauses at checkpoints for my decision (e.g. "keep their conventions or migrate to mine").

### Later (not planned yet)
Voice input, a code graph/index exposed as an MCP server, Linear integration, a "god mode" that skips confirmations.

## Open questions (verify before designing around them)
1. **Auth and billing for the SDK**: API key (per-token billing) vs. using an existing Claude Code login. This decides the "number of Opus agents depends on budget" logic. Check the current official docs before Phase 2/3.
2. Exact SDK options for loading a local plugin, hooks as callbacks, permission rules and per-session model.
3. Whether `claude --worktree` exists in the current CLI, or worktrees are always created manually with `git worktree`.
4. Packaging and the native-module rebuild step for `better-sqlite3` under Electron.
5. How to run several SDK sessions concurrently without them contending for the same files (worktree per worker is the plan).

## Non-goals (for now)
Multi-user features, a hosted backend, replacing Claude Code's own UI, supporting non-Claude models.
