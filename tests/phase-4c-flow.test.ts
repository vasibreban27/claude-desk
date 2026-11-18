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

// The real orchestrator, manager, store, service and handlers run; only the SDK worker session is replaced.
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

const FILE_OF: Record<string, string> = { T1: 'a.txt', T2: 'b.txt', T3: 'c.txt', T4: 'd.txt' }

const task = (id: string, deps: string): string =>
  [
    `### ${id}: title ${id}`,
    '- Status: [ ] todo',
    '- Worker: node-developer',
    '- Size: S',
    '- Sensitive: no',
    '- Contract: none',
    `- Owns: \`${FILE_OF[id]}\``,
    '- Read first: `README.md`',
    `- Depends on: ${deps}`,
    '- Done when: `node check.mjs`',
    '- Acceptance criteria:',
    `  - ${id} works`,
    ''
  ].join('\n')

const flowPlan = (...waves: string[][]): string =>
  ['Format: flow-plan/1', '', '# Phase: parallel', '', ...waves.flatMap((w, i) => [`## Wave ${i + 1}: w${i + 1}`, '', ...w])].join('\n')

const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join('\n')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Sleeps `ms`, or returns early when the signal aborts. */
const hold = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted === true) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })

const cancelledOutcome: WorkerOutcome = { status: 'cancelled', blocked: null, turns: null, costUsd: null, checksResult: 'none' }

/** A worker that writes through the real guard, then commits through the real git_commit tool. */
async function commitOwnFile(args: WorkerRunArgs): Promise<WorkerOutcome> {
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
  const rel = FILE_OF[args.task.id] ?? `${args.task.id}.txt`
  const filePath = path.join(args.worktree, rel)
  const verdict = guardWorkerToolUse(
    { tool_name: 'Write', tool_input: { file_path: filePath, content: `${args.task.id}\n` } },
    { worktree: args.worktree, owns: args.task.owns, protectedPatterns: args.settings.protectedPaths }
  ) as { hookSpecificOutput?: { permissionDecision?: string } }
  if (verdict.hookSpecificOutput?.permissionDecision === 'deny') throw new Error(`write to ${rel} denied`)
  fs.writeFileSync(filePath, `${args.task.id}\n`)
  const r = await tools.handlers.git_commit({ paths: [rel], message: 'work' })
  if (r.isError === true) throw new Error(`git_commit failed: ${text(r)}`)
  return { status: 'finished', blocked, turns: 2, costUsd: 0, checksResult: tools.getCheckResult() }
}

describe('phase 4c parallel pipeline from the IPC handlers (real git, in-memory db, fake workers)', () => {
  let base: string
  let repo: string
  let toolkit: string
  let db: Database.Database
  let store: PipelineStore
  let unregister: (() => void) | null
  let project: Project
  let savedToolkitEnv: string | undefined
  let maxParallel = 2

  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'p4c-')))
    repo = path.join(base, 'repo')
    fs.mkdirSync(repo)
    g(repo, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), 'readme\n')
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n')
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n')
    fs.mkdirSync(path.join(repo, 'node_modules'))
    fs.writeFileSync(path.join(repo, 'node_modules', 'sentinel.txt'), 'intact\n')
    fs.mkdirSync(path.join(repo, 'docs', 'plans'), { recursive: true })
    const plans: Record<string, string> = {
      'wave.md': flowPlan([task('T1', 'none'), task('T2', 'none'), task('T3', 'none')], [task('T4', 'T1, T2')]),
      'four.md': flowPlan([task('T1', 'none'), task('T2', 'none'), task('T3', 'none'), task('T4', 'none')]),
      'pair.md': flowPlan([task('T1', 'none'), task('T2', 'none')])
    }
    for (const [file, body] of Object.entries(plans)) fs.writeFileSync(path.join(repo, 'docs', 'plans', file), body)
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
    project = { id: randomUUID(), path: repo, name: 'repo', branch: 'main', dirty: true, addedAt: new Date().toISOString() }
    hoisted.handlers.clear()
    hoisted.windows.length = 0
    hoisted.windows.push({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: () => undefined }
    })
    hoisted.worker.current = null
    unregister = null
    maxParallel = 2
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
      get: () => ({ settings: { ...defaultSettings(), maxParallel }, notice: null }),
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
  const waitFor = async (pred: (run: PipelineRunView | null) => boolean, what: string): Promise<PipelineRunView> => {
    const deadline = Date.now() + 120_000
    for (;;) {
      const run = await status()
      if (pred(run) && run !== null) return run
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await sleep(50)
    }
  }
  const start = async (planFile: string): Promise<string> => {
    const r = await call<PipelineStartResult>(IPC.pipelineStart, { projectId: project.id, planFile })
    if (!r.ok) throw new Error(`start failed: ${r.error}`)
    return r.runId
  }
  const finished = (): Promise<PipelineRunView> =>
    waitFor((r) => r !== null && r.status !== 'running' && !r.active, 'run to finish')

  /** A worker that records concurrency; the first `target` entrants wait for each other, then everyone holds ~150 ms. */
  function concurrencyWorker(
    target: number,
    inner: (args: WorkerRunArgs) => Promise<WorkerOutcome> = commitOwnFile
  ): { worker: (raw: unknown) => Promise<WorkerOutcome>; max: () => number } {
    let current = 0
    let peak = 0
    let arrived = 0
    return {
      max: () => peak,
      worker: async (raw) => {
        const args = raw as WorkerRunArgs
        current++
        peak = Math.max(peak, current)
        const mine = ++arrived
        try {
          if (mine <= target) {
            const deadline = Date.now() + 30_000
            while (current < target && arrived < target && Date.now() < deadline && args.signal?.aborted !== true) await sleep(10)
          }
          await hold(150, args.signal)
          if (args.signal?.aborted === true) return cancelledOutcome
          return await inner(args)
        } finally {
          current--
        }
      }
    }
  }

  const contentOf = (branch: string): string[] =>
    ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((f) => {
      try {
        return g(repo, 'show', `${branch}:${f}`)
      } catch {
        return '(missing)'
      }
    })

  it('runs a wave with at most maxParallel workers, merges all four tasks and leaves main and node_modules untouched', async () => {
    boot()
    const probe = concurrencyWorker(2)
    hoisted.worker.current = probe.worker as never
    const mainBefore = g(repo, 'rev-parse', 'main').trim()
    const statusBefore = g(repo, 'status', '--porcelain')

    await start('wave.md')
    const run = await finished()

    expect(run.status).toBe('done')
    expect(run.tasks.map((t) => t.status)).toEqual(['done', 'done', 'done', 'done'])
    expect(probe.max()).toBe(2)
    expect(contentOf(run.integrationBranch)).toEqual(['T1\n', 'T2\n', 'T3\n', 'T4\n'])
    expect(g(repo, 'rev-list', '--merges', '--count', `main..${run.integrationBranch}`).trim()).toBe('4')

    expect(g(repo, 'rev-parse', 'main').trim()).toBe(mainBefore)
    expect(g(repo, 'status', '--porcelain')).toBe(statusBefore)
    expect(g(repo, 'branch', '--show-current').trim()).toBe('main')
    expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(repo, 'scratch.txt'), 'utf8')).toBe('uncommitted, must survive\n')
    expect(fs.readFileSync(path.join(repo, 'node_modules', 'sentinel.txt'), 'utf8')).toBe('intact\n')
  })

  it('observes concurrency 1 with maxParallel 1 and 3 with maxParallel 4, with identical final content', async () => {
    const results: { peak: number; content: string[] }[] = []
    for (const limit of [1, 4]) {
      if (limit === 4) {
        unregister?.()
        hoisted.handlers.clear()
        // a fresh store keeps the second run independent of the first
        db.close()
        db = new Database(':memory:')
        migrate(db)
        store = createPipelineStore(db)
      }
      maxParallel = limit
      boot()
      const probe = concurrencyWorker(Math.min(limit, 3))
      hoisted.worker.current = probe.worker as never
      await start('wave.md')
      const run = await finished()
      expect(run.status).toBe('done')
      results.push({ peak: probe.max(), content: contentOf(run.integrationBranch) })
    }
    expect(results.map((r) => r.peak)).toEqual([1, 3])
    expect(results[1]?.content).toEqual(results[0]?.content)
  })

  it('cancels every running worker and the queued tasks, ends cancelled with nothing running, and the run can be discarded', async () => {
    boot()
    const aborted = new Set<string>()
    let started = 0
    hoisted.worker.current = (async (raw: unknown): Promise<WorkerOutcome> => {
      const args = raw as WorkerRunArgs
      started++
      await hold(60_000, args.signal)
      if (args.signal?.aborted === true) {
        aborted.add(args.task.id)
        return cancelledOutcome
      }
      return { status: 'finished', blocked: null, turns: 1, costUsd: 0, checksResult: 'none' }
    }) as never

    const runId = await start('wave.md')
    const deadline = Date.now() + 120_000
    while (started < 2 && Date.now() < deadline) await sleep(25)
    expect(started).toBe(2)

    expect(await call(IPC.pipelineCancel, { projectId: project.id, runId })).toEqual({ ok: true })
    const run = await finished()

    expect(run.status).toBe('cancelled')
    expect(aborted.size).toBe(2)
    expect(run.tasks.some((t) => t.status === 'running' || t.status === 'queued')).toBe(false)
    expect(run.tasks.map((t) => t.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled'])
    expect(await call(IPC.pipelineDiscard, { projectId: project.id, runId })).toEqual({ ok: true })
  })

  it('keeps siblings running when one task fails, blocks its dependent and fails the run', async () => {
    boot()
    const probe = concurrencyWorker(2, async (args) => {
      if (args.task.id === 'T2') throw new Error('boom')
      return commitOwnFile(args)
    })
    hoisted.worker.current = probe.worker as never

    await start('wave.md')
    const run = await finished()

    const by = Object.fromEntries(run.tasks.map((t) => [t.taskId, t.status]))
    expect(by).toEqual({ T1: 'done', T2: 'failed', T3: 'done', T4: 'blocked' })
    expect(run.status).toBe('failed')
  })

  it('fails the second of two tasks that edit the same unowned file with merge conflict, leaving the integration worktree clean', async () => {
    boot()
    const probe = concurrencyWorker(2, async (args) => {
      // Bypasses the guard on purpose: the tasks collide on a file neither of them owns.
      fs.writeFileSync(path.join(args.worktree, 'shared.txt'), `edit from ${args.task.id}\n`)
      g(args.worktree, 'add', '--', 'shared.txt')
      g(args.worktree, 'commit', '-q', '-m', `edit shared ${args.task.id}`)
      return { status: 'finished', blocked: null, turns: 1, costUsd: 0, checksResult: 'none' }
    })
    hoisted.worker.current = probe.worker as never

    await start('pair.md')
    const run = await finished()

    const statuses = run.tasks.map((t) => t.status).sort()
    expect(statuses).toEqual(['done', 'failed'])
    expect(run.tasks.find((t) => t.status === 'failed')?.reason).toBe('merge conflict')
    expect(run.status).toBe('failed')

    const listing = g(repo, 'worktree', 'list', '--porcelain').split(/\r?\n\r?\n/)
    const block = listing.find((b) => b.includes(`branch refs/heads/${run.integrationBranch}`))
    const wtPath = /^worktree (.+)$/m.exec(block ?? '')?.[1]
    expect(wtPath).toBeDefined()
    expect(g(wtPath ?? repo, 'status', '--porcelain')).toBe('')
  })

  it('starts four tasks at once on the real manager without a git lock error', async () => {
    maxParallel = 4
    boot()
    const probe = concurrencyWorker(4)
    hoisted.worker.current = probe.worker as never

    await start('four.md')
    const run = await finished()

    expect(probe.max()).toBe(4)
    expect(run.status).toBe('done')
    for (const t of run.tasks) {
      expect(t.status).toBe('done')
      expect(t.reason ?? '').not.toMatch(/lock|\.lock|another git process/i)
    }
    expect(contentOf(run.integrationBranch)).toEqual(['T1\n', 'T2\n', 'T3\n', 'T4\n'])
  })
})
