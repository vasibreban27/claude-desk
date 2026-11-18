import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from '../db/migrations'
import { createPipelineStore, type PipelineStore } from '../db/pipelineStore'
import type { SettingsStore } from '../db/settingsStore'
import { defaultSettings } from '../../shared/settings'
import { createOrchestrator, type OrchestratorDeps, type StartRunInput } from './orchestrator'
import type { WorkerOutcome, WorkerRunArgs } from './workerRunner'
import type { ChecksGateResult } from './checksGate'
import type { ReviewOutcome, ReviewRunArgs } from './reviewRunner'
import type { Finding } from '../../shared/review'
import type { ProjectSettings } from '../../shared/settings'
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

const clean = (over: Partial<ReviewOutcome> = {}): ReviewOutcome => ({ status: 'finished', findings: [], turns: 2, costUsd: 0.02, ...over })
const finding = (severity: Finding['severity']): Finding => ({ reviewer: 'reviewer', severity, file: 'a.ts', line: 1, text: 'bad' })

function setup(opts: {
  runner?: (a: WorkerRunArgs) => Promise<WorkerOutcome>
  merge?: (id: string) => Promise<MergeResult>
  heads?: (branch: string, call: number) => string
  settings?: SettingsStore
  plan?: string
  cfg?: Partial<ProjectSettings>
  gate?: (n: number) => ChecksGateResult | Promise<ChecksGateResult>
  review?: (a: ReviewRunArgs, n: number) => ReviewOutcome | Promise<ReviewOutcome>
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
    get: () => ({ settings: { ...defaultSettings(), ...opts.cfg }, notice: null }),
    set: () => ({ ok: false, error: 'invalid' })
  }
  let gateCalls = 0
  let reviewCalls = 0
  const gate = vi.fn(async () => (opts.gate ? opts.gate(++gateCalls) : ({ status: 'passed' } as ChecksGateResult)))
  const reviewRunner = vi.fn(async (a: ReviewRunArgs) => (opts.review ? opts.review(a, ++reviewCalls) : clean({ costUsd: null })))
  const deps: OrchestratorDeps = {
    store,
    settings,
    runner,
    gate,
    reviewRunner,
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
  return { orch: createOrchestrator(deps), store, manager, runner, order, deps, gate, reviewRunner }
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

  const CHAIN = ['# Plan: chain', '', '## 7. Tasks', '', '### Wave 1', '', task('T1', 'a.ts', 'none'), '### Wave 2', '', task('T2', 'b.ts', 'T1'), '### Wave 3', '', task('T3', 'c.ts', 'T2')].join('\n')

  it.each([
    ['no commit', { heads: () => 'same' }, 'no commit', true],
    ['blocked report', { runner: async () => finishedOutcome({ blocked: 'need x.ts' }) }, 'blocked: need x.ts', true],
    ['worker error', { runner: async () => finishedOutcome({ status: 'error', error: 'boom' }) }, 'worker error', true],
    ['merge conflict', { merge: async () => ({ ok: true as const, result: 'conflict' as const }) }, 'merge conflict', true],
    ['merge failed', { merge: async () => ({ ok: false as const, error: 'index locked' }) }, 'merge failed: index locked', true],
    ['runner throws', { runner: async () => Promise.reject(new Error('x')) }, 'worker error', false],
    [
      'resolveRef rejects',
      {
        heads: () => {
          throw new Error('rev-parse failed')
        }
      },
      'worker error',
      false
    ]
  ])('%s: stores the reason and timings, blocks T2 and T3 transitively, keeps the worktree', async (_n, over, reason, hasOutcome) => {
    const c = setup({ ...over, plan: CHAIN })
    const r = await c.orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    const s = await r.finished
    expect(s.status).toBe('failed')
    expect(s.tasks.map((t) => t.status)).toEqual(['failed', 'blocked', 'blocked'])
    expect(s.tasks[0]?.reason).toBe(reason)
    expect(s.tasks[2]?.reason).toBe('depends on T2 (blocked)')
    expect(c.manager.removeTask).not.toHaveBeenCalled()
    const run = c.store.getRun(r.runId)
    expect(run.ok && run.value).toMatchObject({ status: 'failed' })
    const rows = c.store.listTasks(r.runId)
    if (!rows.ok) throw new Error('no tasks')
    const [t1, t2, t3] = rows.value
    expect(t1).toMatchObject({ status: 'failed', reason })
    expect(t1?.durationMs).toBeGreaterThan(0)
    if (hasOutcome) expect(t1).toMatchObject({ turns: 3, costUsd: 0.01, checksResult: 'passed' })
    expect(t2).toMatchObject({ status: 'blocked' })
    expect(t3).toMatchObject({ status: 'blocked' })
    expect(c.order).toEqual(_n === 'resolveRef rejects' ? [] : ['T1'])
  })

  it('retries a failed final setRunStatus once and succeeds', async () => {
    const real = ctx.deps.store
    const setRunStatus = vi.fn<PipelineStore['setRunStatus']>()
    setRunStatus.mockReturnValueOnce({ ok: false, error: 'storage-error' })
    setRunStatus.mockImplementation((...a) => real.setRunStatus(...a))
    const orch = createOrchestrator({ ...ctx.deps, store: { ...real, setRunStatus } })
    const r = await orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    const s = await r.finished
    expect(setRunStatus).toHaveBeenCalledTimes(2)
    expect(s.status).toBe('done')
    const run = real.getRun(r.runId)
    expect(run.ok && run.value).toMatchObject({ status: 'done' })
  })

  it('reports the run as failed with a reason when setRunStatus keeps failing', async () => {
    const log = vi.fn()
    const real = ctx.deps.store
    const setRunStatus = vi.fn<PipelineStore['setRunStatus']>(() => ({ ok: false, error: 'storage-error' }))
    const orch = createOrchestrator({ ...ctx.deps, log, store: { ...real, setRunStatus } })
    const r = await orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    const s = await r.finished
    expect(setRunStatus).toHaveBeenCalledTimes(2)
    expect(s.status).toBe('failed')
    expect(s.reason).toContain('final run status could not be saved')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('storage-error'))
  })

  it('removes the run when createRun throws or fails after the manager started', async () => {
    const real = ctx.deps.store
    const throwing = createOrchestrator({
      ...ctx.deps,
      store: {
        ...real,
        createRun: () => {
          throw new Error('disk gone')
        }
      }
    })
    expect(await throwing.startRun(input)).toMatchObject({ ok: false })
    expect(ctx.manager.removeRun).toHaveBeenCalledTimes(1)

    // A failing cleanup must not change the returned error.
    vi.mocked(ctx.manager.removeRun).mockRejectedValueOnce(new Error('rm failed'))
    const r = await throwing.startRun(input)
    expect(r).toMatchObject({ ok: false })
    expect(ctx.manager.removeRun).toHaveBeenCalledTimes(2)
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

  it('F3: cancel after the last task merged leaves the run and every task done', async () => {
    const single = ['# Plan: demo', '', '## 7. Tasks', '', '### Wave 1', '', task('T1', 'a.ts', 'none')].join('\n')
    let cancel: () => boolean = () => false
    const c = setup({
      plan: single,
      runner: async () => {
        cancel()
        return finishedOutcome()
      }
    })
    const r = await c.orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    cancel = () => c.orch.cancel(r.runId)
    const s = await r.finished
    expect(s.status).toBe('done')
    expect(s.tasks.map((t) => t.status)).toEqual(['done'])
    const run = c.store.getRun(r.runId)
    expect(run.ok && run.value.status).toBe('done')
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

describe('orchestrator: parallel pool', () => {
  const settingsWith = (maxParallel: number): SettingsStore => ({
    get: () => ({ settings: { ...defaultSettings(), maxParallel }, notice: null }),
    set: () => ({ ok: false, error: 'invalid' })
  })
  const wave = (ids: string[], deps = 'none'): string =>
    ['### Wave 1', '', ...ids.map((id) => task(id, `${id.toLowerCase()}.ts`, deps))].join('\n')
  const planOf = (...waves: string[]): string => ['# Plan: par', '', '## 7. Tasks', '', ...waves].join('\n')
  const FOUR = planOf(wave(['T1', 'T2', 'T3', 'T4']))
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 5))
  }

  /** Runner that holds every task until released by id. */
  function held() {
    const gates = new Map<string, (o?: WorkerOutcome) => void>()
    const active = new Set<string>()
    let max = 0
    const runner = (a: WorkerRunArgs): Promise<WorkerOutcome> =>
      new Promise((resolve) => {
        active.add(a.task.id)
        max = Math.max(max, active.size)
        const release = (o?: WorkerOutcome): void => {
          active.delete(a.task.id)
          resolve(o ?? finishedOutcome())
        }
        gates.set(a.task.id, release)
        a.signal?.addEventListener('abort', () => release(finishedOutcome({ status: 'cancelled' })))
      })
    return { runner, gates, active, max: () => max }
  }

  it('never runs more than maxParallel and starts the next as soon as one finishes', async () => {
    const h = held()
    const c = setup({ plan: FOUR, runner: h.runner, settings: settingsWith(2) })
    const r = await c.orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    await settle()
    expect(c.order).toEqual(['T1', 'T2'])
    h.gates.get('T2')?.()
    await settle()
    expect(c.order).toEqual(['T1', 'T2', 'T3'])
    h.gates.get('T1')?.()
    await settle()
    h.gates.get('T3')?.()
    h.gates.get('T4')?.()
    const s = await r.finished
    expect(s.status).toBe('done')
    expect(h.max()).toBe(2)
  })

  it('finishes every task of wave 1 before wave 2 starts', async () => {
    const h = held()
    const plan = planOf(wave(['T1', 'T2']), ['### Wave 2', '', task('T3', 'c.ts', 'none')].join('\n'))
    const c = setup({ plan, runner: h.runner, settings: settingsWith(4) })
    const r = await c.orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    await settle()
    expect(c.order).toEqual(['T1', 'T2'])
    h.gates.get('T1')?.()
    await settle()
    expect(c.order).toEqual(['T1', 'T2'])
    h.gates.get('T2')?.()
    await settle()
    expect(c.order).toEqual(['T1', 'T2', 'T3'])
    h.gates.get('T3')?.()
    expect((await r.finished).status).toBe('done')
  })

  it('serializes manager mutations while runners overlap, and merges in completion order', async () => {
    const h = held()
    let inside = 0
    let overlap = false
    const merges: string[] = []
    const guard = async <T,>(fn: () => T): Promise<T> => {
      inside += 1
      if (inside > 1) overlap = true
      await new Promise((r) => setTimeout(r, 1))
      const v = fn()
      inside -= 1
      return v
    }
    const c = setup({
      plan: planOf(wave(['T1', 'T2', 'T3'])),
      runner: h.runner,
      settings: settingsWith(3),
      merge: (id) =>
        guard(() => {
          merges.push(id)
          return { ok: true as const, result: 'merged' as const }
        })
    })
    vi.mocked(c.manager.createTaskWorktree).mockImplementation((id) =>
      guard(() => ({ ok: true as const, branch: `task/${id.toLowerCase()}`, path: `/wt/${id}` }))
    )
    const r = await c.orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    await vi.waitFor(() => expect(h.active.size).toBe(3))
    h.gates.get('T2')?.()
    await settle()
    h.gates.get('T1')?.()
    h.gates.get('T3')?.()
    const s = await r.finished
    expect(s.status).toBe('done')
    expect(overlap).toBe(false)
    expect(merges[0]).toBe('T2')
    expect(merges).toHaveLength(3)
    const rows = c.store.listTasks(r.runId)
    if (!rows.ok) throw new Error('rows')
    expect(rows.value.every((t) => t.commitSha !== null)).toBe(true)
  })

  it('a merge conflict fails only that task; siblings finish and later dependents are blocked', async () => {
    const plan = planOf(wave(['T1', 'T2', 'T3']), ['### Wave 2', '', task('T4', 'd.ts', 'T2'), task('T5', 'e.ts', 'T1')].join('\n'))
    const c = setup({
      plan,
      settings: settingsWith(3),
      merge: async (id) =>
        id === 'T2' ? { ok: true as const, result: 'conflict' as const } : { ok: true as const, result: 'merged' as const }
    })
    const r = await c.orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    const s = await r.finished
    expect(s.status).toBe('failed')
    const by = Object.fromEntries(s.tasks.map((t) => [t.taskId, t]))
    expect(by['T2']).toMatchObject({ status: 'failed', reason: 'merge conflict' })
    expect(by['T1']?.status).toBe('done')
    expect(by['T3']?.status).toBe('done')
    expect(by['T4']).toMatchObject({ status: 'blocked' })
    expect(by['T5']?.status).toBe('done')
  })

  it('a failing sibling does not stop running tasks', async () => {
    const h = held()
    const c = setup({ plan: planOf(wave(['T1', 'T2'])), runner: h.runner, settings: settingsWith(2) })
    const r = await c.orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    await settle()
    h.gates.get('T1')?.(finishedOutcome({ status: 'error', error: 'boom' }))
    await settle()
    h.gates.get('T2')?.()
    const s = await r.finished
    expect(s.status).toBe('failed')
    expect(s.tasks.map((t) => t.status)).toEqual(['failed', 'done'])
  })

  it('cancel aborts every running worker and cancels the queued ones', async () => {
    const h = held()
    const c = setup({ plan: planOf(wave(['T1', 'T2', 'T3', 'T4', 'T5'])), runner: h.runner, settings: settingsWith(3) })
    const r = await c.orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    await vi.waitFor(() => expect(h.active.size).toBe(3))
    expect(c.orch.cancel(r.runId)).toBe(true)
    const s = await r.finished
    expect(s.status).toBe('cancelled')
    expect(s.tasks.map((t) => t.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled', 'cancelled'])
    expect(c.runner).toHaveBeenCalledTimes(3)
    const rows = c.store.listTasks(r.runId)
    if (!rows.ok) throw new Error('rows')
    expect(rows.value.some((t) => t.status === 'running')).toBe(false)
  })

  it('a database error aborts the pool: nothing new starts and unsettled tasks fail with run failed', async () => {
    const h = held()
    const c = setup({ plan: planOf(wave(['T1', 'T2', 'T3'])), runner: h.runner, settings: settingsWith(2) })
    const real = c.deps.store
    const store: PipelineStore = {
      ...real,
      updateTask: (runId, id, patch) =>
        id === 'T1' && patch.status === 'done' ? { ok: false, error: 'storage-error' } : real.updateTask(runId, id, patch)
    }
    const orch = createOrchestrator({ ...c.deps, store })
    const r = await orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    await vi.waitFor(() => expect(h.active.size).toBe(2))
    h.gates.get('T1')?.()
    const s = await r.finished
    expect(s.status).toBe('failed')
    expect(s.reason).toContain('database error')
    expect(h.active.size).toBe(0)
    expect(c.order).toEqual(['T1', 'T2'])
    const rows = real.listTasks(r.runId)
    if (!rows.ok) throw new Error('rows')
    for (const t of rows.value.filter((x) => x.taskId !== 'T1')) {
      expect(t).toMatchObject({ status: 'failed', reason: expect.stringContaining('run failed: database error') })
    }
    const run = real.getRun(r.runId)
    expect(run.ok && run.value.status).toBe('failed')
  })

  it('uses the pre-generated run id and reads maxParallel once at start', async () => {
    const h = held()
    let current = 2
    const settings: SettingsStore = {
      get: () => ({ settings: { ...defaultSettings(), maxParallel: current }, notice: null }),
      set: () => ({ ok: false, error: 'invalid' })
    }
    const c = setup({ plan: FOUR, runner: h.runner, settings })
    const r = await c.orch.startRun({ ...input, runId: 'given-id' })
    if (!r.ok) throw new Error(r.error)
    expect(r.runId).toBe('given-id')
    current = 4
    await settle()
    expect(c.order).toEqual(['T1', 'T2'])
    for (const id of ['T1', 'T2', 'T3', 'T4']) {
      await vi.waitFor(() => expect(h.gates.has(id)).toBe(true))
      h.gates.get(id)?.()
    }
    expect((await r.finished).status).toBe('done')
    expect(h.max()).toBe(2)
  })
})

describe('orchestrator: review loop', () => {
  const ONE = ['# Plan: one', '', '## 7. Tasks', '', '### Wave 1', '', task('T1', 'a.ts', 'none')].join('\n')
  const flowPlan = (sensitive: string): string =>
    [
      'Format: flow-plan/1',
      '',
      '# Plan: flow',
      '',
      '## Wave 1: only',
      '',
      '### T1: title T1',
      '- Status: [ ] todo',
      '- Worker: node-developer',
      '- Size: S',
      `- Sensitive: ${sensitive}`,
      '- Contract: none',
      '- Owns: `a.ts`',
      '- Read first: `a.ts`',
      '- Depends on: none',
      '- Done when: `npm test`',
      '- Acceptance criteria:',
      '  - T1 works',
      ''
    ].join('\n')
  const CHECK = { name: 'test', command: 'npm', args: ['test'], timeoutMs: 1000 }
  const checksCfg = { checks: [CHECK] } as unknown as Partial<ProjectSettings>
  const moving = (_r: string, call: number): string => (call === 1 ? 'start' : `h${call}`)

  async function run(c: ReturnType<typeof setup>) {
    const r = await c.orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    const summary = await r.finished
    const rows = c.store.listTasks(r.runId)
    if (!rows.ok) throw new Error('no tasks')
    return { summary, t1: rows.value[0] }
  }

  it('sends a failing check back to the same worker, then merges with fixRounds 1', async () => {
    const seen: WorkerRunArgs[] = []
    const c = setup({
      plan: ONE,
      cfg: { ...checksCfg, autoFixRounds: 2 },
      heads: moving,
      runner: async (a) => {
        seen.push(a)
        return finishedOutcome({ sessionId: `s${seen.length}` })
      },
      gate: (k) => (k === 1 ? { status: 'failed', check: 'test', output: 'boom' } : { status: 'passed' }),
      review: () => clean()
    })
    const { summary, t1 } = await run(c)
    expect(summary.status).toBe('done')
    expect(seen).toHaveLength(2)
    expect(seen[1]?.fix).toMatchObject({ kind: 'checks', sessionId: 's1' })
    expect(seen[1]?.fix?.text).toContain('boom')
    expect(c.reviewRunner).toHaveBeenCalledTimes(1)
    expect(t1).toMatchObject({ status: 'done', fixRounds: 1, stage: null, checksResult: 'passed' })
    expect(t1?.costUsd).toBeCloseTo(0.01 + 0.01 + 0.02)
    expect(c.manager.mergeTask).toHaveBeenCalledTimes(1)
  })

  it('fails with review: blocking findings when no rounds remain, stores findings, never merges', async () => {
    const c = setup({
      plan: ONE,
      cfg: { autoFixRounds: 0, reviewers: ['reviewer'] },
      heads: moving,
      review: () => clean({ findings: [finding('blocker'), finding('nit')] })
    })
    const { summary, t1 } = await run(c)
    expect(summary.tasks[0]).toMatchObject({ status: 'failed', reason: 'review: blocking findings' })
    expect(t1?.findings).toMatchObject({ blocking: 1, minor: 1 })
    expect(t1?.findings?.items).toHaveLength(2)
    expect(t1?.stage).toBeNull()
    expect(c.manager.mergeTask).not.toHaveBeenCalled()
  })

  it('fixes blocking findings in a round and merges; minor findings never block', async () => {
    const seen: WorkerRunArgs[] = []
    const c = setup({
      plan: ONE,
      cfg: { autoFixRounds: 1 },
      heads: moving,
      runner: async (a) => {
        seen.push(a)
        return finishedOutcome()
      },
      review: (_a, k) => clean({ findings: k === 1 ? [finding('major')] : [finding('minor')] })
    })
    const { summary, t1 } = await run(c)
    expect(summary.status).toBe('done')
    expect(seen[1]?.fix?.kind).toBe('review')
    expect(t1).toMatchObject({ fixRounds: 1 })
    expect(t1?.findings).toMatchObject({ blocking: 0, minor: 1 })
  })

  it('a fix round without a new commit fails with no commit after fix', async () => {
    const c = setup({
      plan: ONE,
      cfg: { autoFixRounds: 2 },
      heads: (_r, call) => (call === 1 ? 'start' : 'same'),
      review: () => clean({ findings: [finding('blocker')] })
    })
    const { summary } = await run(c)
    expect(summary.tasks[0]).toMatchObject({ status: 'failed', reason: 'no commit after fix' })
    expect(c.manager.mergeTask).not.toHaveBeenCalled()
  })

  it('a worker that reports blocked in a fix round fails the task', async () => {
    let n = 0
    const c = setup({
      plan: ONE,
      cfg: { autoFixRounds: 2 },
      heads: moving,
      runner: async () => (++n === 2 ? finishedOutcome({ blocked: 'need x' }) : finishedOutcome()),
      review: () => clean({ findings: [finding('blocker')] })
    })
    const { summary } = await run(c)
    expect(summary.tasks[0]).toMatchObject({ status: 'failed', reason: 'blocked: need x' })
    expect(c.manager.mergeTask).not.toHaveBeenCalled()
  })

  it('exhausted rounds on a failing check fail with checks failed', async () => {
    const c = setup({
      plan: ONE,
      cfg: { ...checksCfg, autoFixRounds: 1 },
      heads: moving,
      gate: () => ({ status: 'failed', check: 'test', output: 'boom' })
    })
    const { summary, t1 } = await run(c)
    expect(summary.tasks[0]).toMatchObject({ status: 'failed', reason: 'checks failed' })
    expect(t1).toMatchObject({ fixRounds: 1, checksResult: 'failed' })
    expect(c.reviewRunner).not.toHaveBeenCalled()
  })

  it.each([
    ['no-report', 'review: reviewer did not report'],
    ['limit', 'review: reviewer limit reached'],
    ['error', 'review: reviewer error']
  ] as const)('a reviewer that ends with %s fails the task', async (status, reason) => {
    const c = setup({ plan: ONE, heads: moving, review: () => clean({ status }) })
    const { summary, t1 } = await run(c)
    expect(summary.tasks[0]).toMatchObject({ status: 'failed', reason })
    expect(t1?.costUsd).toBeCloseTo(0.03)
    expect(c.manager.mergeTask).not.toHaveBeenCalled()
  })

  it('merges as in 4c with no reviewers and no checks, and runs neither', async () => {
    const c = setup({ plan: ONE, cfg: { reviewers: [], checks: [] } })
    const { summary, t1 } = await run(c)
    expect(summary.status).toBe('done')
    expect(c.gate).not.toHaveBeenCalled()
    expect(c.reviewRunner).not.toHaveBeenCalled()
    expect(t1).toMatchObject({ fixRounds: null, findings: null })
  })

  it('runs the security-auditor only for Sensitive: yes tasks', async () => {
    const both = { reviewers: ['reviewer', 'security-auditor'] } as Partial<ProjectSettings>
    const plain = setup({ plan: flowPlan('no'), cfg: both, heads: moving })
    await run(plain)
    expect(plain.reviewRunner.mock.calls.map((c) => c[0].reviewer)).toEqual(['reviewer'])
    const sens = setup({ plan: flowPlan('yes'), cfg: both, heads: moving })
    await run(sens)
    expect(sens.reviewRunner.mock.calls.map((c) => c[0].reviewer)).toEqual(['reviewer', 'security-auditor'])
  })

  it('cancel during a review cancels the task, clears the stage and keeps the reviewer cost', async () => {
    let orch: ReturnType<typeof setup>['orch'] | null = null
    let runId = ''
    const c = setup({
      plan: ONE,
      heads: moving,
      review: () => {
        orch?.cancel(runId)
        return clean({ status: 'cancelled', costUsd: 0.05 })
      }
    })
    orch = c.orch
    const r = await c.orch.startRun({ ...input, runId: 'rid-1' })
    if (!r.ok) throw new Error(r.error)
    runId = r.runId
    const summary = await r.finished
    expect(summary.tasks[0]?.status).toBe('cancelled')
    const rows = c.store.listTasks(r.runId)
    if (!rows.ok) throw new Error('no tasks')
    expect(rows.value[0]).toMatchObject({ status: 'cancelled', stage: null })
    expect(rows.value[0]?.costUsd).toBeCloseTo(0.06)
  })

  it('a database error on a stage write fails the run and leaves no task running', async () => {
    const c = setup({ plan: ONE, heads: moving })
    const real = c.deps.store
    const store: PipelineStore = {
      ...real,
      updateTask: (rid, tid, patch) =>
        patch.stage === 'review' ? { ok: false, error: 'storage-error' } : real.updateTask(rid, tid, patch)
    }
    const orch = createOrchestrator({ ...c.deps, store })
    const r = await orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    const summary = await r.finished
    expect(summary.status).toBe('failed')
    const rows = real.listTasks(r.runId)
    if (!rows.ok) throw new Error('no tasks')
    expect(rows.value.every((t) => t.status !== 'running' && t.status !== 'queued')).toBe(true)
    expect(rows.value[0]?.stage).toBeNull()
  })
})
