import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { migrate } from './migrations'
import { createTraceStore, type TraceStore } from './traceStore'

const note = (runId: string, seq: number, text = 'hello'): TraceEvent => ({
  projectId: 'p1',
  runId,
  seq,
  at: '2026-11-20T10:00:00.000Z',
  taskId: null,
  role: 'pipeline',
  session: 'pipeline',
  agent: 'pipeline',
  parentId: null,
  kind: 'note',
  text,
  tone: 'info'
})

let db: Database.Database
let store: TraceStore

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  store = createTraceStore(db)
})

describe('traceStore', () => {
  it('stores a run and its events in order', () => {
    store.ensureRun({ runId: 'r1', projectId: 'p1', source: 'chat', title: 'hi', startedAt: 10 })
    store.ensureRun({ runId: 'r1', projectId: 'p1', source: 'chat', title: 'again', startedAt: 99 })
    store.insertEvents([note('r1', 1, 'b'), note('r1', 0, 'a'), note('unknown', 0)])
    expect(store.listEvents('p1', 'r1').map((e) => e.seq)).toEqual([0, 1])
    expect(store.listEvents('p2', 'r1')).toEqual([])
    expect(store.runCounters('r1')).toEqual({ nextSeq: 2, count: 2 })
    expect(store.runCounters('none')).toEqual({ nextSeq: 0, count: 0 })
    expect(store.listRuns('p1', 10)).toEqual([
      { runId: 'r1', projectId: 'p1', source: 'chat', title: 'hi', startedAt: 10, endedAt: null, status: 'running', events: 2 }
    ])
    store.endRun('r1', 'ok', 20)
    expect(store.listRuns('p1', 10)[0]).toMatchObject({ status: 'ok', endedAt: 20 })
  })

  it('takes title and status of pipeline runs from the pipeline', () => {
    db.prepare(
      `INSERT INTO pipeline_runs (id, project_id, plan_path, plan_sha256, base_branch, base_commit, integration_branch,
         integration_path, status, created_at, finished_at)
       VALUES ('pr', 'p1', '/proj/docs/plans/todo-api.md', 'x', 'main', 'c', 'run/pr', '/wt', 'failed', 1, 50)`
    ).run()
    store.ensureRun({ runId: 'pr', projectId: 'p1', source: 'pipeline', title: 'Pipeline run', startedAt: 5 })
    expect(store.listRuns('p1', 10)[0]).toMatchObject({ title: 'todo-api.md', status: 'error', endedAt: 50 })
  })

  it('skips rows that do not validate', () => {
    store.ensureRun({ runId: 'r1', projectId: 'p1', source: 'chat', title: 't', startedAt: 1 })
    db.prepare(`INSERT INTO trace_events (run_id, seq, data) VALUES ('r1', 0, 'not json'), ('r1', 1, '{"kind":"nope"}')`).run()
    store.insertEvents([note('r1', 2)])
    expect(store.listEvents('p1', 'r1').map((e) => e.seq)).toEqual([2])
  })

  it('prunes runs older than the cutoff but keeps each project latest runs', () => {
    for (let i = 0; i < 8; i++) {
      store.ensureRun({ runId: `a${i}`, projectId: 'p1', source: 'chat', title: 't', startedAt: i })
      store.insertEvents([{ ...note(`a${i}`, 0) }])
    }
    store.ensureRun({ runId: 'b0', projectId: 'p2', source: 'chat', title: 't', startedAt: 0 })
    store.ensureRun({ runId: 'fresh', projectId: 'p1', source: 'chat', title: 't', startedAt: 1000 })
    expect(store.prune(100, 5)).toBe(4)
    expect(store.listRuns('p1', 20).map((r) => r.runId)).toEqual(['fresh', 'a7', 'a6', 'a5', 'a4'])
    expect(store.listRuns('p2', 20).map((r) => r.runId)).toEqual(['b0'])
    expect(db.prepare('SELECT COUNT(*) AS n FROM trace_events').get()).toEqual({ n: 4 })
  })

  it('marks chat runs left running as failed, not pipeline runs', () => {
    store.ensureRun({ runId: 'c', projectId: 'p1', source: 'chat', title: 't', startedAt: 1 })
    store.ensureRun({ runId: 'x', projectId: 'p1', source: 'pipeline', title: 't', startedAt: 2 })
    store.markInterrupted(9)
    const runs = store.listRuns('p1', 10)
    expect(runs.find((r) => r.runId === 'c')).toMatchObject({ status: 'error', endedAt: 9 })
    expect(runs.find((r) => r.runId === 'x')).toMatchObject({ status: 'running' })
  })
})
