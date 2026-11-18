import type Database from 'better-sqlite3'
import { z } from 'zod'
import { FINDINGS_MAX_COUNT, findingSchema, type PipelineStage, type TaskFindingsView } from '../../shared/review'

export const TASK_STATUSES = ['queued', 'running', 'done', 'failed', 'blocked', 'cancelled'] as const
export const RUN_STATUSES = ['running', 'done', 'failed', 'cancelled'] as const
export const CHECKS_RESULTS = ['passed', 'failed', 'none'] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]
export type RunStatus = (typeof RUN_STATUSES)[number]
export type ChecksResult = (typeof CHECKS_RESULTS)[number]
export const PIPELINE_STAGES = ['checks', 'review', 'fixing'] as const satisfies readonly PipelineStage[]

const findingsViewSchema = z.object({
  blocking: z.number().int().min(0),
  minor: z.number().int().min(0),
  items: z.array(findingSchema).max(FINDINGS_MAX_COUNT)
})

export type StoreError = 'invalid' | 'not-found' | 'storage-unavailable' | 'storage-error'
export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: StoreError }

export interface NewPipelineRun {
  id: string
  projectId: string
  planPath: string
  planSha256: string
  baseBranch: string
  baseCommit: string
  integrationBranch: string
  integrationPath: string
  tasks: NewPipelineTask[]
}

export interface NewPipelineTask {
  taskId: string
  title: string
  worker: string
  wave: number
  dependsOn: string[]
}

export interface PipelineRunRow {
  id: string
  projectId: string
  planPath: string
  planSha256: string
  baseBranch: string
  baseCommit: string
  integrationBranch: string
  integrationPath: string
  status: RunStatus
  createdAt: number
  finishedAt: number | null
}

export interface PipelineTaskRow {
  runId: string
  taskId: string
  title: string
  worker: string
  wave: number
  dependsOn: string[]
  status: TaskStatus
  reason: string | null
  branch: string | null
  worktreePath: string | null
  commitSha: string | null
  checksResult: ChecksResult | null
  turns: number | null
  costUsd: number | null
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
  stage: PipelineStage | null
  fixRounds: number | null
  /** Null when nothing is stored or the stored value is unreadable. */
  findings: TaskFindingsView | null
}

/** Optional fields to write together with a status change or on their own. */
export interface TaskPatch {
  status?: TaskStatus
  reason?: string | null
  branch?: string | null
  worktreePath?: string | null
  commitSha?: string | null
  checksResult?: ChecksResult | null
  turns?: number | null
  costUsd?: number | null
  startedAt?: number | null
  finishedAt?: number | null
  durationMs?: number | null
  stage?: PipelineStage | null
  fixRounds?: number | null
  findings?: TaskFindingsView | null
}

export interface PipelineStore {
  /** Creates the run (status `running`) and its tasks (status `queued`) in one transaction. */
  createRun(input: NewPipelineRun): StoreResult<PipelineRunRow>
  updateTask(runId: string, taskId: string, patch: TaskPatch): StoreResult<PipelineTaskRow>
  setRunStatus(runId: string, status: RunStatus, finishedAt?: number | null): StoreResult<PipelineRunRow>
  getRun(runId: string): StoreResult<PipelineRunRow>
  listTasks(runId: string): StoreResult<PipelineTaskRow[]>
  /**
   * Crash recovery: every `running` run becomes failed; its `running` tasks become failed and its `queued` tasks
   * cancelled, both with reason `interrupted`. Returns the number of tasks changed.
   */
  markInterrupted(now?: number): StoreResult<number>
  /** The newest run of a project (null when it has none). */
  latestRunForProject(projectId: string): StoreResult<PipelineRunRow | null>
  /** Deletes the run and its tasks in one transaction. */
  deleteRun(runId: string): StoreResult<true>
}

/** Called after each successful write with the project and run it touched. */
export type PipelineChangeEmit = (event: { projectId: string; runId: string }) => void

/**
 * Wraps a store so that every write (createRun, updateTask, setRunStatus, deleteRun) emits one change event.
 * Return values are unchanged and an `emit` that throws never breaks a write.
 */
export function withChangeEvents(inner: PipelineStore, emit: PipelineChangeEmit): PipelineStore {
  const fire = (projectId: string, runId: string): void => {
    try {
      emit({ projectId, runId })
    } catch {
      // a broken listener must not break the write
    }
  }
  const projectOf = (runId: string): string | null => {
    try {
      const r = inner.getRun(runId)
      return r.ok ? r.value.projectId : null
    } catch {
      return null
    }
  }
  return {
    ...inner,
    createRun(input) {
      const r = inner.createRun(input)
      if (r.ok) fire(input.projectId, input.id)
      return r
    },
    updateTask(runId, taskId, patch) {
      const r = inner.updateTask(runId, taskId, patch)
      if (r.ok) {
        const p = projectOf(runId)
        if (p !== null) fire(p, runId)
      }
      return r
    },
    setRunStatus(runId, status, finishedAt) {
      const r = inner.setRunStatus(runId, status, finishedAt)
      if (r.ok) fire(r.value.projectId, runId)
      return r
    },
    deleteRun(runId) {
      const p = projectOf(runId)
      const r = inner.deleteRun(runId)
      if (r.ok && p !== null) fire(p, runId)
      return r
    }
  }
}

const PATCH_COLUMNS: Record<keyof TaskPatch, string> = {
  status: 'status',
  reason: 'reason',
  branch: 'branch',
  worktreePath: 'worktree_path',
  commitSha: 'commit_sha',
  checksResult: 'checks_result',
  turns: 'turns',
  costUsd: 'cost_usd',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  durationMs: 'duration_ms',
  stage: 'stage',
  fixRounds: 'fix_rounds',
  findings: 'findings_json'
}

interface RunDbRow {
  id: string
  project_id: string
  plan_path: string
  plan_sha256: string
  base_branch: string
  base_commit: string
  integration_branch: string
  integration_path: string
  status: RunStatus
  created_at: number
  finished_at: number | null
}

interface TaskDbRow {
  run_id: string
  task_id: string
  title: string
  worker: string
  wave: number
  depends_on: string
  status: TaskStatus
  reason: string | null
  branch: string | null
  worktree_path: string | null
  commit_sha: string | null
  checks_result: ChecksResult | null
  turns: number | null
  cost_usd: number | null
  started_at: number | null
  finished_at: number | null
  duration_ms: number | null
  stage: PipelineStage | null
  fix_rounds: number | null
  findings_json: string | null
}

function toRun(r: RunDbRow): PipelineRunRow {
  return {
    id: r.id,
    projectId: r.project_id,
    planPath: r.plan_path,
    planSha256: r.plan_sha256,
    baseBranch: r.base_branch,
    baseCommit: r.base_commit,
    integrationBranch: r.integration_branch,
    integrationPath: r.integration_path,
    status: r.status,
    createdAt: r.created_at,
    finishedAt: r.finished_at
  }
}

function parseDeps(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function parseFindings(json: string | null): TaskFindingsView | null {
  if (json === null) return null
  try {
    const r = findingsViewSchema.safeParse(JSON.parse(json))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

function toTask(r: TaskDbRow): PipelineTaskRow {
  return {
    runId: r.run_id,
    taskId: r.task_id,
    title: r.title,
    worker: r.worker,
    wave: r.wave,
    dependsOn: parseDeps(r.depends_on),
    status: r.status,
    reason: r.reason,
    branch: r.branch,
    worktreePath: r.worktree_path,
    commitSha: r.commit_sha,
    checksResult: r.checks_result,
    turns: r.turns,
    costUsd: r.cost_usd,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    stage: isOneOf(PIPELINE_STAGES, r.stage) ? r.stage : null,
    fixRounds: r.fix_rounds,
    findings: parseFindings(r.findings_json)
  }
}

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v)
}

const UNAVAILABLE = { ok: false, error: 'storage-unavailable' } as const

/** `db` is null when opening the database failed: every method returns `storage-unavailable`. */
export function createPipelineStore(
  db: Database.Database | null,
  now: () => number = Date.now
): PipelineStore {
  if (db === null) {
    return {
      createRun: () => UNAVAILABLE,
      updateTask: () => UNAVAILABLE,
      setRunStatus: () => UNAVAILABLE,
      getRun: () => UNAVAILABLE,
      listTasks: () => UNAVAILABLE,
      markInterrupted: () => UNAVAILABLE,
      latestRunForProject: () => UNAVAILABLE,
      deleteRun: () => UNAVAILABLE
    }
  }

  const insertRun = db.prepare(
    `INSERT INTO pipeline_runs (id, project_id, plan_path, plan_sha256, base_branch, base_commit,
       integration_branch, integration_path, status, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, NULL)`
  )
  const insertTask = db.prepare(
    `INSERT INTO pipeline_tasks (run_id, task_id, title, worker, wave, depends_on, status)
     VALUES (?, ?, ?, ?, ?, ?, 'queued')`
  )
  const selectRun = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?')
  const selectTask = db.prepare('SELECT * FROM pipeline_tasks WHERE run_id = ? AND task_id = ?')
  const selectTasks = db.prepare(
    'SELECT * FROM pipeline_tasks WHERE run_id = ? ORDER BY wave, rowid'
  )
  const selectLatest = db.prepare(
    'SELECT * FROM pipeline_runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
  )
  const deleteTasksStmt = db.prepare('DELETE FROM pipeline_tasks WHERE run_id = ?')
  const deleteRunStmt = db.prepare('DELETE FROM pipeline_runs WHERE id = ?')
  const deleteTx = db.transaction((runId: string): boolean => {
    deleteTasksStmt.run(runId)
    return deleteRunStmt.run(runId).changes > 0
  })
  const updateRunStmt = db.prepare('UPDATE pipeline_runs SET status = ?, finished_at = ? WHERE id = ?')
  const interruptTasks = db.prepare(
    `UPDATE pipeline_tasks SET status = 'failed', reason = 'interrupted', finished_at = ?, stage = NULL
     WHERE status = 'running'`
  )
  // Tasks of a run that never started (queued) are cancelled, not left queued under a failed run.
  const interruptQueued = db.prepare(
    `UPDATE pipeline_tasks SET status = 'cancelled', reason = 'interrupted', finished_at = ?
     WHERE status = 'queued' AND run_id IN (SELECT id FROM pipeline_runs WHERE status = 'running')`
  )
  // Every run still `running` at startup was interrupted, whether or not a task was running at that moment
  // (a crash between waves leaves none).
  const interruptRuns = db.prepare(
    `UPDATE pipeline_runs SET status = 'failed', finished_at = ? WHERE status = 'running'`
  )

  const createTx = db.transaction((input: NewPipelineRun, at: number) => {
    insertRun.run(
      input.id,
      input.projectId,
      input.planPath,
      input.planSha256,
      input.baseBranch,
      input.baseCommit,
      input.integrationBranch,
      input.integrationPath,
      at
    )
    for (const t of input.tasks) {
      insertTask.run(input.id, t.taskId, t.title, t.worker, t.wave, JSON.stringify(t.dependsOn))
    }
  })

  const interruptTx = db.transaction((at: number) => {
    // The queued tasks are found through their run, so they change while the run is still `running`.
    const queued = interruptQueued.run(at).changes
    const running = interruptTasks.run(at).changes
    interruptRuns.run(at)
    return queued + running
  })

  function fail<T>(e: unknown): StoreResult<T> {
    void e
    return { ok: false, error: 'storage-error' }
  }

  const store: PipelineStore = {
    createRun(input) {
      if (input.id === '' || input.projectId === '') return { ok: false, error: 'invalid' }
      for (const t of input.tasks) {
        if (t.taskId === '' || !Number.isInteger(t.wave)) return { ok: false, error: 'invalid' }
      }
      try {
        createTx(input, Math.round(now()))
        const row = selectRun.get(input.id) as RunDbRow
        return { ok: true, value: toRun(row) }
      } catch (e) {
        return fail(e)
      }
    },

    updateTask(runId, taskId, patch) {
      if (patch.status !== undefined && !isOneOf(TASK_STATUSES, patch.status)) {
        return { ok: false, error: 'invalid' }
      }
      if (
        patch.checksResult !== undefined &&
        patch.checksResult !== null &&
        !isOneOf(CHECKS_RESULTS, patch.checksResult)
      ) {
        return { ok: false, error: 'invalid' }
      }
      if (patch.stage !== undefined && patch.stage !== null && !isOneOf(PIPELINE_STAGES, patch.stage)) {
        return { ok: false, error: 'invalid' }
      }
      if (
        patch.fixRounds !== undefined &&
        patch.fixRounds !== null &&
        (!Number.isInteger(patch.fixRounds) || patch.fixRounds < 0)
      ) {
        return { ok: false, error: 'invalid' }
      }
      let findingsJson: string | null | undefined
      if (patch.findings !== undefined) {
        if (patch.findings === null) findingsJson = null
        else {
          const parsed = findingsViewSchema.safeParse(patch.findings)
          if (!parsed.success) return { ok: false, error: 'invalid' }
          findingsJson = JSON.stringify(parsed.data)
        }
      }
      const keys = (Object.keys(patch) as (keyof TaskPatch)[]).filter(
        (k) => k in PATCH_COLUMNS && patch[k] !== undefined
      )
      try {
        const tx = db.transaction((): StoreResult<PipelineTaskRow> => {
          if (selectTask.get(runId, taskId) === undefined) return { ok: false, error: 'not-found' }
          if (keys.length > 0) {
            const sets = keys.map((k) => `${PATCH_COLUMNS[k]} = ?`).join(', ')
            const values = keys.map((k) =>
              k === 'findings' ? (findingsJson as string | null) : (patch[k] as string | number | null)
            )
            db.prepare(`UPDATE pipeline_tasks SET ${sets} WHERE run_id = ? AND task_id = ?`).run(
              ...values,
              runId,
              taskId
            )
          }
          return { ok: true, value: toTask(selectTask.get(runId, taskId) as TaskDbRow) }
        })
        return tx()
      } catch (e) {
        return fail(e)
      }
    },

    setRunStatus(runId, status, finishedAt = null) {
      if (!isOneOf(RUN_STATUSES, status)) return { ok: false, error: 'invalid' }
      try {
        const tx = db.transaction((): StoreResult<PipelineRunRow> => {
          if (updateRunStmt.run(status, finishedAt, runId).changes === 0) {
            return { ok: false, error: 'not-found' }
          }
          return { ok: true, value: toRun(selectRun.get(runId) as RunDbRow) }
        })
        return tx()
      } catch (e) {
        return fail(e)
      }
    },

    getRun(runId) {
      try {
        const row = selectRun.get(runId) as RunDbRow | undefined
        return row === undefined ? { ok: false, error: 'not-found' } : { ok: true, value: toRun(row) }
      } catch (e) {
        return fail(e)
      }
    },

    listTasks(runId) {
      try {
        const rows = selectTasks.all(runId) as TaskDbRow[]
        return { ok: true, value: rows.map(toTask) }
      } catch (e) {
        return fail(e)
      }
    },

    latestRunForProject(projectId) {
      try {
        const row = selectLatest.get(projectId) as RunDbRow | undefined
        return { ok: true, value: row === undefined ? null : toRun(row) }
      } catch (e) {
        return fail(e)
      }
    },

    deleteRun(runId) {
      try {
        return deleteTx(runId) ? { ok: true, value: true } : { ok: false, error: 'not-found' }
      } catch (e) {
        return fail(e)
      }
    },

    markInterrupted(at = now()) {
      try {
        return { ok: true, value: interruptTx(Math.round(at)) }
      } catch (e) {
        return fail(e)
      }
    }
  }
  return store
}
