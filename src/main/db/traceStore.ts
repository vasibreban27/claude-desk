import type Database from 'better-sqlite3'
import path from 'node:path'
import {
  TRACE_RUN_STATUSES,
  TRACE_SOURCES,
  traceEventSchema,
  type TraceEvent,
  type TraceRun,
  type TraceRunStatus,
  type TraceSource
} from '../../shared/trace'

/** Detailed Activity storage: one row per run and one JSON row per event (previews only). */

export interface NewTraceRun {
  runId: string
  projectId: string
  source: TraceSource
  title: string
  startedAt: number
}

export interface TraceStore {
  /** Inserts the run unless it exists. */
  ensureRun(run: NewTraceRun): void
  endRun(runId: string, status: Exclude<TraceRunStatus, 'running'>, endedAt: number): void
  /** Inserts events in one transaction; an event of an unknown run is skipped. */
  insertEvents(events: readonly TraceEvent[]): void
  /** Next free seq and the number of events of a run (0, 0 when none). */
  runCounters(runId: string): { nextSeq: number; count: number }
  /** Latest runs of a project, newest first; pipeline runs take their title and status from the pipeline. */
  listRuns(projectId: string, limit: number): TraceRun[]
  /** All events of a run, oldest first; rows that do not validate are skipped. */
  listEvents(projectId: string, runId: string): TraceEvent[]
  /** Deletes runs that started before `before`, except each project's latest `keepRuns`. Returns runs deleted. */
  prune(before: number, keepRuns: number): number
  /** Chat runs left `running` by a closed app become `error`. */
  markInterrupted(at: number): void
}

interface RunRow {
  id: string
  project_id: string
  source: string
  title: string
  started_at: number
  ended_at: number | null
  status: string
  plan_path: string | null
  p_status: string | null
  p_finished: number | null
  events: number
}

const PIPELINE_STATUS: Record<string, TraceRunStatus> = {
  running: 'running',
  done: 'ok',
  failed: 'error',
  cancelled: 'cancelled'
}

const isSource = (v: string): v is TraceSource => (TRACE_SOURCES as readonly string[]).includes(v)
const isStatus = (v: string): v is TraceRunStatus => (TRACE_RUN_STATUSES as readonly string[]).includes(v)

function toRun(r: RunRow): TraceRun | null {
  if (!isSource(r.source)) return null
  const pipelineStatus = r.p_status !== null ? PIPELINE_STATUS[r.p_status] : undefined
  const status = pipelineStatus ?? (isStatus(r.status) ? r.status : 'error')
  const title = r.plan_path !== null ? path.basename(r.plan_path) : r.title
  const endedAt = r.p_status !== null ? r.p_finished : r.ended_at
  return {
    runId: r.id,
    projectId: r.project_id,
    source: r.source,
    title,
    startedAt: r.started_at,
    endedAt: endedAt ?? null,
    status,
    events: r.events
  }
}

export function createTraceStore(db: Database.Database): TraceStore {
  const insertRun = db.prepare(
    `INSERT OR IGNORE INTO trace_runs (id, project_id, source, title, started_at, ended_at, status)
     VALUES (?, ?, ?, ?, ?, NULL, 'running')`
  )
  const updateEnd = db.prepare(`UPDATE trace_runs SET status = ?, ended_at = ? WHERE id = ?`)
  const runExists = db.prepare(`SELECT 1 FROM trace_runs WHERE id = ?`)
  const insertEvent = db.prepare(`INSERT OR IGNORE INTO trace_events (run_id, seq, data) VALUES (?, ?, ?)`)
  const counters = db.prepare(`SELECT COALESCE(MAX(seq) + 1, 0) AS next, COUNT(*) AS count FROM trace_events WHERE run_id = ?`)
  const runs = db.prepare(
    `SELECT t.id, t.project_id, t.source, t.title, t.started_at, t.ended_at, t.status,
            p.plan_path AS plan_path, p.status AS p_status, p.finished_at AS p_finished,
            (SELECT COUNT(*) FROM trace_events e WHERE e.run_id = t.id) AS events
       FROM trace_runs t LEFT JOIN pipeline_runs p ON p.id = t.id
      WHERE t.project_id = ?
      ORDER BY t.started_at DESC, t.id
      LIMIT ?`
  )
  const events = db.prepare(
    `SELECT e.data AS data FROM trace_events e JOIN trace_runs t ON t.id = e.run_id
      WHERE e.run_id = ? AND t.project_id = ? ORDER BY e.seq`
  )
  const prune = db.prepare(
    `DELETE FROM trace_runs
      WHERE started_at < ?
        AND id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY started_at DESC) AS rn FROM trace_runs
          ) WHERE rn <= ?
        )`
  )
  const interrupted = db.prepare(
    `UPDATE trace_runs SET status = 'error', ended_at = ? WHERE status = 'running' AND source IN ('chat', 'plan')`
  )

  const insertMany = db.transaction((list: readonly TraceEvent[]) => {
    const known = new Map<string, boolean>()
    for (const e of list) {
      let ok = known.get(e.runId)
      if (ok === undefined) {
        ok = runExists.get(e.runId) !== undefined
        known.set(e.runId, ok)
      }
      if (ok) insertEvent.run(e.runId, e.seq, JSON.stringify(e))
    }
  })

  return {
    ensureRun(run) {
      insertRun.run(run.runId, run.projectId, run.source, run.title, run.startedAt)
    },
    endRun(runId, status, endedAt) {
      updateEnd.run(status, endedAt, runId)
    },
    insertEvents(list) {
      if (list.length > 0) insertMany(list)
    },
    runCounters(runId) {
      const row = counters.get(runId) as { next: number; count: number } | undefined
      return { nextSeq: row?.next ?? 0, count: row?.count ?? 0 }
    },
    listRuns(projectId, limit) {
      const rows = runs.all(projectId, limit) as RunRow[]
      return rows.map(toRun).filter((r): r is TraceRun => r !== null)
    },
    listEvents(projectId, runId) {
      const rows = events.all(runId, projectId) as { data: string }[]
      const out: TraceEvent[] = []
      for (const row of rows) {
        let raw: unknown
        try {
          raw = JSON.parse(row.data)
        } catch {
          continue
        }
        const parsed = traceEventSchema.safeParse(raw)
        if (parsed.success) out.push(parsed.data as TraceEvent)
      }
      return out
    },
    prune(before, keepRuns) {
      return prune.run(before, keepRuns).changes
    },
    markInterrupted(at) {
      interrupted.run(at)
    }
  }
}
