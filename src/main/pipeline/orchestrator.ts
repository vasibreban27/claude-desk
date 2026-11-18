import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { PipelineStore, RunStatus, TaskPatch } from '../db/pipelineStore'
import type { SettingsStore } from '../db/settingsStore'
import { effectiveLimits, type ProjectSettings } from '../../shared/settings'
import { MAX_PLAN_BYTES, parsePlan, type ParsedPlan, type PlanTask } from './planParser'
import { createMutex, runPool } from './queue'
import type { WorkerRunner } from './workerRunner'
import {
  GIT_ENV_ADDITIONS,
  GIT_MAX_BUFFER,
  GIT_PREFIX,
  GIT_TIMEOUT_MS,
  createWorktreeManager,
  type WorktreeManager,
  type WorktreeManagerOptions
} from './worktrees'

/**
 * Pipeline orchestrator (plain code, no LLM). Wave by wave, at most `maxParallel` tasks at once, each task in
 * its own worktree; every manager mutation goes through one per-run mutex; a task that commits is merged into `run/<id>`. "Done" means committed and merged, not reviewed.
 * Never throws out of its public methods.
 */

export interface StartRunInput {
  projectId: string
  /** Absolute path of the project's primary checkout. */
  projectPath: string
  /** Absolute path of the plan file. */
  planPath: string
  baseBranch: string
  /** Pre-generated run id (the service passes it so its active flag is set from the first event). */
  runId?: string
}

export interface TaskSummary {
  taskId: string
  status: string
  reason: string | null
}
export interface RunSummary {
  runId: string
  status: RunStatus
  /** Short reason when the run itself failed (not a task). */
  reason: string | null
  tasks: TaskSummary[]
}

export type StartRunResult =
  | { ok: true; runId: string; finished: Promise<RunSummary> }
  | { ok: false; error: string }

export interface Orchestrator {
  startRun(input: StartRunInput): Promise<StartRunResult>
  /** Aborts the running session and cancels queued tasks. False when the run is not active. */
  cancel(runId: string): boolean
}

/** Resolves a ref to a commit hash in a worktree. */
export type ResolveRef = (cwd: string, ref: string) => Promise<string>

export interface OrchestratorDeps {
  store: PipelineStore
  settings: SettingsStore
  runner: WorkerRunner
  pluginPath: string
  createManager?: (opts: WorktreeManagerOptions) => WorktreeManager
  resolveRef?: ResolveRef
  readPlan?: (planPath: string) => Promise<string>
  newRunId?: () => string
  now?: () => number
  log?: (message: string) => void
}

const defaultResolveRef: ResolveRef = (cwd, ref) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_PREFIX, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      {
        cwd,
        env: { ...process.env, ...GIT_ENV_ADDITIONS },
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: 'utf8',
        windowsHide: true
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
    )
  })

const defaultReadPlan = async (planPath: string): Promise<string> => {
  const buf = await readFile(planPath)
  if (buf.byteLength > MAX_PLAN_BYTES) throw new Error('plan file is too large')
  return buf.toString('utf8')
}

class RunAbort extends Error {}

const short = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200)
const cap = (s: string, n = 300): string => s.slice(0, n)

interface ActiveRun {
  cancelled: boolean
  controller: AbortController
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  const createManager = deps.createManager ?? createWorktreeManager
  const resolveRef = deps.resolveRef ?? defaultResolveRef
  const readPlan = deps.readPlan ?? defaultReadPlan
  const newRunId = deps.newRunId ?? randomUUID
  const active = new Map<string, ActiveRun>()

  // Crash recovery: nothing resumes automatically; running rows become failed (interrupted).
  try {
    const r = deps.store.markInterrupted()
    if (!r.ok) log(`pipeline: could not mark interrupted runs: ${r.error}`)
  } catch (e) {
    log(`pipeline: could not mark interrupted runs: ${short(e)}`)
  }

  async function execute(
    runId: string,
    plan: ParsedPlan,
    ctx: { settings: ProjectSettings; manager: WorktreeManager; handle: ActiveRun }
  ): Promise<RunSummary> {
    const { manager, handle } = ctx
    const update = (taskId: string, patch: TaskPatch): void => {
      const r = deps.store.updateTask(runId, taskId, patch)
      if (!r.ok) throw new RunAbort(`database error: ${r.error}`)
    }
    const status = new Map<string, string>()
    const reasons = new Map<string, string | null>()
    const settle = (taskId: string, st: 'failed' | 'blocked' | 'cancelled' | 'done', reason: string | null, extra: TaskPatch = {}): void => {
      update(taskId, { status: st, reason, finishedAt: now(), ...extra })
      status.set(taskId, st)
      reasons.set(taskId, reason)
    }
    const tasks: PlanTask[] = plan.waves.flatMap((w) => w.tasks)
    let runReason: string | null = null
    let finalStatus: RunStatus = 'done'
    /** Set by the first database error: no new task starts and running ones are left unsettled. */
    let abortReason: string | null = null
    const abortRun = (reason: string): void => {
      if (abortReason !== null) return
      abortReason = reason
      handle.controller.abort()
    }
    const mutex = createMutex()
    const settings = ctx.settings
    const { maxParallel } = effectiveLimits(settings)

    const runTask = async (task: PlanTask): Promise<void> => {
      if (abortReason !== null) return
      if (handle.cancelled) {
        settle(task.id, 'cancelled', null)
        return
      }
      const badDep = task.dependsOn.find((d) => status.get(d) !== 'done')
      if (badDep !== undefined) {
        settle(task.id, 'blocked', `depends on ${badDep} (${status.get(badDep) ?? 'unknown'})`)
        return
      }

      const startedAt = now()
      update(task.id, { status: 'running', startedAt })
      try {
        const wt = await mutex(() => manager.createTaskWorktree(task.id))
        if (abortReason !== null) return
        if (!wt.ok) {
          settle(task.id, 'failed', cap(`worktree error: ${wt.error}`), { durationMs: now() - startedAt })
          return
        }
        update(task.id, { branch: wt.branch, worktreePath: wt.path })
        const startSha = await resolveRef(wt.path, wt.branch)

        const outcome = await deps.runner({
          task,
          worktree: wt.path,
          branch: wt.branch,
          settings,
          pluginPath: deps.pluginPath,
          signal: handle.controller.signal
        })
        if (abortReason !== null) return
        const timing: TaskPatch = {
          durationMs: now() - startedAt,
          turns: outcome.turns,
          costUsd: outcome.costUsd,
          checksResult: outcome.checksResult
        }

        if (outcome.status === 'cancelled') {
          settle(task.id, 'cancelled', null, timing)
          return
        }
        if (outcome.status === 'limit') {
          settle(task.id, 'failed', 'limit reached', timing)
          return
        }
        if (outcome.blocked !== null) {
          settle(task.id, 'failed', cap(`blocked: ${outcome.blocked}`), timing)
          return
        }
        if (outcome.status === 'error') {
          log(`pipeline: worker error in ${task.id}: ${outcome.error ?? 'unknown'}`)
          settle(task.id, 'failed', 'worker error', timing)
          return
        }
        // Resolving the end commit and merging share the mutex: merges never overlap.
        const done = await mutex(async () => {
          const endSha = await resolveRef(wt.path, wt.branch)
          if (endSha === startSha) return { endSha, merged: null }
          return { endSha, merged: await manager.mergeTask(task.id) }
        })
        if (abortReason !== null) return
        const { endSha, merged } = done
        if (merged === null) {
          settle(task.id, 'failed', 'no commit', timing)
        } else if (!merged.ok) {
          settle(task.id, 'failed', cap(`merge failed: ${merged.error}`), { ...timing, commitSha: endSha })
        } else if (merged.result === 'conflict') {
          settle(task.id, 'failed', 'merge conflict', { ...timing, commitSha: endSha })
        } else {
          settle(task.id, 'done', null, { ...timing, commitSha: endSha })
        }
      } catch (e) {
        if (e instanceof RunAbort) throw e
        if (abortReason !== null) return
        log(`pipeline: task ${task.id} failed: ${short(e)}`)
        settle(task.id, 'failed', 'worker error', { durationMs: now() - startedAt })
      }
    }

    // A database error anywhere stops the pool; the task itself never throws out of the pool.
    const guarded = async (task: PlanTask): Promise<void> => {
      try {
        await runTask(task)
      } catch (e) {
        abortRun(e instanceof RunAbort ? e.message : short(e))
      }
    }

    try {
      for (const wave of plan.waves) {
        if (abortReason !== null) break
        await runPool(wave.tasks, maxParallel, guarded)
      }
    } catch (e) {
      abortRun(short(e))
    }
    if (abortReason !== null) {
      runReason = abortReason
      finalStatus = 'failed'
      log(`pipeline: run ${runId} failed: ${runReason}`)
      // Best effort: leave no task `queued` or `running` behind a failed run.
      for (const t of tasks) {
        if (!status.has(t.id)) {
          try {
            settle(t.id, 'failed', cap(`run failed: ${runReason}`))
          } catch {
            // the store is still failing; the remaining rows stay as they are
          }
        }
      }
    }

    if (finalStatus !== 'failed') {
      const values = [...status.values()]
      // A cancel that arrives after the last task merged loses nothing: the run stays `done` (F3).
      if (values.includes('cancelled')) finalStatus = 'cancelled'
      else if (values.some((s) => s === 'failed' || s === 'blocked')) finalStatus = 'failed'
    }
    const writeStatus = (): boolean => {
      try {
        const r = deps.store.setRunStatus(runId, finalStatus, now())
        if (r.ok) return true
        log(`pipeline: could not write the final run status: ${r.error}`)
      } catch (e) {
        log(`pipeline: could not write the final run status: ${short(e)}`)
      }
      return false
    }
    if (!writeStatus() && !writeStatus()) {
      // The stored status cannot be trusted; report the run as failed so the summary says so.
      const note = 'final run status could not be saved'
      runReason = runReason === null ? note : cap(`${runReason}; ${note}`)
      finalStatus = 'failed'
    }
    return {
      runId,
      status: finalStatus,
      reason: runReason,
      tasks: tasks.map((t) => ({
        taskId: t.id,
        status: status.get(t.id) ?? 'queued',
        reason: reasons.get(t.id) ?? null
      }))
    }
  }

  return {
    async startRun(input) {
      try {
        let text: string
        try {
          text = await readPlan(input.planPath)
        } catch (e) {
          return { ok: false, error: cap(`could not read the plan: ${short(e)}`) }
        }
        const parsed = parsePlan(text)
        if (!parsed.ok) {
          const first = parsed.errors[0]
          return { ok: false, error: cap(`invalid plan${first ? ` (line ${first.line}): ${first.message}` : ''}`) }
        }
        const loaded = deps.settings.get(input.projectId)
        if (loaded.notice === 'storage-unavailable') return { ok: false, error: 'settings could not be loaded' }

        const runId = input.runId ?? newRunId()
        const manager = createManager({ projectPath: input.projectPath, runId })
        const started = await manager.startRun(input.baseBranch)
        if (!started.ok) return { ok: false, error: cap(started.error) }

        const cleanup = async (): Promise<void> => {
          try {
            await manager.removeRun()
          } catch (e) {
            log(`pipeline: could not remove run ${runId} after a failed start: ${short(e)}`)
          }
        }
        let created: ReturnType<PipelineStore['createRun']>
        try {
          created = deps.store.createRun({
            id: runId,
            projectId: input.projectId,
            planPath: input.planPath,
            planSha256: createHash('sha256').update(text).digest('hex'),
            baseBranch: input.baseBranch,
            baseCommit: started.baseHash,
            integrationBranch: started.branch,
            integrationPath: started.path,
            tasks: parsed.plan.waves.flatMap((w) =>
              w.tasks.map((t) => ({ taskId: t.id, title: t.title, worker: t.worker, wave: w.n, dependsOn: t.dependsOn }))
            )
          })
        } catch (e) {
          await cleanup()
          return { ok: false, error: cap(`database error: ${short(e)}`) }
        }
        if (!created.ok) {
          await cleanup()
          return { ok: false, error: `database error: ${created.error}` }
        }

        const handle: ActiveRun = { cancelled: false, controller: new AbortController() }
        active.set(runId, handle)
        const finished = execute(runId, parsed.plan, { settings: loaded.settings, manager, handle })
          .catch((e): RunSummary => ({ runId, status: 'failed', reason: short(e), tasks: [] }))
          .finally(() => active.delete(runId))
        return { ok: true, runId, finished }
      } catch (e) {
        return { ok: false, error: cap(short(e)) }
      }
    },

    cancel(runId) {
      const handle = active.get(runId)
      if (handle === undefined) return false
      handle.cancelled = true
      handle.controller.abort()
      return true
    }
  }
}
