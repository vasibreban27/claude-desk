import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppInfo } from '../../shared/ipc'
import { defaultSettings } from '../../shared/settings'
import { migrate } from '../db/migrations'
import { createPipelineStore, type PipelineStore } from '../db/pipelineStore'
import type { GitStatusResult } from '../git/status'
import type { Orchestrator, RunSummary, StartRunResult } from './orchestrator'
import { createPipelineService, type PipelineService, type PipelineServiceDeps } from './service'
import type { WorktreeManager } from './worktrees'

const PID = '11111111-1111-4111-8111-111111111111'

function flowTask(id: string, over: Record<string, string> = {}): string {
  const f: Record<string, string> = {
    Status: '[ ] todo',
    Worker: 'node-developer',
    Size: 'S',
    Sensitive: 'no',
    Contract: 'none',
    Owns: `src/${id}.ts`,
    'Read first': '`src/a.ts`',
    'Depends on': 'none',
    'Done when': '`npm test`',
    ...over
  }
  const lines = Object.entries(f).map(([k, v]) => `- ${k}: ${v}`)
  return [`### ${id}: Title ${id}`, ...lines, '- Acceptance criteria:', '  - Given x When y Then z'].join('\n')
}
const FLOW = `Format: flow-plan/1\n\n# Demo\n\n## Wave 1: one\n\n${flowTask('T1')}\n\n${flowTask('T2', { Owns: 'src/b.ts' })}\n`
const LEGACY = `# Plan: Old\n\n## 7. Tasks\n\n### Wave 1\n\n### T1: Title\n- Status: [ ] todo\n- Worker: node-developer\n- Contract: none\n- Owns: \`src/a.ts\`\n- Depends on: none\n- Acceptance criteria:\n  - Given x When y Then z\n`

const VALID: AppInfo['toolkit'] = { status: 'valid', path: '/tk', version: '1' }

describe('pipeline service', () => {
  let root: string
  let project: string
  let plans: string
  let store: PipelineStore
  let startRun: ReturnType<typeof vi.fn<Orchestrator['startRun']>>
  let cancel: ReturnType<typeof vi.fn<Orchestrator['cancel']>>
  let resumeRun: ReturnType<typeof vi.fn<Orchestrator['resumeRun']>>
  let removeRun: ReturnType<typeof vi.fn<WorktreeManager['removeRun']>>
  let branch: GitStatusResult
  let toolkit: AppInfo['toolkit']
  let service: PipelineService

  function build(overrides: Partial<PipelineServiceDeps> = {}): PipelineService {
    return createPipelineService({
      projects: { get: async (id) => (id === PID ? { id, path: project, name: 'p', branch: 'main', dirty: false, addedAt: '' } : undefined) },
      store: overrides.store ?? store,
      orchestrator: { startRun, resumeRun, cancel },
      getToolkit: () => toolkit,
      readBranch: async () => branch,
      createManager: () => ({ removeRun }) as unknown as WorktreeManager,
      ...overrides
    })
  }

  function seedRun(id: string, planPath = path.join(plans, 'a.md')): void {
    store.createRun({
      id,
      projectId: PID,
      planPath,
      planSha256: 'x',
      baseBranch: 'main',
      baseCommit: 'c',
      integrationBranch: `run/${id}`,
      integrationPath: '/w',
      tasks: [
        { taskId: 'T2', title: 'two', worker: 'node-developer', wave: 2, dependsOn: ['T1'] },
        { taskId: 'T1', title: 'one', worker: 'node-developer', wave: 1, dependsOn: [] }
      ]
    })
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'svc-'))
    project = path.join(root, 'proj')
    plans = path.join(project, 'docs', 'plans')
    mkdirSync(plans, { recursive: true })
    const db = new Database(':memory:')
    migrate(db)
    let t = 1_700_000_000_000
    store = createPipelineStore(db, () => (t += 1000))
    startRun = vi.fn<Orchestrator['startRun']>()
    cancel = vi.fn<Orchestrator['cancel']>(() => true)
    resumeRun = vi.fn<Orchestrator['resumeRun']>()
    removeRun = vi.fn<WorktreeManager['removeRun']>(async () => ({ ok: true }))
    branch = { ok: true, branch: 'main', dirty: false }
    toolkit = VALID
    service = build()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const started = (runId: string): { result: StartRunResult; finish: (s?: Partial<RunSummary>) => void } => {
    let finish: (s?: Partial<RunSummary>) => void = () => undefined
    const finished = new Promise<RunSummary>((resolve) => {
      finish = (s) => resolve({ runId, status: 'done', reason: null, tasks: [], ...s })
    })
    return { result: { ok: true, runId, finished }, finish }
  }

  describe('listPlans', () => {
    it('lists top-level markdown files sorted, with counts and errors', async () => {
      writeFileSync(path.join(plans, 'b.md'), FLOW)
      writeFileSync(path.join(plans, 'a.md'), LEGACY)
      writeFileSync(path.join(plans, 'c.md'), '# nothing here\n')
      writeFileSync(path.join(plans, 'notes.txt'), 'x')
      mkdirSync(path.join(plans, 'sub.md'))
      mkdirSync(path.join(plans, 'sub'))
      writeFileSync(path.join(plans, 'sub', 'd.md'), FLOW)
      const r = await service.listPlans(PID)
      if (!r.ok) throw new Error(r.error)
      expect(r.plans.map((p) => p.file)).toEqual(['a.md', 'b.md', 'c.md'])
      expect(r.plans[0]).toMatchObject({ format: 'legacy', ok: true, taskCount: 1, waveCount: 1, title: expect.stringContaining('Old') })
      expect(r.plans[1]).toMatchObject({ format: 'flow-plan/1', ok: true, taskCount: 2, waveCount: 1, errorCount: 0 })
      expect(r.plans[2]?.ok).toBe(false)
      expect(r.plans[2]?.errorCount).toBeGreaterThan(0)
    })

    it('caps entries at 100 and errors at 20', async () => {
      for (let i = 0; i < 105; i++) writeFileSync(path.join(plans, `p${String(i).padStart(3, '0')}.md`), 'nope')
      const many = flowPlanWithManyErrors()
      writeFileSync(path.join(plans, 'p000.md'), many)
      const r = await service.listPlans(PID)
      if (!r.ok) throw new Error(r.error)
      expect(r.plans).toHaveLength(100)
      expect(r.plans[0]?.errors.length).toBeLessThanOrEqual(20)
      expect(r.plans[0]?.errorCount).toBeGreaterThan(20)
    })

    it('gives an empty list without docs/plans and not-found for an unknown project', async () => {
      rmSync(plans, { recursive: true })
      expect(await service.listPlans(PID)).toEqual({ ok: true, plans: [] })
      expect(await service.listPlans('22222222-2222-4222-8222-222222222222')).toEqual({ ok: false, error: 'not-found' })
    })

    it('skips symlinks', async () => {
      writeFileSync(path.join(root, 'outside.md'), FLOW)
      try {
        symlinkSync(path.join(root, 'outside.md'), path.join(plans, 'link.md'))
      } catch {
        return // no symlink permission on this machine
      }
      writeFileSync(path.join(plans, 'real.md'), FLOW)
      const r = await service.listPlans(PID)
      if (!r.ok) throw new Error(r.error)
      expect(r.plans.map((p) => p.file)).toEqual(['real.md'])
    })
  })

  function flowPlanWithManyErrors(): string {
    const tasks = Array.from({ length: 30 }, (_, i) => flowTask(`T${i + 1}`, { Size: 'L', Owns: `src/f${i}.ts` })).join('\n\n')
    return `Format: flow-plan/1\n\n# Many\n\n## Wave 1\n\n${tasks}\n`
  }

  describe('start', () => {
    beforeEach(() => writeFileSync(path.join(plans, 'a.md'), FLOW))

    it('refuses names that fail the pattern or are missing, without calling the orchestrator', async () => {
      expect(await service.start(PID, '../a.md')).toMatchObject({ ok: false, error: 'invalid-plan' })
      expect(await service.start(PID, 'a.txt')).toMatchObject({ ok: false, error: 'invalid-plan' })
      expect(await service.start(PID, 'missing.md')).toEqual({ ok: false, error: 'not-found' })
      expect(await service.start('22222222-2222-4222-8222-222222222222', 'a.md')).toEqual({ ok: false, error: 'not-found' })
      mkdirSync(path.join(plans, 'dir.md'))
      expect(await service.start(PID, 'dir.md')).toEqual({ ok: false, error: 'not-found' })
      expect(startRun).not.toHaveBeenCalled()
    })

    it('refuses a symlinked plan', async () => {
      writeFileSync(path.join(root, 'outside.md'), FLOW)
      try {
        symlinkSync(path.join(root, 'outside.md'), path.join(plans, 'link.md'))
      } catch {
        return
      }
      expect(await service.start(PID, 'link.md')).toEqual({ ok: false, error: 'not-found' })
      expect(startRun).not.toHaveBeenCalled()
    })

    it('checks detached head, toolkit, plan and busy in that order', async () => {
      writeFileSync(path.join(plans, 'bad.md'), 'Format: flow-plan/1\n\n# x\n')
      branch = { ok: true, branch: null, dirty: false }
      toolkit = { status: 'invalid', path: null, version: null }
      expect(await service.start(PID, 'bad.md')).toEqual({ ok: false, error: 'detached-head' })
      branch = { ok: true, branch: 'main', dirty: false }
      expect(await service.start(PID, 'bad.md')).toEqual({ ok: false, error: 'no-toolkit' })
      toolkit = VALID
      const bad = await service.start(PID, 'bad.md')
      expect(bad).toMatchObject({ ok: false, error: 'invalid-plan' })
      expect(bad.ok === false && bad.message).toMatch(/^line \d+/)

      const s = started('run-1')
      startRun.mockResolvedValueOnce(s.result)
      expect(await service.start(PID, 'a.md')).toEqual({ ok: true, runId: 'run-1' })
      expect(await service.start(PID, 'bad.md')).toMatchObject({ ok: false, error: 'invalid-plan' })
      expect(await service.start(PID, 'a.md')).toEqual({ ok: false, error: 'busy' })
      expect(startRun).toHaveBeenCalledTimes(1)
    })

    it('returns at once while the run continues and frees the project when it ends', async () => {
      const s = started('run-1')
      startRun.mockResolvedValueOnce(s.result)
      const r = await service.start(PID, 'a.md')
      expect(r).toEqual({ ok: true, runId: 'run-1' })
      expect(startRun).toHaveBeenCalledWith({
        projectId: PID,
        projectPath: project,
        planPath: path.join(plans, 'a.md'),
        baseBranch: 'main',
        runId: expect.stringMatching(/^[0-9a-f-]{36}$/)
      })
      expect(await service.start(PID, 'a.md')).toEqual({ ok: false, error: 'busy' })
      s.finish()
      await vi.waitFor(async () => {
        startRun.mockResolvedValueOnce(started('run-2').result)
        expect(await service.start(PID, 'a.md')).toEqual({ ok: true, runId: 'run-2' })
      })
    })

    it('maps orchestrator failures and frees the project', async () => {
      startRun.mockResolvedValueOnce({ ok: false, error: 'database error: storage-error' })
      expect(await service.start(PID, 'a.md')).toEqual({ ok: false, error: 'storage-unavailable' })
      startRun.mockResolvedValueOnce({ ok: false, error: 'base branch not found: main' })
      expect(await service.start(PID, 'a.md')).toEqual({ ok: false, error: 'start-failed', message: 'base branch not found: main' })
      startRun.mockRejectedValueOnce(new Error('boom'))
      expect(await service.start(PID, 'a.md')).toMatchObject({ ok: false, error: 'start-failed' })
      startRun.mockResolvedValueOnce(started('run-3').result)
      expect(await service.start(PID, 'a.md')).toEqual({ ok: true, runId: 'run-3' })
    })

    it('reports a git failure as start-failed', async () => {
      branch = { ok: false, error: 'not-a-git-repo' }
      expect(await service.start(PID, 'a.md')).toMatchObject({ ok: false, error: 'start-failed' })
    })
  })

  describe('automatic delivery', () => {
    beforeEach(() => writeFileSync(path.join(plans, 'a.md'), FLOW))

    it('opens a PR after a successful run and uses the policy captured at start', async () => {
      const policy = { value: 'open-pr' as 'open-pr' | 'manual' }
      const openPullRequest = vi.fn(async () => ({ ok: true as const, url: 'https://example.test/pr/1', branch: 'review/r1', host: 'github' as const }))
      const onDelivery = vi.fn()
      service = build({
        settings: { get: () => ({ settings: { ...defaultSettings(), delivery: policy.value }, notice: null }) },
        openPullRequest,
        onDelivery
      })
      const s = started('r1')
      startRun.mockImplementationOnce(async () => { seedRun('r1'); return s.result })
      expect(await service.start(PID, 'a.md')).toEqual({ ok: true, runId: 'r1' })
      policy.value = 'manual'
      store.setRunStatus('r1', 'done', 1)
      s.finish()
      await vi.waitFor(() => expect(openPullRequest).toHaveBeenCalledTimes(1))
      expect(onDelivery).toHaveBeenCalledWith(PID, 'r1', expect.stringContaining('pull request opened'), 'ok')
    })

    it('merges locally after success and does not deliver a failed run', async () => {
      const mergeRun = vi.fn(async () => ({ ok: true as const, head: 'abc123', planCommitted: true }))
      service = build({
        settings: { get: () => ({ settings: { ...defaultSettings(), delivery: 'merge-local' }, notice: null }) },
        mergeRun
      })
      const failed = started('r1')
      startRun.mockImplementationOnce(async () => { seedRun('r1'); return failed.result })
      await service.start(PID, 'a.md')
      store.setRunStatus('r1', 'failed', 1)
      failed.finish({ status: 'failed' })
      const done = started('r2')
      startRun.mockImplementationOnce(async () => { seedRun('r2'); return done.result })
      await vi.waitFor(async () => expect(await service.start(PID, 'a.md')).toEqual({ ok: true, runId: 'r2' }))
      expect(mergeRun).not.toHaveBeenCalled()
      store.setRunStatus('r2', 'done', 2)
      done.finish()
      await vi.waitFor(() => expect(mergeRun).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(store.getRun('r2').ok).toBe(false))
    })
  })

  describe('resume', () => {
    beforeEach(() => writeFileSync(path.join(plans, 'a.md'), FLOW))

    it('refuses unknown runs and a missing toolkit without calling the orchestrator', async () => {
      expect(await service.resume(PID, 'nope')).toEqual({ ok: false, error: 'not-found' })
      seedRun('r1')
      expect(await service.resume('22222222-2222-4222-8222-222222222222', 'r1')).toEqual({ ok: false, error: 'not-found' })
      toolkit = { status: 'invalid', path: null, version: null }
      expect(await service.resume(PID, 'r1')).toEqual({ ok: false, error: 'no-toolkit' })
      expect(resumeRun).not.toHaveBeenCalled()
    })

    it('resumes, keeps the project busy until the run ends, and blocks a start meanwhile', async () => {
      seedRun('r1')
      const s = started('r1')
      resumeRun.mockResolvedValueOnce(s.result)
      expect(await service.resume(PID, 'r1')).toEqual({ ok: true, runId: 'r1' })
      expect(resumeRun).toHaveBeenCalledWith({ projectId: PID, projectPath: project, runId: 'r1' })
      expect(await service.start(PID, 'a.md')).toEqual({ ok: false, error: 'busy' })
      expect(await service.resume(PID, 'r1')).toEqual({ ok: false, error: 'busy' })
      s.finish()
      await vi.waitFor(async () => {
        startRun.mockResolvedValueOnce(started('run-2').result)
        expect(await service.start(PID, 'a.md')).toEqual({ ok: true, runId: 'run-2' })
      })
    })

    it('maps orchestrator refusals and frees the project', async () => {
      seedRun('r1')
      resumeRun.mockResolvedValueOnce({ ok: false, error: 'the plan changed since this run started: start a new run instead' })
      expect(await service.resume(PID, 'r1')).toEqual({
        ok: false,
        error: 'resume-failed',
        message: 'the plan changed since this run started: start a new run instead'
      })
      resumeRun.mockResolvedValueOnce({ ok: false, error: 'database error: storage-error' })
      expect(await service.resume(PID, 'r1')).toEqual({ ok: false, error: 'storage-unavailable' })
      resumeRun.mockRejectedValueOnce(new Error('boom'))
      expect(await service.resume(PID, 'r1')).toMatchObject({ ok: false, error: 'resume-failed' })
      startRun.mockResolvedValueOnce(started('run-3').result)
      expect(await service.start(PID, 'a.md')).toEqual({ ok: true, runId: 'run-3' })
    })
  })

  describe('status', () => {
    it('returns null without runs and not-found for an unknown project', async () => {
      expect(await service.status(PID)).toEqual({ ok: true, run: null })
      expect(await service.status('22222222-2222-4222-8222-222222222222')).toEqual({ ok: false, error: 'not-found' })
    })

    it('maps stage, fix rounds and findings into the task view', async () => {
      seedRun('r3')
      const findings = {
        blocking: 1,
        minor: 0,
        items: [{ reviewer: 'reviewer' as const, severity: 'blocker' as const, file: 'a.ts', line: 3, text: 'bad' }]
      }
      store.updateTask('r3', 'T1', { stage: 'fixing', fixRounds: 1, findings })
      const r = await service.status(PID)
      if (!r.ok || r.run === null) throw new Error('expected a run')
      expect(r.run.tasks[0]).toMatchObject({ stage: 'fixing', fixRounds: 1, findings })
      expect(r.run.tasks[1]).toMatchObject({ stage: null, fixRounds: null, findings: null })
    })

    it.each(['checks', 'review', 'fixing'] as const)('maps stage %s and minor-only findings', async (stage) => {
      seedRun('r4')
      const findings = {
        blocking: 0,
        minor: 1,
        items: [{ reviewer: 'security-auditor' as const, severity: 'nit' as const, file: 'b.ts', line: null, text: 'meh' }]
      }
      store.updateTask('r4', 'T1', { stage, fixRounds: 0, findings })
      const r = await service.status(PID)
      if (!r.ok || r.run === null) throw new Error('expected a run')
      expect(r.run.tasks[0]).toMatchObject({ stage, fixRounds: 0, findings })
    })

    it('a settled task view has its stage cleared while fix rounds and findings stay', async () => {
      seedRun('r5')
      const findings = { blocking: 1, minor: 0, items: [] }
      store.updateTask('r5', 'T1', { stage: 'fixing', fixRounds: 2, findings })
      store.updateTask('r5', 'T1', { status: 'failed', reason: 'review: blocking findings', stage: null })
      const r = await service.status(PID)
      if (!r.ok || r.run === null) throw new Error('expected a run')
      expect(r.run.tasks[0]).toMatchObject({ status: 'failed', stage: null, fixRounds: 2, findings })
    })

    it('returns the latest run as a view in wave order', async () => {
      seedRun('r1')
      seedRun('r2')
      store.updateTask('r2', 'T1', { status: 'done', commitSha: 'abcdef1234567', checksResult: 'passed', turns: 3, costUsd: 0.5, durationMs: 10 })
      const r = await service.status(PID)
      if (!r.ok || r.run === null) throw new Error('expected a run')
      expect(r.run).toMatchObject({ runId: 'r2', planFile: 'a.md', status: 'running', active: false, baseBranch: 'main', finishedAt: null })
      expect(r.run.createdAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/)
      expect(r.run.tasks.map((t) => t.taskId)).toEqual(['T1', 'T2'])
      expect(r.run.tasks[0]).toMatchObject({ commit: 'abcdef1', checks: 'passed', turns: 3, costUsd: 0.5, durationMs: 10, status: 'done' })
    })

    it('marks the run active while it is in flight', async () => {
      writeFileSync(path.join(plans, 'a.md'), FLOW)
      const s = started('r1')
      startRun.mockImplementationOnce(async () => {
        seedRun('r1')
        return s.result
      })
      await service.start(PID, 'a.md')
      const r = await service.status(PID)
      expect(r.ok && r.run?.active).toBe(true)
    })

    it('passes the generated run id to the orchestrator and is active from the first call, not after the final status', async () => {
      writeFileSync(path.join(plans, 'a.md'), FLOW)
      const s = started('fixed-id')
      let seen: string | undefined
      startRun.mockImplementationOnce(async (input) => {
        seen = input.runId
        seedRun(input.runId ?? 'none')
        // the service already reports the run as active while the orchestrator is starting
        const during = await service.status(PID)
        expect(during.ok && during.run?.active).toBe(true)
        return { ok: true, runId: input.runId ?? 'none', finished: s.result.ok ? s.result.finished : Promise.reject(new Error('x')) }
      })
      const r = await service.start(PID, 'a.md')
      expect(r.ok && r.runId).toBe(seen)
      const id = seen ?? ''
      store.setRunStatus(id, 'done', 5)
      const after = await service.status(PID)
      expect(after.ok && after.run?.active).toBe(false)
      s.finish()
    })

    it('gives storage-unavailable when the store is down', async () => {
      const down = build({ store: createPipelineStore(null) })
      expect(await down.status(PID)).toEqual({ ok: false, error: 'storage-unavailable' })
    })
  })

  describe('cancel and discard', () => {
    it('returns not-found for another project or an unknown run', async () => {
      seedRun('r1')
      expect(await service.cancel(PID, 'nope')).toEqual({ ok: false, error: 'not-found' })
      expect(await service.discard(PID, 'nope')).toEqual({ ok: false, error: 'not-found' })
      expect(await service.cancel('22222222-2222-4222-8222-222222222222', 'r1')).toEqual({ ok: false, error: 'not-found' })
      store.createRun({
        id: 'other', projectId: 'zzz', planPath: 'x.md', planSha256: 'x', baseBranch: 'main', baseCommit: 'c',
        integrationBranch: 'run/other', integrationPath: '/w', tasks: []
      })
      expect(await service.cancel(PID, 'other')).toEqual({ ok: false, error: 'not-found' })
      expect(await service.discard(PID, 'other')).toEqual({ ok: false, error: 'not-found' })
      expect(cancel).not.toHaveBeenCalled()
    })

    it('cancels an active run, refuses a finished one and refuses to discard an active run', async () => {
      writeFileSync(path.join(plans, 'a.md'), FLOW)
      const s = started('r1')
      startRun.mockImplementationOnce(async () => {
        seedRun('r1')
        return s.result
      })
      await service.start(PID, 'a.md')
      expect(await service.discard(PID, 'r1')).toEqual({ ok: false, error: 'active' })
      expect(await service.cancel(PID, 'r1')).toEqual({ ok: true })
      expect(cancel).toHaveBeenCalledWith('r1')
      s.finish()
      await vi.waitFor(async () => {
        expect(await service.cancel(PID, 'r1')).toEqual({ ok: false, error: 'not-active' })
      })
    })

    it('refuses to discard a run stored as running that is not in the active map', async () => {
      seedRun('r1')
      expect(await service.discard(PID, 'r1')).toEqual({ ok: false, error: 'active' })
      expect(removeRun).not.toHaveBeenCalled()
      expect(store.getRun('r1').ok).toBe(true)
    })

    it('removes worktrees first and then deletes the rows', async () => {
      seedRun('r1')
      store.setRunStatus('r1', 'done', 1)
      removeRun.mockImplementationOnce(async () => {
        expect(store.getRun('r1').ok).toBe(true)
        return { ok: true }
      })
      expect(await service.discard(PID, 'r1')).toEqual({ ok: true })
      expect(removeRun).toHaveBeenCalledTimes(1)
      expect(store.getRun('r1')).toEqual({ ok: false, error: 'not-found' })
      expect(store.listTasks('r1')).toEqual({ ok: true, value: [] })
    })

    it('keeps the rows when removal fails', async () => {
      seedRun('r1')
      store.setRunStatus('r1', 'failed', 1)
      removeRun.mockResolvedValueOnce({ ok: false, error: 'git failed' })
      expect(await service.discard(PID, 'r1')).toEqual({ ok: false, error: 'cleanup-failed' })
      expect(store.getRun('r1').ok).toBe(true)
    })
  })
})
