import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentUsage, RunUsage } from '../chat/activity'
import { openDatabase } from './database'
import { DatabaseVersionError, MIGRATIONS, migrate } from './migrations'
import { createRunStore, emptySummary, type RecordRunInput } from './runStore'

const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'

// Local noon, so day arithmetic is stable in any timezone.
const NOW = new Date(2026, 10, 16, 12, 0, 0).getTime()
const daysAgo = (n: number, hour = 12): number => {
  const d = new Date(NOW)
  d.setDate(d.getDate() - n)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

function usage(over: Partial<RunUsage> = {}): RunUsage {
  return {
    costUsd: 0.5,
    durationMs: 1000,
    isError: false,
    models: [
      {
        model: 'm1',
        costUsd: 0.5,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5
      }
    ],
    mainTokens: { inputTokens: 60, outputTokens: 30, cacheReadTokens: 6, cacheCreationTokens: 3 },
    ...over
  }
}

const agent = (name: string, over: Partial<AgentUsage> = {}): AgentUsage => ({
  agent: name,
  steps: 2,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 1,
  cacheCreationTokens: 1,
  approximate: name !== 'main',
  ...over
})

let n = 0
function run(over: Partial<RecordRunInput> = {}): RecordRunInput {
  return {
    runId: `run-${++n}`,
    projectId: P1,
    startedAt: NOW,
    usage: usage(),
    agents: [agent('main'), agent('reviewer')],
    ...over
  }
}

describe('migrations', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const tmpFile = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'desk-db-'))
    dirs.push(d)
    return join(d, 'nested', 'test.db')
  }

  it('creates tables and indexes, sets user_version, enables WAL, and re-open is a no-op', () => {
    const file = tmpFile()
    const db = openDatabase(file)
    const names = (type: string): string[] =>
      (
        db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as { name: string }[]
      ).map((r) => r.name)
    expect(names('table')).toEqual(expect.arrayContaining(['runs', 'usage_models', 'usage_agents']))
    expect(names('index')).toContain('idx_runs_project_started')
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(migrate(db)).toBe(0)
    db.close()

    const again = openDatabase(file)
    expect(again.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    expect(migrate(again)).toBe(0)
    again.close()
  })

  it('throws a typed error for a newer user_version', () => {
    const raw = new Database(':memory:')
    raw.pragma(`user_version = ${MIGRATIONS.length + 1}`)
    expect(() => migrate(raw)).toThrow(DatabaseVersionError)
    raw.close()
  })

  it('rolls back a failing migration and leaves user_version unchanged', () => {
    const raw = new Database(':memory:')
    expect(() => migrate(raw, ['CREATE TABLE a (x INTEGER);', 'CREATE TABLE a (x INTEGER);'])).toThrow()
    expect(raw.pragma('user_version', { simple: true })).toBe(1)
    raw.close()
  })
})

describe('RunStore', () => {
  const setup = () => {
    const db = openDatabase(':memory:')
    return { db, store: createRunStore(db, () => NOW) }
  }

  it('writes a run with its model and agent rows', () => {
    const { db, store } = setup()
    store.recordRun(run())
    const count = (t: string): number =>
      (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c
    expect(count('runs')).toBe(1)
    expect(count('usage_models')).toBe(1)
    expect(count('usage_agents')).toBe(2)
  })

  it('writes nothing when a failure happens halfway', () => {
    const { db, store } = setup()
    const bad = run({
      usage: usage({
        models: [
          { model: 'ok', costUsd: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
          { model: null as unknown as string, costUsd: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }
        ]
      })
    })
    expect(() => store.recordRun(bad)).toThrow()
    for (const t of ['runs', 'usage_models', 'usage_agents']) {
      expect((db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c).toBe(0)
    }
  })

  it('rejects a duplicate run id without partial rows', () => {
    const { db, store } = setup()
    const r = run()
    store.recordRun(r)
    expect(() => store.recordRun(r)).toThrow()
    expect((db.prepare('SELECT COUNT(*) AS c FROM usage_agents').get() as { c: number }).c).toBe(2)
  })

  it('returns an empty summary for an empty window', () => {
    const { store } = setup()
    expect(store.summary({ projectId: null, days: 7 })).toEqual(emptySummary(7))
    expect(store.summary({ projectId: P1, days: 7 })).toEqual(emptySummary(7))
  })

  it('summarizes by day, agent and project within the window', () => {
    const { store } = setup()
    store.recordRun(run({ startedAt: daysAgo(0, 0) })) // today, just after local midnight
    store.recordRun(run({ startedAt: daysAgo(0, 23) }))
    store.recordRun(run({ startedAt: daysAgo(2), projectId: P2, usage: usage({ costUsd: 1.25 }) }))
    store.recordRun(run({ startedAt: daysAgo(10) })) // outside a 7-day window
    store.recordRun(run({ startedAt: daysAgo(6, 0) })) // first day of a 7-day window

    const all = store.summary({ projectId: null, days: 7 })
    expect(all.estimated).toBe(true)
    expect(all.days).toBe(7)
    expect(all.totals).toEqual({
      runs: 4,
      costUsd: 0.5 + 0.5 + 1.25 + 0.5,
      inputTokens: 400,
      outputTokens: 200,
      cacheReadTokens: 40,
      cacheCreationTokens: 20
    })
    expect(all.byDay.map((d) => d.runs)).toEqual([1, 1, 2])
    const days = all.byDay.map((d) => d.day)
    expect([...days].sort()).toEqual(days)
    expect(all.byDay[2]).toMatchObject({ runs: 2, costUsd: 1, inputTokens: 200, outputTokens: 100 })
    expect(all.byProject).toEqual([
      { projectId: P1, runs: 3, costUsd: 1.5 },
      { projectId: P2, runs: 1, costUsd: 1.25 }
    ])
    const main = all.byAgent.find((a) => a.agent === 'main')
    const reviewer = all.byAgent.find((a) => a.agent === 'reviewer')
    expect(main).toMatchObject({ steps: 8, inputTokens: 40, approximate: false })
    expect(reviewer).toMatchObject({ steps: 8, approximate: true })

    const one = store.summary({ projectId: P1, days: 7 })
    expect(one.totals.runs).toBe(3)
    expect(one.byProject).toEqual([])

    expect(store.summary({ projectId: null, days: 1 }).totals.runs).toBe(2)
    expect(store.summary({ projectId: null, days: 30 }).totals.runs).toBe(5)
  })

  it('treats a missing cost as zero in sums', () => {
    const { store } = setup()
    store.recordRun(run({ usage: usage({ costUsd: null, durationMs: null, isError: true }) }))
    const s = store.summary({ projectId: null, days: 1 })
    expect(s.totals.costUsd).toBe(0)
    expect(s.totals.runs).toBe(1)
  })

  it('uses main-loop tokens for run totals when there is no model usage', () => {
    const { store } = setup()
    store.recordRun(run({ usage: usage({ models: [] }) }))
    expect(store.summary({ projectId: null, days: 1 }).totals.inputTokens).toBe(60)
  })

  it('round-trips hostile agent and model strings', () => {
    const { db, store } = setup()
    const evil = `x'); DROP TABLE runs;-- "é 日本語 \u{1F600}`
    store.recordRun(
      run({
        agents: [agent(evil)],
        usage: usage({
          models: [
            { model: evil, costUsd: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }
          ]
        })
      })
    )
    expect(store.summary({ projectId: null, days: 1 }).byAgent[0]?.agent).toBe(evil)
    expect((db.prepare('SELECT model FROM usage_models').get() as { model: string }).model).toBe(evil)
    expect((db.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number }).c).toBe(1)
  })
})
