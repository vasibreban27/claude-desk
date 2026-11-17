import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from '../db/migrations'
import { createPipelineStore, type PipelineStore } from '../db/pipelineStore'
import type { SettingsStore } from '../db/settingsStore'
import { defaultSettings } from '../../shared/settings'
import { createOrchestrator, type OrchestratorDeps, type StartRunInput } from './orchestrator'
import type { WorkerOutcome, WorkerRunArgs } from './workerRunner'
import type { MergeResult, WorktreeManager } from './worktrees'

const task = (id: string, owns: string, deps: string): string =>
  [
    `### ${id}: title ${id}`,
    '- Status: [ ] todo',
    '- Worker: node-developer',
    '- Contract: none',
    `- Owns: \`${owns}\``,
    `- Depends on: ${deps}`,
    '- Acceptance criteria:',
    `  - ${id} works`,
    ''
  ].join('\n')

const PLAN = [
  '# Plan: demo',
  '',
  '## 7. Tasks',
  '',
  '### Wave 1',
  '',
  task('T1', 'a.ts', 'none'),
  '### Wave 2',
  '',
  task('T2', 'b.ts', 'T1'),
  task('T3', 'c.ts', 'T1'),
  '### Wave 3',
  '',
  task('T4', 'd.ts', 'T2, T3')
].join('\n')

const input: StartRunInput = { projectId: 'p', projectPath: '/proj', planPath: '/proj/plan.md', baseBranch: 'main' }
const finishedOutcome = (over: Partial<WorkerOutcome> = {}): WorkerOutcome => ({
  status: 'finished',
  blocked: null,
  turns: 3,
  costUsd: 0.01,
  checksResult: 'passed',
  ...over
})

function setup(opts: {
  runner?: (a: WorkerRunArgs) => Promise<WorkerOutcome>
  merge?: (id: string) => Promise<MergeResult>
  heads?: (branch: string, call: number) => string
  settings?: SettingsStore
  plan?: string
}) {
  const db = new Database(':memory:')
  migrate(db)
  const store: PipelineStore = createPipelineStore(db)
  const order: string[] = []
  const calls = new Map<string, number>()
  const manager: WorktreeManager = {
    startRun: vi.fn(async () => ({ ok: true as const, baseHash: 'base123', branch: 'run/abcd1234', path: '/wt/abcd1234-integration' })),
    createTaskWorktree: vi.fn(async (id: string) => ({ ok: true as const, branch: `task/abcd1234-${id.toLowerCase()}`, path: `/wt/${id}` })),
    mergeTask: vi.fn(opts.merge ?? (async () => ({ ok: true as const, result: 'merged' as const }))),
    removeTask: vi.fn(async () => ({ ok: true as const })),
    removeRun: vi.fn(async () => ({ ok: true as const }))
  }
  const runner = vi.fn(async (a: WorkerRunArgs) => {
    order.push(a.task.id)
    return (opts.runner ?? (async () => finishedOutcome()))(a)
  })
  const settings: SettingsStore = opts.settings ?? {
    get: () => ({ settings: defaultSettings(), notice: null }),
    set: () => ({ ok: false, error: 'invalid' })
  }
  const deps: OrchestratorDeps = {
    store,
    settings,
    runner,
    pluginPath: '/plugin',
    createManager: () => manager,
    readPlan: async () => opts.plan ?? PLAN,
    newRunId: () => 'abcd1234-0000',
    resolveRef: async (_cwd, ref) => {
      const n = (calls.get(ref) ?? 0) + 1
      calls.set(ref, n)
      return opts.heads ? opts.heads(ref, n) : n === 1 ? 'start' : `end-${ref}`
    },
    now: (() => {
      let t = 1000
      return () => (t += 10)
    })()
  }
  return { orch: createOrchestrator(deps), store, manager, runner, order, deps }
}

describe('orchestrator', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => {
    ctx = setup({})
  })

  it('runs tasks serially in wave order, merges each and records timings', async () => {
    const r = await ctx.orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    const summary = await r.finished
    expect(ctx.order).toEqual(['T1', 'T2', 'T3', 'T4'])
    expect(summary.status).toBe('done')
    expect(ctx.manager.mergeTask).toHaveBeenCalledTimes(4)
    const run = ctx.store.getRun(r.runId)
    expect(run.ok && run.value).toMatchObject({ status: 'done', baseCommit: 'base123' })
    const tasks = ctx.store.listTasks(r.runId)
    if (!tasks.ok) throw new Error('no tasks')
    for (const t of tasks.value) {
      expect(t).toMatchObject({ status: 'done', turns: 3, costUsd: 0.01, checksResult: 'passed' })
      expect(t.durationMs).toBeGreaterThan(0)
      expect(t.commitSha).toBe(`end-${t.branch}`)
    }
  })

  it('never runs a task before its dependencies are done (one at a time)', async () => {
    let running = 0
    let max = 0
    const c = setup({
      runner: async () => {
        running += 1
        max = Math.max(max, running)
        await Promise.resolve()
        running -= 1
        return finishedOutcome()
      }
    })
    const r = await c.orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    await r.finished
    expect(max).toBe(1)
  })

  it.each([
    ['no commit', { heads: () => 'same' }, 'no commit'],
    ['blocked report', { runner: async () => finishedOutcome({ blocked: 'need x.ts' }) }, 'blocked: need x.ts'],
    ['limit', { runner: async () => finishedOutcome({ status: 'limit' }) }, 'limit reached'],
    ['worker error', { runner: async () => finishedOutcome({ status: 'error', error: 'boom' }) }, 'worker error'],
    ['runner throws', { runner: async () => Promise.reject(new Error('x')) }, 'worker error'],
    ['merge conflict', { merge: async () => ({ ok: true as const, result: 'conflict' as const }) }, 'merge conflict']
  ])('fails a task on %s and blocks dependents transitively', async (_n, over, reason) => {
    const c = setup(over)
    const r = await c.orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    const s = await r.finished
    expect(s.status).toBe('failed')
    expect(c.order).toEqual(['T1'])
    const byId = Object.fromEntries(s.tasks.map((t) => [t.taskId, t]))
    expect(byId['T1']).toMatchObject({ status: 'failed', reason })
    expect(byId['T2']?.status).toBe('blocked')
    expect(byId['T3']?.status).toBe('blocked')
    expect(byId['T4']?.status).toBe('blocked')
    expect(c.manager.removeTask).not.toHaveBeenCalled()
  })

  it('a failed task blocks only its dependents', async () => {
    const c = setup({
      runner: async (a) => (a.task.id === 'T2' ? finishedOutcome({ status: 'limit' }) : finishedOutcome())
    })
    const r = await c.orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    const s = await r.finished
    expect(c.order).toEqual(['T1', 'T2', 'T3'])
    expect(s.tasks.map((t) => t.status)).toEqual(['done', 'failed', 'done', 'blocked'])
  })

  it('records a worktree creation failure', async () => {
    const c = setup({})
    vi.mocked(c.manager.createTaskWorktree).mockResolvedValueOnce({ ok: false, error: 'no node_modules' })
    const r = await c.orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    const s = await r.finished
    expect(s.tasks[0]).toMatchObject({ status: 'failed', reason: 'worktree error: no node_modules' })
    expect(c.runner).not.toHaveBeenCalled()
  })

  it('cancel aborts the running session and cancels queued tasks', async () => {
    let seen: AbortSignal | undefined
    const c = setup({
      runner: (a) =>
        new Promise((resolve) => {
          seen = a.signal
          a.signal?.addEventListener('abort', () => resolve(finishedOutcome({ status: 'cancelled' })))
        })
    })
    const r = await c.orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    await vi.waitFor(() => expect(seen).toBeDefined())
    expect(c.orch.cancel(r.runId)).toBe(true)
    const s = await r.finished
    expect(seen?.aborted).toBe(true)
    expect(s.status).toBe('cancelled')
    expect(s.tasks.map((t) => t.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled'])
    expect(c.runner).toHaveBeenCalledTimes(1)
    expect(c.orch.cancel(r.runId)).toBe(false)
  })

  it('calls markInterrupted at start and resumes nothing', () => {
    const store = { markInterrupted: vi.fn(() => ({ ok: true as const, value: 2 })) } as unknown as PipelineStore
    createOrchestrator({ ...ctx.deps, store })
    expect(store.markInterrupted).toHaveBeenCalledTimes(1)
  })

  it('survives a throwing markInterrupted', () => {
    const store = {
      markInterrupted: () => {
        throw new Error('db')
      }
    } as unknown as PipelineStore
    expect(() => createOrchestrator({ ...ctx.deps, store })).not.toThrow()
  })

  it('returns a short error for an unreadable or invalid plan and for failing settings', async () => {
    const bad = createOrchestrator({
      ...ctx.deps,
      readPlan: async () => {
        throw new Error('ENOENT')
      }
    })
    expect(await bad.startRun(input)).toMatchObject({ ok: false })
    const invalid = createOrchestrator({ ...ctx.deps, readPlan: async () => '# nothing' })
    expect(await invalid.startRun(input)).toMatchObject({ ok: false })
    const settings: SettingsStore = {
      get: () => ({ settings: defaultSettings(), notice: 'storage-unavailable' }),
      set: () => ({ ok: false, error: 'storage-unavailable' })
    }
    expect(await createOrchestrator({ ...ctx.deps, settings }).startRun(input)).toEqual({
      ok: false,
      error: 'settings could not be loaded'
    })
    expect(ctx.manager.startRun).not.toHaveBeenCalled()
  })

  it('returns an error when the worktree manager or the database fails', async () => {
    vi.mocked(ctx.manager.startRun).mockResolvedValueOnce({ ok: false, error: 'base branch not found: main' })
    expect(await ctx.orch.startRun(input)).toEqual({ ok: false, error: 'base branch not found: main' })

    const down = createOrchestrator({ ...ctx.deps, store: createPipelineStore(null) })
    const r = await down.startRun(input)
    expect(r).toMatchObject({ ok: false })
    expect(ctx.manager.removeRun).toHaveBeenCalledTimes(1)
  })

  it('fails the run (not throws) when the database breaks mid-run', async () => {
    const real = ctx.deps.store
    let n = 0
    const store: PipelineStore = {
      ...real,
      updateTask: (...a) => (++n > 2 ? { ok: false, error: 'storage-error' } : real.updateTask(...a))
    }
    const orch = createOrchestrator({ ...ctx.deps, store })
    const r = await orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    const s = await r.finished
    expect(s.status).toBe('failed')
    expect(s.reason).toContain('database error')
  })
})
