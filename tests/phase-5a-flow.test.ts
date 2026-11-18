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
  worker: { current: null as null | ((args: unknown) => Promise<unknown>) },
  reviewer: { current: null as null | ((args: unknown) => Promise<unknown>) }
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

// The real orchestrator, checks gate, manager, store, service and handlers run; only the SDK sessions are replaced.
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
vi.mock('../src/main/pipeline/reviewRunner', async (importActual) => {
  const actual = await importActual<typeof import('../src/main/pipeline/reviewRunner')>()
  return {
    ...actual,
    createReviewRunner: () => (args: unknown) => {
      const fn = hoisted.reviewer.current
      if (!fn) throw new Error('no fake reviewer installed')
      return fn(args)
    }
  }
})

import { migrate } from '../src/main/db/migrations'
import { createPipelineStore, type PipelineStore } from '../src/main/db/pipelineStore'
import type { SettingsStore } from '../src/main/db/settingsStore'
import { registerIpc } from '../src/main/ipc/register'
import type { ReviewOutcome, ReviewRunArgs } from '../src/main/pipeline/reviewRunner'
import type { WorkerOutcome, WorkerRunArgs } from '../src/main/pipeline/workerRunner'
import { createWorkerTools } from '../src/main/pipeline/workerTools'
import { APP_IDENTITY, GIT_ENV_ADDITIONS, GIT_PREFIX } from '../src/main/pipeline/worktrees'
import type { ProjectStore } from '../src/main/projects/store'
import {
  IPC,
  type PipelineRunView,
  type PipelineStartResult,
  type PipelineStatusResult,
  type Project
} from '../src/shared/ipc'
import type { Finding } from '../src/shared/review'
import { defaultSettings, type ProjectSettings } from '../src/shared/settings'

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

const FILE_OF: Record<string, string> = { T1: 'a.txt', T2: 'b.txt' }

const task = (id: string): string =>
  [
    `### ${id}: title ${id}`,
    '- Status: [ ] todo',
    '- Worker: node-developer',
    '- Size: S',
    '- Sensitive: no',
    '- Contract: none',
    `- Owns: \`${FILE_OF[id]}\``,
    '- Read first: `README.md`',
    '- Depends on: none',
    '- Done when: `node check.mjs`',
    '- Acceptance criteria:',
    `  - ${id} works`,
    ''
  ].join('\n')

const flowPlan = (...tasks: string[]): string =>
  ['Format: flow-plan/1', '', '# Phase: review', '', '## Wave 1: w1', '', ...tasks].join('\n')

// Fails when any .txt file in the worktree contains BAD.
const CHECK_SCRIPT = [
  "import fs from 'node:fs'",
  'for (const f of fs.readdirSync(".")) {',
  '  if (f.endsWith(".txt") && fs.readFileSync(f, "utf8").includes("BAD")) {',
  '    console.error("found BAD in " + f)',
  '    process.exit(1)',
  '  }',
  '}',
  ''
].join('\n')

const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join('\n')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Writes `content` to the task's file and commits it through the real git_commit tool. */
async function commitContent(args: WorkerRunArgs, content: string, sessionId: string): Promise<WorkerOutcome> {
  const tools = createWorkerTools({
    taskId: args.task.id,
    worktree: args.worktree,
    branch: args.branch,
    owns: args.task.owns,
    checks: [],
    onBlocked: () => undefined
  })
  const rel = FILE_OF[args.task.id] ?? `${args.task.id}.txt`
  fs.writeFileSync(path.join(args.worktree, rel), content)
  const r = await tools.handlers.git_commit({ paths: [rel], message: 'work' })
  if (r.isError === true) throw new Error(`git_commit failed: ${text(r)}`)
  return { status: 'finished', blocked: null, turns: 2, costUsd: 0, checksResult: 'none', sessionId }
}

const noFindings = (): ReviewOutcome => ({ status: 'finished', findings: [], turns: 1, costUsd: 0.01 })
const blocker = (file: string): Finding => ({ reviewer: 'reviewer', severity: 'blocker', file, line: 1, text: 'this is wrong' })

describe('phase 5a review loop from the IPC handlers (real git, real checks gate, in-memory db, fake sessions)', () => {
  let base: string
  let repo: string
  let toolkit: string
  let db: Database.Database
  let store: PipelineStore
  let unregister: (() => void) | null
  let project: Project
  let savedToolkitEnv: string | undefined
  let cfg: Partial<ProjectSettings>

  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'p5a-')))
    repo = path.join(base, 'repo')
    fs.mkdirSync(repo)
    g(repo, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), 'readme\n')
    fs.writeFileSync(path.join(repo, 'check.mjs'), CHECK_SCRIPT)
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n')
    fs.mkdirSync(path.join(repo, 'node_modules'))
    fs.writeFileSync(path.join(repo, 'node_modules', 'sentinel.txt'), 'intact\n')
    fs.mkdirSync(path.join(repo, 'docs', 'plans'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'docs', 'plans', 'one.md'), flowPlan(task('T1')))
    fs.writeFileSync(path.join(repo, 'docs', 'plans', 'pair.md'), flowPlan(task('T1'), task('T2')))
    g(repo, 'add', '.')
    g(repo, 'commit', '-q', '-m', 'init')

    toolkit = path.join(base, 'toolkit')
    fs.mkdirSync(path.join(toolkit, '.claude-plugin'), { recursive: true })
    fs.writeFileSync(path.join(toolkit, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'flow', version: '0.0.0' }))
    savedToolkitEnv = process.env['CLAUDE_TOOLKIT_PATH']
    process.env['CLAUDE_TOOLKIT_PATH'] = toolkit

    db = new Database(':memory:')
    migrate(db)
    store = createPipelineStore(db)
    project = { id: randomUUID(), path: repo, name: 'repo', branch: 'main', dirty: false, addedAt: new Date().toISOString() }
    hoisted.handlers.clear()
    hoisted.windows.length = 0
    hoisted.windows.push({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: () => undefined }
    })
    hoisted.worker.current = null
    hoisted.reviewer.current = null
    unregister = null
    cfg = {}
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
      get: () => ({ settings: { ...defaultSettings(), ...cfg }, notice: null }),
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
  const finished = async (): Promise<PipelineRunView> => {
    const deadline = Date.now() + 120_000
    for (;;) {
      const run = await status()
      if (run !== null && run.status !== 'running' && !run.active) return run
      if (Date.now() > deadline) throw new Error('timed out waiting for the run to finish')
      await sleep(50)
    }
  }
  const start = async (planFile: string): Promise<void> => {
    const r = await call<PipelineStartResult>(IPC.pipelineStart, { projectId: project.id, planFile })
    if (!r.ok) throw new Error(`start failed: ${r.error}`)
  }
  const show = (branch: string, file: string): string => {
    try {
      return g(repo, 'show', `${branch}:${file}`)
    } catch {
      return '(missing)'
    }
  }
  const mergesOn = (branch: string): number => Number(g(repo, 'rev-list', '--merges', '--count', `main..${branch}`).trim())

  it('fails the gate once, fixes in a round, passes the reviewer and merges the fixed commit', async () => {
    cfg = {
      reviewers: ['reviewer'],
      autoFixRounds: 2,
      checks: [{ name: 'verify', executable: process.execPath, args: ['check.mjs'], timeoutMs: 60_000 }]
    }
    boot()
    const calls: WorkerRunArgs[] = []
    hoisted.worker.current = (async (raw: unknown): Promise<WorkerOutcome> => {
      const args = raw as WorkerRunArgs
      calls.push(args)
      return commitContent(args, args.fix === undefined ? 'BAD\n' : `${args.task.id}\n`, 's1')
    }) as never
    hoisted.reviewer.current = (async (): Promise<ReviewOutcome> => noFindings()) as never

    await start('one.md')
    const run = await finished()

    expect(run.status).toBe('done')
    const t = run.tasks[0]
    expect(t?.status).toBe('done')
    expect(t?.fixRounds).toBe(1)
    expect(t?.stage).toBeNull()
    expect(calls).toHaveLength(2)
    expect(calls[1]?.fix?.kind).toBe('checks')
    expect(calls[1]?.fix?.text).toContain('BAD')
    expect(calls[1]?.fix?.sessionId).toBe('s1')
    expect(show(run.integrationBranch, 'a.txt')).toBe('T1\n')
    expect(mergesOn(run.integrationBranch)).toBe(1)
  })

  it('fails a task with a blocker when no fix rounds are allowed and does not merge it', async () => {
    cfg = { reviewers: ['reviewer'], autoFixRounds: 0 }
    boot()
    hoisted.worker.current = ((raw: unknown) => commitContent(raw as WorkerRunArgs, 'T1\n', 's1')) as never
    hoisted.reviewer.current = (async (): Promise<ReviewOutcome> => ({
      status: 'finished',
      findings: [blocker('a.txt')],
      turns: 1,
      costUsd: 0.01
    })) as never

    await start('one.md')
    const run = await finished()

    expect(run.status).toBe('failed')
    expect(run.tasks[0]?.status).toBe('failed')
    expect(run.tasks[0]?.reason).toBe('review: blocking findings')
    expect(run.tasks[0]?.findings?.blocking).toBe(1)
    expect(mergesOn(run.integrationBranch)).toBe(0)
    expect(show(run.integrationBranch, 'a.txt')).toBe('(missing)')
  })

  it('merges the sibling of a task that fails review and never exceeds maxParallel while reviewing', async () => {
    cfg = { reviewers: ['reviewer'], autoFixRounds: 0, maxParallel: 1 }
    boot()
    let inFlight = 0
    let peak = 0
    hoisted.worker.current = (async (raw: unknown): Promise<WorkerOutcome> => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await sleep(30)
      return commitContent(raw as WorkerRunArgs, `${(raw as WorkerRunArgs).task.id}\n`, 's1')
    }) as never
    hoisted.reviewer.current = (async (raw: unknown): Promise<ReviewOutcome> => {
      const args = raw as ReviewRunArgs
      peak = Math.max(peak, inFlight)
      await sleep(30)
      inFlight--
      return args.task.id === 'T2'
        ? { status: 'finished', findings: [blocker('b.txt')], turns: 1, costUsd: 0 }
        : noFindings()
    }) as never

    await start('pair.md')
    const run = await finished()

    const by = Object.fromEntries(run.tasks.map((t) => [t.taskId, t.status]))
    expect(by).toEqual({ T1: 'done', T2: 'failed' })
    expect(run.status).toBe('failed')
    expect(peak).toBe(1)
    expect(show(run.integrationBranch, 'a.txt')).toBe('T1\n')
    expect(show(run.integrationBranch, 'b.txt')).toBe('(missing)')
    expect(mergesOn(run.integrationBranch)).toBe(1)
  })
})
