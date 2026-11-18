import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from './migrations'
import { createPipelineStore, withChangeEvents, type NewPipelineRun, type PipelineStore } from './pipelineStore'

function newRun(id: string): NewPipelineRun {
  return {
    id,
    projectId: 'p',
    planPath: 'docs/plans/x.md',
    planSha256: 'abc',
    baseBranch: 'main',
    baseCommit: 'deadbeef',
    integrationBranch: `run/${id}`,
    integrationPath: `/w/${id}-integration`,
    tasks: [
      { taskId: 'T1', title: 'one', worker: 'node-developer', wave: 1, dependsOn: [] },
      { taskId: 'T2', title: 'two', worker: 'node-developer', wave: 2, dependsOn: ['T1'] }
    ]
  }
}

describe('pipelineStore', () => {
  let db: Database.Database
  let store: PipelineStore

  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db)
    store = createPipelineStore(db, () => 1000)
  })

  it('creates a run with queued tasks', () => {
    const r = store.createRun(newRun('r1'))
    expect(r).toMatchObject({ ok: true, value: { id: 'r1', status: 'running', createdAt: 1000 } })
    const tasks = store.listTasks('r1')
    expect(tasks.ok && tasks.value.map((t) => [t.taskId, t.status, t.dependsOn])).toEqual([
      ['T1', 'queued', []],
      ['T2', 'queued', ['T1']]
    ])
  })

  it('rolls back the whole run when a task insert fails', () => {
    const bad = newRun('r1')
    bad.tasks.push({ ...bad.tasks[0]! })
    expect(store.createRun(bad)).toEqual({ ok: false, error: 'storage-error' })
    expect(store.getRun('r1')).toEqual({ ok: false, error: 'not-found' })
  })

  it('writes status, timings and checks result in one update', () => {
    store.createRun(newRun('r1'))
    const r = store.updateTask('r1', 'T1', {
      status: 'done',
      checksResult: 'passed',
      turns: 5,
      costUsd: 0.25,
      startedAt: 10,
      finishedAt: 20,
      durationMs: 10,
      commitSha: 'abc',
      branch: 'task/r1-t1'
    })
    expect(r).toMatchObject({
      ok: true,
      value: { status: 'done', checksResult: 'passed', turns: 5, costUsd: 0.25, durationMs: 10 }
    })
  })

  it('rejects invalid statuses and unknown rows without touching data', () => {
    store.createRun(newRun('r1'))
    expect(store.updateTask('r1', 'T1', { status: 'bogus' as never })).toEqual({
      ok: false,
      error: 'invalid'
    })
    expect(store.updateTask('r1', 'T1', { checksResult: 'maybe' as never })).toEqual({
      ok: false,
      error: 'invalid'
    })
    expect(store.updateTask('nope', 'T1', { status: 'done' })).toEqual({ ok: false, error: 'not-found' })
    expect(store.updateTask('r1', 'T9', { status: 'done' })).toEqual({ ok: false, error: 'not-found' })
    expect(store.setRunStatus('r1', 'blocked' as never)).toEqual({ ok: false, error: 'invalid' })
    expect(store.setRunStatus('nope', 'done')).toEqual({ ok: false, error: 'not-found' })
    const t = store.listTasks('r1')
    expect(t.ok && t.value.every((x) => x.status === 'queued')).toBe(true)
  })

  it('enforces status CHECK constraints in the schema', () => {
    store.createRun(newRun('r1'))
    expect(() => db.prepare(`UPDATE pipeline_tasks SET status = 'x'`).run()).toThrow()
    expect(() => db.prepare(`UPDATE pipeline_tasks SET checks_result = 'x'`).run()).toThrow()
    expect(() => db.prepare(`UPDATE pipeline_runs SET status = 'blocked'`).run()).toThrow()
  })

  it('returns an error result instead of throwing on a SQLite error', () => {
    store.createRun(newRun('r1'))
    db.close()
    expect(store.getRun('r1')).toEqual({ ok: false, error: 'storage-error' })
    expect(store.listTasks('r1')).toEqual({ ok: false, error: 'storage-error' })
    expect(store.updateTask('r1', 'T1', { status: 'done' })).toEqual({
      ok: false,
      error: 'storage-error'
    })
    expect(store.markInterrupted()).toEqual({ ok: false, error: 'storage-error' })
  })

  it('markInterrupted fails a run with a running task, fails that task and cancels its queued tasks', () => {
    store.createRun(newRun('r1'))
    store.createRun(newRun('r2'))
    store.updateTask('r1', 'T1', { status: 'running' })
    store.updateTask('r2', 'T1', { status: 'done' })
    store.setRunStatus('r2', 'done', 5)

    expect(store.markInterrupted(2000)).toEqual({ ok: true, value: 2 })
    const t1 = store.listTasks('r1')
    expect(t1.ok && t1.value[0]).toMatchObject({ status: 'failed', reason: 'interrupted', finishedAt: 2000 })
    expect(t1.ok && t1.value[1]).toMatchObject({ status: 'cancelled', reason: 'interrupted', finishedAt: 2000 })
    expect(store.getRun('r1')).toMatchObject({ value: { status: 'failed', finishedAt: 2000 } })
    expect(store.getRun('r2')).toMatchObject({ value: { status: 'done', finishedAt: 5 } })
    const t2 = store.listTasks('r2')
    expect(t2.ok && t2.value[0]).toMatchObject({ status: 'done', reason: null })
    expect(store.markInterrupted(3000)).toEqual({ ok: true, value: 0 })
  })

  it('markInterrupted fails a run that was killed between waves (no task running) and cancels its queued tasks', () => {
    store.createRun(newRun('r1'))
    store.updateTask('r1', 'T1', { status: 'done', commitSha: 'abc1234' })

    expect(store.markInterrupted(2000)).toEqual({ ok: true, value: 1 })
    expect(store.getRun('r1')).toMatchObject({ value: { status: 'failed', finishedAt: 2000 } })
    const t = store.listTasks('r1')
    expect(t.ok && t.value[0]).toMatchObject({ status: 'done', reason: null, commitSha: 'abc1234' })
    expect(t.ok && t.value[1]).toMatchObject({ status: 'cancelled', reason: 'interrupted', finishedAt: 2000 })
    expect(store.markInterrupted(3000)).toEqual({ ok: true, value: 0 })
  })

  it('markInterrupted fails a run killed right after it was created (every task still queued)', () => {
    store.createRun(newRun('r1'))

    expect(store.markInterrupted(2000)).toEqual({ ok: true, value: 2 })
    expect(store.getRun('r1')).toMatchObject({ value: { status: 'failed', finishedAt: 2000 } })
    const t = store.listTasks('r1')
    expect(t.ok && t.value.map((x) => [x.status, x.reason])).toEqual([
      ['cancelled', 'interrupted'],
      ['cancelled', 'interrupted']
    ])
  })

  it('markInterrupted leaves finished runs and their tasks alone, whatever state those tasks are in', () => {
    store.createRun(newRun('failedRun'))
    store.createRun(newRun('cancelledRun'))
    store.createRun(newRun('doneRun'))
    store.updateTask('failedRun', 'T1', { status: 'failed', reason: 'worker error' })
    store.setRunStatus('failedRun', 'failed', 7) // T2 stays queued: an older run, or a sweep that did not finish
    store.updateTask('cancelledRun', 'T1', { status: 'cancelled' })
    store.updateTask('cancelledRun', 'T2', { status: 'cancelled' })
    store.setRunStatus('cancelledRun', 'cancelled', 8)
    store.updateTask('doneRun', 'T1', { status: 'done' })
    store.updateTask('doneRun', 'T2', { status: 'done' })
    store.setRunStatus('doneRun', 'done', 9)

    expect(store.markInterrupted(2000)).toEqual({ ok: true, value: 0 })
    expect(store.getRun('failedRun')).toMatchObject({ value: { status: 'failed', finishedAt: 7 } })
    expect(store.getRun('cancelledRun')).toMatchObject({ value: { status: 'cancelled', finishedAt: 8 } })
    expect(store.getRun('doneRun')).toMatchObject({ value: { status: 'done', finishedAt: 9 } })
    const t = store.listTasks('failedRun')
    expect(t.ok && t.value.map((x) => [x.status, x.reason])).toEqual([
      ['failed', 'worker error'],
      ['queued', null]
    ])
  })

  it('returns the unavailable result without a database', () => {
    const s = createPipelineStore(null)
    const un = { ok: false, error: 'storage-unavailable' }
    expect(s.createRun(newRun('r1'))).toEqual(un)
    expect(s.updateTask('r1', 'T1', { status: 'done' })).toEqual(un)
    expect(s.setRunStatus('r1', 'done')).toEqual(un)
    expect(s.getRun('r1')).toEqual(un)
    expect(s.listTasks('r1')).toEqual(un)
    expect(s.markInterrupted()).toEqual(un)
  })
  it('finds the latest run of a project', () => {
    let t = 1000
    const s = createPipelineStore(db, () => (t += 10))
    expect(s.latestRunForProject('p')).toEqual({ ok: true, value: null })
    s.createRun(newRun('r1'))
    s.createRun(newRun('r2'))
    s.createRun({ ...newRun('r3'), projectId: 'other' })
    const r = s.latestRunForProject('p')
    expect(r.ok && r.value?.id).toBe('r2')
  })

  it('deletes a run and its tasks together', () => {
    store.createRun(newRun('r1'))
    store.createRun(newRun('r2'))
    expect(store.deleteRun('r1')).toEqual({ ok: true, value: true })
    expect(store.getRun('r1')).toEqual({ ok: false, error: 'not-found' })
    expect(store.listTasks('r1')).toEqual({ ok: true, value: [] })
    expect(store.listTasks('r2')).toMatchObject({ ok: true })
    expect(db.prepare('SELECT COUNT(*) AS n FROM pipeline_tasks').get()).toEqual({ n: 2 })
    expect(store.deleteRun('r1')).toEqual({ ok: false, error: 'not-found' })
  })

  it('reports storage-unavailable for the new queries without a database', () => {
    const down = createPipelineStore(null)
    expect(down.latestRunForProject('p')).toEqual({ ok: false, error: 'storage-unavailable' })
    expect(down.deleteRun('r1')).toEqual({ ok: false, error: 'storage-unavailable' })
  })

  describe('withChangeEvents', () => {
    it('emits one event per successful write and keeps the results', () => {
      const emit = vi.fn()
      const s = withChangeEvents(store, emit)
      expect(s.createRun(newRun('r1')).ok).toBe(true)
      expect(s.updateTask('r1', 'T1', { status: 'running' })).toMatchObject({ ok: true, value: { status: 'running' } })
      expect(s.setRunStatus('r1', 'done', 5)).toMatchObject({ ok: true })
      expect(s.deleteRun('r1')).toEqual({ ok: true, value: true })
      expect(emit.mock.calls).toEqual([
        [{ projectId: 'p', runId: 'r1' }],
        [{ projectId: 'p', runId: 'r1' }],
        [{ projectId: 'p', runId: 'r1' }],
        [{ projectId: 'p', runId: 'r1' }]
      ])
    })

    it('does not emit for failed writes and survives a throwing emit', () => {
      const emit = vi.fn(() => {
        throw new Error('listener broke')
      })
      const s = withChangeEvents(store, emit)
      expect(s.updateTask('missing', 'T1', { status: 'running' })).toEqual({ ok: false, error: 'not-found' })
      expect(emit).not.toHaveBeenCalled()
      expect(s.createRun(newRun('r1')).ok).toBe(true)
      expect(emit).toHaveBeenCalledTimes(1)
      expect(store.getRun('r1').ok).toBe(true)
    })
  })
})
