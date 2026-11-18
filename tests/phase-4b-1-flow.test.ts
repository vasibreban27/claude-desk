import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, payload?: unknown) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>(),
  windows: [] as unknown[],
  worker: { current: null as null | ((args: unknown) => Promise<unknown>) }
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: () => hoisted.windows },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (event: unknown, payload?: unknown) => Promise<unknown>) => {
      hoisted.handlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      hoisted.handlers.delete(channel)
    })
  }
}))

// The real orchestrator, store, service and handlers run; only the SDK worker session is replaced.
vi.mock('../src/main/pipeline/workerRunner', async (importActual) => {
  const actual = await importActual<typeof import('../src/main/pipeline/workerRunner')>()
  return {
    ...actual,
    createWorkerRunner: () => (args: unknown) => {
      const fn = hoisted.worker.current
      if (!fn) throw new Error('no fake worker installed')
      return fn(args)
    }
  }
})

import { migrate } from '../src/main/db/migrations'
import { createPipelineStore, type PipelineStore } from '../src/main/db/pipelineStore'
import type { SettingsStore } from '../src/main/db/settingsStore'
import { registerIpc } from '../src/main/ipc/register'
import { guardWorkerToolUse } from '../src/main/pipeline/workerGuard'
import type { WorkerOutcome, WorkerRunArgs } from '../src/main/pipeline/workerRunner'
import { createWorkerTools } from '../src/main/pipeline/workerTools'
import { APP_IDENTITY, GIT_ENV_ADDITIONS, GIT_PREFIX } from '../src/main/pipeline/worktrees'
import type { ProjectStore } from '../src/main/projects/store'
import {
  IPC,
  type PipelinePlansResult,
  type PipelineRunView,
  type PipelineStartResult,
  type PipelineStatusResult,
  type Project
} from '../src/shared/ipc'
import { defaultSettings } from '../src/shared/settings'

// Real git and real worktrees are slow on Windows: generous limits for this file only.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 })

const BLANK_FILTER = ['-c', 'filter.x.clean=', '-c', 'filter.x.smudge=', '-c', 'filter.x.process=', '-c', 'filter.x.required=false']

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_PREFIX, ...BLANK_FILTER, ...APP_IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...GIT_ENV_ADDITIONS }
  })
}

const task = (id: string, owns: string, deps: string): string =>
  [
    `### ${id}: title ${id}`,
    '- Status: [ ] todo',
    '- Worker: node-developer',
    '- Size: S',
    '- Sensitive: no',
    '- Contract: none',
    `- Owns: \`${owns}\``,
    '- Read first: `README.md`',
    `- Depends on: ${deps}`,
    '- Done when: `node check.mjs`',
    '- Acceptance criteria:',
    `  - ${id} works`,
    ''
  ].join('\n')

const flowPlan = (...waves: string[][]): string =>
  ['Format: flow-plan/1', '', '# Phase: flow', '', ...waves.flatMap((w, i) => [`## Wave ${i + 1}: w${i + 1}`, '', ...w])].join('\n')

const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join('\n')

/** A worker that writes through the real guard, then commits through the real git_commit tool. */
const committingWorker =
  (files: (taskId: string) => Record<string, string>) =>
  async (args: WorkerRunArgs): Promise<WorkerOutcome> => {
    let blocked: string | null = null
    const tools = createWorkerTools({
      taskId: args.task.id,
      worktree: args.worktree,
      branch: args.branch,
      owns: args.task.owns,
      checks: [],
      onBlocked: (r) => {
        blocked = r
      }
    })
    const content = files(args.task.id)
    for (const [rel, body] of Object.entries(content)) {
      const filePath = path.join(args.worktree, rel)
      const verdict = guardWorkerToolUse(
        { tool_name: 'Write', tool_input: { file_path: filePath, content: body } },
        { worktree: args.worktree, owns: args.task.owns, protectedPatterns: args.settings.protectedPaths }
      ) as { hookSpecificOutput?: { permissionDecision?: string } }
      if (verdict.hookSpecificOutput?.permissionDecision === 'deny') throw new Error(`write to ${rel} denied`)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, body)
    }
    const r = await tools.handlers.git_commit({ paths: Object.keys(content), message: 'work' })
    if (r.isError === true) throw new Error(`git_commit failed: ${text(r)}`)
    return { status: 'finished', blocked, turns: 2, costUsd: 0, checksResult: tools.getCheckResult() }
  }

describe('phase 4b-1 pipeline from the IPC handlers (real git, in-memory db, fake workers)', () => {
  let base: string
  let repo: string
  let toolkit: string
  let db: Database.Database
  let store: PipelineStore
  let unregister: (() => void) | null
  let project: Project
  let events: { channel: string; payload: unknown }[]
  let savedToolkitEnv: string | undefined

  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'p4b1-')))
    repo = path.join(base, 'repo')
    fs.mkdirSync(repo)
    g(repo, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), 'readme\n')
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n')
    fs.mkdirSync(path.join(repo, 'node_modules'))
    fs.mkdirSync(path.join(repo, 'docs', 'plans'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'docs', 'plans', 'good.md'), flowPlan([task('T1', 'a.txt', 'none')], [task('T2', 'b.txt', 'T1')]))
    fs.writeFileSync(path.join(repo, 'docs', 'plans', 'broken.md'), 'Format: flow-plan/1\n\n# Broken\n\n## Wave 1\n\n### T1: no fields\n')
    g(repo, 'add', '.')
    g(repo, 'commit', '-q', '-m', 'init')
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'uncommitted, must survive\n')

    toolkit = path.join(base, 'toolkit')
    fs.mkdirSync(path.join(toolkit, '.claude-plugin'), { recursive: true })
    fs.writeFileSync(path.join(toolkit, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'flow', version: '0.0.0' }))
    savedToolkitEnv = process.env['CLAUDE_TOOLKIT_PATH']
    process.env['CLAUDE_TOOLKIT_PATH'] = toolkit

    db = new Database(':memory:')
    migrate(db)
    store = createPipelineStore(db)
    project = {
      id: randomUUID(),
      path: repo,
      name: 'repo',
      branch: 'main',
      dirty: true,
      addedAt: new Date().toISOString()
    }
    events = []
    hoisted.handlers.clear()
    hoisted.windows.length = 0
    hoisted.windows.push({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) => events.push({ channel, payload })
      }
    })
    hoisted.worker.current = null
    unregister = null
  })

  afterEach(() => {
    unregister?.()
    db.close()
    if (savedToolkitEnv === undefined) delete process.env['CLAUDE_TOOLKIT_PATH']
    else process.env['CLAUDE_TOOLKIT_PATH'] = savedToolkitEnv
    for (const dir of [path.join(base, '.worktrees'), base]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // best effort: a leftover temp folder must not fail the test
      }
    }
  })

  function boot(): void {
    const projects: ProjectStore = {
      list: () => Promise.resolve([project]),
      get: (id) => Promise.resolve(id === project.id ? project : undefined),
      add: () => Promise.resolve({ ok: false, error: 'unreadable' } as never),
      update: () => Promise.resolve(undefined)
    }
    const settings: SettingsStore = {
      get: () => ({ settings: { ...defaultSettings(), reviewers: [] }, notice: null }),
      set: () => ({ ok: false, error: 'invalid' })
    }
    unregister = registerIpc(projects, undefined, settings, store)
  }

  const call = async <T>(channel: string, payload: unknown): Promise<T> => {
    const fn: Handler | undefined = hoisted.handlers.get(channel)
    if (!fn) throw new Error(`no handler for ${channel}`)
    return (await fn({ sender: {} }, payload)) as T
  }
  const status = async (): Promise<PipelineRunView | null> => {
    const r = await call<PipelineStatusResult>(IPC.pipelineStatus, { projectId: project.id })
    if (!r.ok) throw new Error(`status: ${r.error}`)
    return r.run
  }
  const waitFor = async (pred: (run: PipelineRunView | null) => boolean, what: string): Promise<PipelineRunView | null> => {
    const deadline = Date.now() + 120_000
    for (;;) {
      const run = await status()
      if (pred(run)) return run
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  /** Resolves when the worker for a task has started; the returned `release` lets a blocked worker go. */
  const gate = (): { started: Promise<void>; release: () => void; worker: (args: unknown) => Promise<unknown> } => {
    let release!: () => void
    let markStarted!: () => void
    const started = new Promise<void>((r) => {
      markStarted = r
    })
    const released = new Promise<void>((r) => {
      release = r
    })
    const worker = async (raw: unknown): Promise<WorkerOutcome> => {
      const args = raw as WorkerRunArgs
      markStarted()
      await Promise.race([
        released,
        new Promise<void>((r) => args.signal?.addEventListener('abort', () => r(), { once: true }))
      ])
      if (args.signal?.aborted === true) {
        return { status: 'cancelled', blocked: null, turns: null, costUsd: null, checksResult: 'none' }
      }
      return { status: 'finished', blocked: null, turns: 1, costUsd: 0, checksResult: 'none' }
    }
    return { started, release, worker }
  }

  it('lists the plans, runs the good one to done with a commit per task, emits events, and leaves main untouched', async () => {
    boot()
    hoisted.worker.current = committingWorker((id) => ({ [id === 'T1' ? 'a.txt' : 'b.txt']: `${id}\n` })) as never
    const mainBefore = g(repo, 'rev-parse', 'main').trim()
    const statusBefore = g(repo, 'status', '--porcelain')

    const plans = await call<PipelinePlansResult>(IPC.pipelinePlans, { projectId: project.id })
    if (!plans.ok) throw new Error('plans failed')
    const good = plans.plans.find((p) => p.file === 'good.md')
    expect(good).toMatchObject({ ok: true, format: 'flow-plan/1', taskCount: 2, waveCount: 2, errorCount: 0 })

    expect(await status()).toBeNull()
    const started = await call<PipelineStartResult>(IPC.pipelineStart, { projectId: project.id, planFile: 'good.md' })
    expect(started.ok).toBe(true)

    const run = await waitFor((r) => r !== null && r.status !== 'running', 'run to finish')
    expect(run).not.toBeNull()
    expect(run?.status).toBe('done')
    expect(run?.baseBranch).toBe('main')
    expect(run?.tasks.map((t) => t.status)).toEqual(['done', 'done'])
    for (const t of run?.tasks ?? []) expect(t.commit).toMatch(/^[0-9a-f]{7}$/)
    expect(g(repo, 'show', `${run?.integrationBranch}:b.txt`)).toBe('T2\n')

    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.channel === IPC.pipelineEvent)).toBe(true)
    expect(events.every((e) => (e.payload as { projectId: string }).projectId === project.id)).toBe(true)

    expect(g(repo, 'rev-parse', 'main').trim()).toBe(mainBefore)
    expect(g(repo, 'status', '--porcelain')).toBe(statusBefore)
    expect(g(repo, 'branch', '--show-current').trim()).toBe('main')
    expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(repo, 'scratch.txt'), 'utf8')).toBe('uncommitted, must survive\n')
  })

  it('refuses a second start while the first runs (busy); cancel leaves a cancelled run with no running task', async () => {
    boot()
    const gated = gate()
    hoisted.worker.current = gated.worker
    const first = await call<PipelineStartResult>(IPC.pipelineStart, { projectId: project.id, planFile: 'good.md' })
    if (!first.ok) throw new Error(`start failed: ${first.error}`)
    await gated.started

    const second = await call<PipelineStartResult>(IPC.pipelineStart, { projectId: project.id, planFile: 'good.md' })
    expect(second).toEqual({ ok: false, error: 'busy' })
    expect((await status())?.active).toBe(true)

    const cancelled = await call<{ ok: boolean }>(IPC.pipelineCancel, { projectId: project.id, runId: first.runId })
    expect(cancelled).toEqual({ ok: true })

    const run = await waitFor((r) => r !== null && r.status !== 'running' && !r.active, 'cancelled run')
    expect(run?.status).toBe('cancelled')
    expect(run?.tasks.some((t) => t.status === 'running')).toBe(false)
    expect(run?.tasks.map((t) => t.status)).toEqual(['cancelled', 'cancelled'])

    const again = await call<{ ok: boolean; error?: string }>(IPC.pipelineCancel, { projectId: project.id, runId: first.runId })
    expect(again).toEqual({ ok: false, error: 'not-active' })
  })

  it('returns the error line for a broken plan and creates no run when it is started', async () => {
    boot()
    const plans = await call<PipelinePlansResult>(IPC.pipelinePlans, { projectId: project.id })
    if (!plans.ok) throw new Error('plans failed')
    const broken = plans.plans.find((p) => p.file === 'broken.md')
    expect(broken?.ok).toBe(false)
    expect(broken?.errorCount).toBeGreaterThan(0)
    expect(broken?.errors[0]?.line).toBeGreaterThan(0)
    expect(broken?.errors[0]?.message).not.toBe('')

    const started = await call<PipelineStartResult>(IPC.pipelineStart, { projectId: project.id, planFile: 'broken.md' })
    expect(started).toMatchObject({ ok: false, error: 'invalid-plan' })
    expect(await status()).toBeNull()
  })

  it('marks a run left running by a crash as failed (interrupted) without any start (F1 regression)', async () => {
    const seeded = store.createRun({
      id: randomUUID(),
      projectId: project.id,
      planPath: path.join(repo, 'docs', 'plans', 'good.md'),
      planSha256: 'x'.repeat(64),
      baseBranch: 'main',
      baseCommit: 'abc1234',
      integrationBranch: 'run/crashed',
      integrationPath: path.join(base, '.worktrees', 'crashed-integration'),
      tasks: [{ taskId: 'T1', title: 'title T1', worker: 'node-developer', wave: 1, dependsOn: [] }]
    })
    if (!seeded.ok) throw new Error('seed failed')
    const upd = store.updateTask(seeded.value.id, 'T1', { status: 'running', startedAt: Date.now() })
    if (!upd.ok) throw new Error('seed task failed')

    boot() // registration runs the crash recovery
    const run = await status()
    expect(run).toMatchObject({ runId: seeded.value.id, status: 'failed', active: false })
    expect(run?.tasks[0]).toMatchObject({ taskId: 'T1', status: 'failed', reason: 'interrupted' })
  })
})
