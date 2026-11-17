import type Database from 'better-sqlite3'
import type { UsageSummary } from '../../shared/ipc'
import type { AgentUsage, RunUsage } from '../chat/activity'

export interface RecordRunInput {
  runId: string
  projectId: string
  /** Epoch milliseconds. */
  startedAt: number
  usage: RunUsage
  agents: AgentUsage[]
}

export interface SummaryQuery {
  projectId: string | null
  days: number
}

/**
 * `summary` validates `days` itself: anything that is not an integer in 1..365
 * (NaN, fractions, out of range) throws a RangeError. The IPC handler already
 * validates with zod and maps a throw to an empty summary, so behavior matches.
 */
export const MIN_DAYS = 1
export const MAX_DAYS = 365

export interface RunStore {
  recordRun(input: RecordRunInput): void
  summary(query: SummaryQuery): UsageSummary
}

export function emptySummary(days: number): UsageSummary {
  return {
    days,
    estimated: true,
    totals: {
      runs: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    },
    byDay: [],
    byAgent: [],
    byProject: []
  }
}

/** Local calendar day as YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** First local day of a window of `days` days ending today (inclusive). */
function windowStartDay(days: number, now: number): string {
  const d = new Date(now)
  d.setHours(12, 0, 0, 0) // noon avoids DST edge cases when subtracting days
  d.setDate(d.getDate() - (days - 1))
  return localDay(d.getTime())
}

/** Run cost: the reported total, else the sum of per-model costs, else NULL. */
function runCost(u: RunUsage): number | null {
  if (u.costUsd !== null) return u.costUsd
  const costs = u.models.map((m) => m.costUsd).filter((c): c is number => typeof c === 'number')
  return costs.length > 0 ? costs.reduce((a, c) => a + c, 0) : null
}

interface TotalsRow {
  runs: number
  cost: number
  i: number
  o: number
  cr: number
  cc: number
}
interface DayRow {
  day: string
  runs: number
  cost: number
  i: number
  o: number
}
interface AgentRow {
  agent: string
  steps: number
  i: number
  o: number
  cr: number
  cc: number
  approx: number
}
interface ProjectRow {
  project_id: string
  runs: number
  cost: number
}

export function createRunStore(db: Database.Database, now: () => number = Date.now): RunStore {
  const insertRun = db.prepare(
    `INSERT INTO runs (id, project_id, started_at, day, status, cost_usd, duration_ms,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insertModel = db.prepare(
    `INSERT INTO usage_models (run_id, model, cost_usd, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const insertAgent = db.prepare(
    `INSERT INTO usage_agents (run_id, agent, steps, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, approximate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )

  const write = db.transaction((r: RecordRunInput) => {
    // Run totals include subagents (from per-model usage); fall back to the main loop.
    const t =
      r.usage.models.length > 0
        ? r.usage.models.reduce(
            (a, m) => ({
              inputTokens: a.inputTokens + m.inputTokens,
              outputTokens: a.outputTokens + m.outputTokens,
              cacheReadTokens: a.cacheReadTokens + m.cacheReadTokens,
              cacheCreationTokens: a.cacheCreationTokens + m.cacheCreationTokens
            }),
            { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
          )
        : r.usage.mainTokens
    insertRun.run(
      r.runId,
      r.projectId,
      Math.round(r.startedAt),
      localDay(r.startedAt),
      r.usage.isError ? 'error' : 'success',
      runCost(r.usage),
      r.usage.durationMs,
      t.inputTokens,
      t.outputTokens,
      t.cacheReadTokens,
      t.cacheCreationTokens
    )
    for (const m of r.usage.models) {
      insertModel.run(
        r.runId,
        m.model,
        m.costUsd,
        m.inputTokens,
        m.outputTokens,
        m.cacheReadTokens,
        m.cacheCreationTokens
      )
    }
    for (const a of r.agents) {
      insertAgent.run(
        r.runId,
        a.agent,
        a.steps,
        a.inputTokens,
        a.outputTokens,
        a.cacheReadTokens,
        a.cacheCreationTokens,
        a.approximate ? 1 : 0
      )
    }
  })

  // `? IS NULL OR project_id = ?` keeps the statements static (no string-built SQL).
  const totalsStmt = db.prepare(
    `SELECT COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS cost,
       COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o,
       COALESCE(SUM(cache_read_tokens), 0) AS cr, COALESCE(SUM(cache_creation_tokens), 0) AS cc
     FROM runs WHERE day >= ? AND day <= ? AND (? IS NULL OR project_id = ?)`
  )
  const dayStmt = db.prepare(
    `SELECT day, COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS cost,
       SUM(input_tokens) AS i, SUM(output_tokens) AS o
     FROM runs WHERE day >= ? AND day <= ? AND (? IS NULL OR project_id = ?)
     GROUP BY day ORDER BY day ASC`
  )
  const agentStmt = db.prepare(
    `SELECT a.agent AS agent, SUM(a.steps) AS steps, SUM(a.input_tokens) AS i,
       SUM(a.output_tokens) AS o, SUM(a.cache_read_tokens) AS cr,
       SUM(a.cache_creation_tokens) AS cc, MAX(a.approximate) AS approx
     FROM usage_agents a JOIN runs r ON r.id = a.run_id
     WHERE r.day >= ? AND r.day <= ? AND (? IS NULL OR r.project_id = ?)
     GROUP BY a.agent ORDER BY (SUM(a.input_tokens) + SUM(a.output_tokens)) DESC, a.agent ASC`
  )
  const projectStmt = db.prepare(
    `SELECT project_id, COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS cost
     FROM runs WHERE day >= ? AND day <= ?
     GROUP BY project_id ORDER BY cost DESC, project_id ASC`
  )

  return {
    recordRun(input) {
      write(input)
    },
    summary({ projectId, days }) {
      if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
        throw new RangeError(`days must be an integer between ${MIN_DAYS} and ${MAX_DAYS}`)
      }
      const nowMs = now()
      const start = windowStartDay(days, nowMs)
      const end = localDay(nowMs) // upper bound: runs with a future startedAt are excluded
      const t = totalsStmt.get(start, end, projectId, projectId) as TotalsRow
      const byDay = (dayStmt.all(start, end, projectId, projectId) as DayRow[]).map((r) => ({
        day: r.day,
        runs: r.runs,
        costUsd: r.cost,
        inputTokens: r.i,
        outputTokens: r.o
      }))
      const byAgent = (agentStmt.all(start, end, projectId, projectId) as AgentRow[]).map((r) => ({
        agent: r.agent,
        steps: r.steps,
        inputTokens: r.i,
        outputTokens: r.o,
        cacheReadTokens: r.cr,
        cacheCreationTokens: r.cc,
        approximate: r.approx === 1
      }))
      const byProject =
        projectId === null
          ? (projectStmt.all(start, end) as ProjectRow[]).map((r) => ({
              projectId: r.project_id,
              runs: r.runs,
              costUsd: r.cost
            }))
          : []
      return {
        days,
        estimated: true,
        totals: {
          runs: t.runs,
          costUsd: t.cost,
          inputTokens: t.i,
          outputTokens: t.o,
          cacheReadTokens: t.cr,
          cacheCreationTokens: t.cc
        },
        byDay,
        byAgent,
        byProject
      }
    }
  }
}
