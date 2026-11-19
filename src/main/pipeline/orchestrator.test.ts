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
  heads?: (branch: string, call: number, workerRuns: number) => string
  settings?: SettingsStore
  plan?: string
  cfg?: Partial<ProjectSettings>
  gate?: (n: number) => ChecksGateResult | Promise<ChecksGateResult>
  review?: (a: ReviewRunArgs, n: number) => ReviewOutcome | Promise<ReviewOutcome>
  uncommitted?: (cwd: string) => Promise<string[]>
  onLog?: OrchestratorDeps['onLog']
  readPlan?: () => Promise<string>
  pathExists?: (p: string) => Promise<boolean>
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
    readPlan: opts.readPlan ?? (async () => opts.plan ?? PLAN),
    pathExists: opts.pathExists ?? (async () => true),
    newRunId: () => 'abcd1234-0000',
    ...(opts.uncommitted ? { uncommitted: opts.uncommitted } : {}),
    ...(opts.onLog ? { onLog: opts.onLog } : {}),
    resolveRef: async (_cwd, ref) => {
      const n = (calls.get(ref) ?? 0) + 1
      calls.set(ref, n)
      const runs = runner.mock.calls.filter((c) => c[0].branch === ref).length
      return opts.heads ? opts.heads(ref, n, runs) : n === 1 ? 'start' : `end-${ref}`
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
  const moving = (_r: string, call: number, runs: number): string => (call === 1 ? 'start' : `h${runs}`)

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

  it('writes short live log lines for a task and the run, and passes a log sink to the worker and reviewers', async () => {
    const lines: { taskId: string | null; role: string; text: string }[] = []
    const c = setup({
      plan: ONE,
      heads: moving,
      onLog: (_p, l) => lines.push({ taskId: l.taskId, role: l.role, text: l.text }),
      runner: async (a) => {
        a.onLog?.({ text: 'Write app/db.py' })
        return finishedOutcome()
      }
    })
    const { summary } = await run(c)
    expect(summary.status).toBe('done')
    const texts = lines.map((l) => `${l.taskId ?? 'run'} ${l.role} ${l.text}`)
    expect(texts[0]).toMatch(/^run pipeline run started: 1 task in 1 wave$/)
    expect(texts).toContain('T1 worker Write app/db.py')
    expect(texts.some((t) => /^T1 reviewer review: 0 blocking, 0 minor$/.test(t))).toBe(true)
    expect(texts).toContain('T1 pipeline merged into the run branch')
    expect(texts.at(-1)).toBe('run pipeline run done')
    expect(vi.mocked(c.reviewRunner).mock.calls[0]?.[0].onLog).toEqual(expect.any(Function))
  })

  it('sends uncommitted files back to the worker before review, then merges', async () => {
    const seen: WorkerRunArgs[] = []
    let calls = 0
    const c = setup({
      plan: ONE,
      cfg: { autoFixRounds: 1 },
      heads: moving,
      runner: async (a) => {
        seen.push(a)
        return finishedOutcome()
      },
      uncommitted: async () => (++calls === 1 ? ['app/routes.py'] : [])
    })
    const { summary, t1 } = await run(c)
    expect(summary.status).toBe('done')
    expect(seen[1]?.fix?.kind).toBe('checks')
    expect(seen[1]?.fix?.text).toContain('app/routes.py')
    expect(c.reviewRunner).toHaveBeenCalled()
    expect(t1).toMatchObject({ fixRounds: 1 })
  })

  it('fails naming the files when uncommitted work remains after the fix rounds', async () => {
    const c = setup({ plan: ONE, cfg: { autoFixRounds: 1 }, heads: moving, uncommitted: async () => ['app/routes.py'] })
    const { summary, t1 } = await run(c)
    expect(summary.status).toBe('failed')
    expect(t1).toMatchObject({ status: 'failed', reason: 'uncommitted changes: app/routes.py' })
    expect(c.reviewRunner).not.toHaveBeenCalled()
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

describe('orchestrator: review loop gap coverage', () => {
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
  const moving = (_r: string, call: number, runs: number): string => (call === 1 ? 'start' : `h${runs}`)
  const auditor = (severity: Finding['severity']): Finding => ({ ...finding(severity), reviewer: 'security-auditor' })

  async function run(c: ReturnType<typeof setup>) {
    const r = await c.orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    const summary = await r.finished
    const rows = c.store.listTasks(r.runId)
    if (!rows.ok) throw new Error('no tasks')
    return { summary, rows: rows.value, t1: rows.value[0] }
  }

  it('checks failing in every round exhaust autoFixRounds: checks failed, N fix rounds, cost summed, no review, no merge', async () => {
    const seen: WorkerRunArgs[] = []
    const c = setup({
      plan: ONE,
      cfg: { ...checksCfg, autoFixRounds: 2 },
      heads: moving,
      runner: async (a) => {
        seen.push(a)
        return finishedOutcome({ sessionId: `s${seen.length}` })
      },
      gate: () => ({ status: 'failed', check: 'test', output: 'boom' })
    })
    const { summary, t1 } = await run(c)
    expect(summary.tasks[0]).toMatchObject({ status: 'failed', reason: 'checks failed' })
    expect(c.gate).toHaveBeenCalledTimes(3)
    expect(seen).toHaveLength(3)
    expect(seen[2]?.fix).toMatchObject({ kind: 'checks', sessionId: 's2' })
    expect(t1).toMatchObject({ fixRounds: 2, stage: null, turns: 9 })
    expect(t1?.costUsd).toBeCloseTo(0.03)
    expect(c.reviewRunner).not.toHaveBeenCalled()
    expect(c.manager.mergeTask).not.toHaveBeenCalled()
  })

  it('a gate that fails because the signal aborted cancels the task and never reviews or merges', async () => {
    let orch: ReturnType<typeof setup>['orch'] | null = null
    let runId = ''
    const c = setup({
      plan: ONE,
      cfg: { ...checksCfg },
      heads: moving,
      gate: () => {
        orch?.cancel(runId)
        return { status: 'failed', check: 'test', output: 'cancelled' }
      }
    })
    orch = c.orch
    const r = await c.orch.startRun({ ...input, runId: 'rid-gate' })
    if (!r.ok) throw new Error(r.error)
    runId = r.runId
    const summary = await r.finished
    expect(summary.status).toBe('cancelled')
    expect(summary.tasks[0]).toMatchObject({ status: 'cancelled', reason: null })
    expect(c.runner).toHaveBeenCalledTimes(1)
    expect(c.reviewRunner).not.toHaveBeenCalled()
    expect(c.manager.mergeTask).not.toHaveBeenCalled()
    const rows = c.store.listTasks(r.runId)
    if (!rows.ok) throw new Error('rows')
    expect(rows.value[0]).toMatchObject({ status: 'cancelled', stage: null })
  })

  it('a task with no new commit and checks configured fails with no commit before the gate runs', async () => {
    const c = setup({ plan: ONE, cfg: { ...checksCfg }, heads: () => 'same' })
    const { summary } = await run(c)
    expect(summary.tasks[0]).toMatchObject({ status: 'failed', reason: 'no commit' })
    expect(c.gate).not.toHaveBeenCalled()
    expect(c.reviewRunner).not.toHaveBeenCalled()
  })

  it('a reviewer that throws fails the task with review: reviewer error and keeps earlier cost', async () => {
    const c = setup({
      plan: ONE,
      heads: moving,
      review: () => {
        throw new Error('sdk down')
      }
    })
    const { summary, t1 } = await run(c)
    expect(summary.tasks[0]).toMatchObject({ status: 'failed', reason: 'review: reviewer error' })
    expect(t1).toMatchObject({ stage: null })
    expect(t1?.costUsd).toBeCloseTo(0.01)
    expect(c.manager.mergeTask).not.toHaveBeenCalled()
  })

  it.each([
    ['limit', finishedOutcome({ status: 'limit' }), 'failed', 'limit reached'],
    ['error', finishedOutcome({ status: 'error', error: 'boom' }), 'failed', 'worker error'],
    ['cancelled', finishedOutcome({ status: 'cancelled' }), 'cancelled', null]
  ] as const)('a fix round whose worker ends with %s settles the task and is not merged', async (_n, outcome, st, reason) => {
    let n = 0
    const c = setup({
      plan: ONE,
      cfg: { autoFixRounds: 2 },
      heads: moving,
      runner: async () => (++n === 2 ? outcome : finishedOutcome()),
      review: () => clean({ findings: [finding('blocker')] })
    })
    const { summary, t1 } = await run(c)
    expect(summary.tasks[0]).toMatchObject({ status: st, reason })
    expect(t1).toMatchObject({ stage: null, fixRounds: 1 })
    expect(c.reviewRunner).toHaveBeenCalledTimes(1)
    expect(c.manager.mergeTask).not.toHaveBeenCalled()
  })

  it('a runner that throws in a fix round fails the task with worker error', async () => {
    let n = 0
    const c = setup({
      plan: ONE,
      cfg: { autoFixRounds: 2 },
      heads: moving,
      runner: async () => (++n === 2 ? Promise.reject(new Error('crash')) : finishedOutcome()),
      review: () => clean({ findings: [finding('blocker')] })
    })
    const { summary, t1 } = await run(c)
    expect(summary.tasks[0]).toMatchObject({ status: 'failed', reason: 'worker error' })
    expect(t1?.stage).toBeNull()
  })

  it('two reviewers, one blocking finding: both run, blocking counted once, blocking listed first', async () => {
    const c = setup({
      plan: flowPlan('yes'),
      cfg: { autoFixRounds: 0, reviewers: ['reviewer', 'security-auditor'] },
      heads: moving,
      review: (a) => clean({ findings: a.reviewer === 'reviewer' ? [finding('minor')] : [auditor('blocker')] })
    })
    const { summary, t1 } = await run(c)
    expect(summary.tasks[0]).toMatchObject({ status: 'failed', reason: 'review: blocking findings' })
    expect(c.reviewRunner).toHaveBeenCalledTimes(2)
    expect(t1?.findings).toMatchObject({ blocking: 1, minor: 1 })
    expect(t1?.findings?.items.map((f) => f.severity)).toEqual(['blocker', 'minor'])
    expect(t1?.costUsd).toBeCloseTo(0.01 + 0.02 + 0.02)
  })

  it('a blocking finding is fixed with its text, then both reviewers run again', async () => {
    const seen: WorkerRunArgs[] = []
    const c = setup({
      plan: flowPlan('yes'),
      cfg: { autoFixRounds: 1, reviewers: ['reviewer', 'security-auditor'] },
      heads: moving,
      runner: async (a) => {
        seen.push(a)
        return finishedOutcome()
      },
      review: (a, k) => clean({ findings: k === 1 && a.reviewer === 'reviewer' ? [finding('major')] : [] })
    })
    const { summary, t1 } = await run(c)
    expect(summary.status).toBe('done')
    expect(seen[1]?.fix?.text).toContain('[major] (reviewer) a.ts:1: bad')
    expect(c.reviewRunner.mock.calls.map((x) => x[0].reviewer)).toEqual(['reviewer', 'security-auditor', 'reviewer', 'security-auditor'])
    expect(t1).toMatchObject({ fixRounds: 1, status: 'done' })
    expect(t1?.findings).toMatchObject({ blocking: 0, minor: 0, items: [] })
  })

  it('minor and nit findings only: merges as done and stores the findings', async () => {
    const c = setup({
      plan: ONE,
      cfg: { autoFixRounds: 0 },
      heads: moving,
      review: () => clean({ findings: [finding('nit'), finding('minor')] })
    })
    const { summary, t1 } = await run(c)
    expect(summary.status).toBe('done')
    expect(c.manager.mergeTask).toHaveBeenCalledTimes(1)
    expect(t1).toMatchObject({ status: 'done', fixRounds: 0, stage: null })
    expect(t1?.findings).toMatchObject({ blocking: 0, minor: 2 })
    expect(t1?.findings?.items).toHaveLength(2)
  })

  it('caps stored findings at 20 items while counting all of them, blocking first', async () => {
    const c = setup({
      plan: flowPlan('yes'),
      cfg: { autoFixRounds: 0, reviewers: ['reviewer', 'security-auditor'] },
      heads: moving,
      review: (a) =>
        clean({
          findings:
            a.reviewer === 'reviewer'
              ? Array.from({ length: 15 }, () => finding('minor'))
              : [...Array.from({ length: 14 }, () => auditor('nit')), auditor('blocker')]
        })
    })
    const { t1 } = await run(c)
    expect(t1?.findings).toMatchObject({ blocking: 1, minor: 29 })
    expect(t1?.findings?.items).toHaveLength(20)
    expect(t1?.findings?.items[0]?.severity).toBe('blocker')
  })

  it('security-auditor enabled on a non-Sensitive task runs no review and merges like 4c', async () => {
    const c = setup({ plan: flowPlan('no'), cfg: { reviewers: ['security-auditor'] }, heads: moving })
    const { summary, t1 } = await run(c)
    expect(summary.status).toBe('done')
    expect(c.reviewRunner).not.toHaveBeenCalled()
    expect(t1).toMatchObject({ status: 'done', fixRounds: null, findings: null })
  })

  it('a failing check, then a blocking review, takes two fix rounds of different kinds and sums every cost', async () => {
    const seen: WorkerRunArgs[] = []
    const c = setup({
      plan: ONE,
      cfg: { ...checksCfg, autoFixRounds: 2 },
      heads: moving,
      runner: async (a) => {
        seen.push(a)
        return finishedOutcome()
      },
      gate: (k) => (k === 1 ? { status: 'failed', check: 'test', output: 'red' } : { status: 'passed' }),
      review: (_a, k) => clean({ findings: k === 1 ? [finding('blocker')] : [] })
    })
    const { summary, t1 } = await run(c)
    expect(summary.status).toBe('done')
    expect(seen.map((a) => a.fix?.kind ?? null)).toEqual([null, 'checks', 'review'])
    expect(c.gate).toHaveBeenCalledTimes(3)
    expect(c.reviewRunner).toHaveBeenCalledTimes(2)
    expect(t1).toMatchObject({ fixRounds: 2, turns: 9, status: 'done', stage: null })
    expect(t1?.costUsd).toBeCloseTo(3 * 0.01 + 2 * 0.02)
  })

  it('a blocking review after the last allowed round fails with the blocking reason', async () => {
    const c = setup({
      plan: ONE,
      cfg: { autoFixRounds: 1 },
      heads: moving,
      review: () => clean({ findings: [finding('blocker')] })
    })
    const { summary, t1 } = await run(c)
    expect(summary.tasks[0]).toMatchObject({ status: 'failed', reason: 'review: blocking findings' })
    expect(t1).toMatchObject({ fixRounds: 1 })
    expect(t1?.findings).toMatchObject({ blocking: 1 })
    expect(c.reviewRunner).toHaveBeenCalledTimes(2)
  })

  it('a database error on the fixing stage write fails the run and leaves no task running', async () => {
    const c = setup({ plan: ONE, cfg: { autoFixRounds: 2 }, heads: moving, review: () => clean({ findings: [finding('blocker')] }) })
    const real = c.deps.store
    const store: PipelineStore = {
      ...real,
      updateTask: (rid, tid, patch) => (patch.stage === 'fixing' ? { ok: false, error: 'storage-error' } : real.updateTask(rid, tid, patch))
    }
    const orch = createOrchestrator({ ...c.deps, store })
    const r = await orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    const summary = await r.finished
    expect(summary.status).toBe('failed')
    expect(summary.reason).toContain('database error')
    expect(c.runner).toHaveBeenCalledTimes(1)
    const rows = real.listTasks(r.runId)
    if (!rows.ok) throw new Error('rows')
    expect(rows.value.every((t) => t.status !== 'running' && t.status !== 'queued')).toBe(true)
    expect(rows.value[0]?.stage).toBeNull()
  })

  it('two parallel tasks: one fails review, the other merges, and parallelism stays within maxParallel', async () => {
    const plan = ['# Plan: par', '', '## 7. Tasks', '', '### Wave 1', '', task('T1', 'a.ts', 'none'), task('T2', 'b.ts', 'none')].join('\n')
    let live = 0
    let max = 0
    const c = setup({
      plan,
      cfg: { autoFixRounds: 0, maxParallel: 2 },
      heads: moving,
      runner: async () => {
        live += 1
        max = Math.max(max, live)
        await Promise.resolve()
        live -= 1
        return finishedOutcome()
      },
      review: (a) => clean({ findings: a.task.id === 'T1' ? [finding('blocker')] : [] })
    })
    const { summary, rows } = await run(c)
    expect(max).toBeLessThanOrEqual(2)
    expect(summary.status).toBe('failed')
    expect(summary.tasks.map((t) => [t.taskId, t.status])).toEqual([
      ['T1', 'failed'],
      ['T2', 'done']
    ])
    expect(c.manager.mergeTask).toHaveBeenCalledTimes(1)
    expect(c.manager.mergeTask).toHaveBeenCalledWith('T2')
    expect(rows[0]).toMatchObject({ status: 'failed', stage: null })
    expect(rows[0]?.findings).toMatchObject({ blocking: 1 })
    expect(rows[1]).toMatchObject({ status: 'done', findings: { blocking: 0, minor: 0 } })
  })
})

describe('orchestrator resume', () => {
  /** A run where T4 (wave 3) fails the first time and passes after a resume. */
  async function failedRun(over: Parameters<typeof setup>[0] = {}) {
    let t4Runs = 0
    const c = setup({
      runner: async (a) => {
        if (a.task.id === 'T4' && ++t4Runs === 1) return finishedOutcome({ status: 'error', error: 'interrupted' })
        return finishedOutcome()
      },
      // Each worker run moves its branch forward, also on the second attempt of a task.
      heads: (_branch, _call, workerRuns) => `sha-${workerRuns}`,
      ...over
    })
    const r = await c.orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    const s = await r.finished
    expect(s.status).toBe('failed')
    return { c, runId: r.runId }
  }

  it('reruns only the unfinished tasks on the same run branch', async () => {
    const { c, runId } = await failedRun()
    c.order.length = 0
    const r = await c.orch.resumeRun({ projectId: 'p', projectPath: '/proj', runId })
    if (!r.ok) throw new Error(r.error)
    expect(r.runId).toBe(runId)
    const s = await r.finished
    expect(s.status).toBe('done')
    expect(c.order).toEqual(['T4'])
    expect(c.manager.removeTask).toHaveBeenCalledWith('T4')
    expect(c.manager.removeTask).toHaveBeenCalledTimes(1)
    expect(c.manager.startRun).toHaveBeenCalledTimes(1)
    const run = c.store.getRun(runId)
    expect(run.ok && run.value.status).toBe('done')
    const tasks = c.store.listTasks(runId)
    if (!tasks.ok) throw new Error('no tasks')
    expect(tasks.value.map((t) => t.status)).toEqual(['done', 'done', 'done', 'done'])
  })

  it('refuses when the plan changed, the run branch is gone, the run is done or still active', async () => {
    let plan = PLAN
    let exists = true
    const { c, runId } = await failedRun({ readPlan: async () => plan, pathExists: async () => exists })
    const resume = () => c.orch.resumeRun({ projectId: 'p', projectPath: '/proj', runId })

    plan = `${PLAN}\n`
    expect(await resume()).toEqual({ ok: false, error: expect.stringContaining('the plan changed') })
    plan = PLAN
    exists = false
    expect(await resume()).toEqual({ ok: false, error: expect.stringContaining('worktree is gone') })
    exists = true
    expect(await c.orch.resumeRun({ projectId: 'other', projectPath: '/proj', runId })).toEqual({ ok: false, error: 'run not found' })
    expect(c.runner).toHaveBeenCalledTimes(4)

    const r = await resume()
    if (!r.ok) throw new Error(r.error)
    expect(await resume()).toEqual({ ok: false, error: 'the run is still active' })
    await r.finished
    expect(await resume()).toEqual({ ok: false, error: 'a done run cannot be resumed' })
  })
})

describe('orchestrator plan copy', () => {
  it('copies the plan into each task worktree, names it to the worker and never counts it as uncommitted work', async () => {
    const copied: [string, string, string][] = []
    const c = setup({
      uncommitted: async () => ['docs/plans/plan.md'],
      cfg: { checks: [{ name: 'unit', executable: 'node', args: ['--test'], timeoutMs: 5000 }] }
    })
    const orch = createOrchestrator({
      ...c.deps,
      copyPlan: async (wt, file, text) => {
        copied.push([wt, file, text])
      }
    })
    const r = await orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    const s = await r.finished
    expect(s.status).toBe('done')
    expect(copied.map(([wt, file]) => [wt, file])).toEqual([
      ['/wt/T1', 'plan.md'],
      ['/wt/T2', 'plan.md'],
      ['/wt/T3', 'plan.md'],
      ['/wt/T4', 'plan.md']
    ])
    expect(copied[0]?.[2]).toBe(PLAN)
    expect(c.runner.mock.calls.every((call) => call[0].planFile === 'plan.md')).toBe(true)
  })

  it('keeps going when the copy fails', async () => {
    const c = setup({})
    const orch = createOrchestrator({
      ...c.deps,
      copyPlan: async () => {
        throw new Error('disk full')
      }
    })
    const r = await orch.startRun(input)
    if (!r.ok) throw new Error(r.error)
    expect((await r.finished).status).toBe('done')
  })
})
