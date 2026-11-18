import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { PipelineStore, RunStatus, TaskPatch } from '../db/pipelineStore'
import type { SettingsStore } from '../db/settingsStore'
import {
  AUTO_FIX_ROUNDS_RANGE,
  DEFAULT_REVIEWERS,
  FINDINGS_MAX_COUNT,
  isBlocking,
  type Finding,
  type TaskFindingsView
} from '../../shared/review'
import { effectiveLimits, type ProjectSettings } from '../../shared/settings'
import { MAX_PLAN_BYTES, parsePlan, type ParsedPlan, type PlanTask } from './planParser'
import { createMutex, runPool } from './queue'
import type { WorkerOutcome, WorkerRunner } from './workerRunner'
import { runChecksGate, type ChecksGateArgs, type ChecksGateResult } from './checksGate'
import { MAX_REPORTED_PATHS, uncommittedWork } from './uncommitted'
import type { PipelineLogInput } from './pipelineLog'
import type { PipelineLogRole, PipelineLogTone } from '../../shared/pipelineLog'
import { createReviewRunner, type ReviewOutcome, type ReviewRunner } from './reviewRunner'
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
 * its own worktree; every manager mutation goes through one per-run mutex; a task that commits passes the checks gate and the reviewers (with fix rounds) and is then merged into `run/<id>`.
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
  /** The checks gate (default: the app's own `runChecksGate`). */
  gate?: (args: ChecksGateArgs) => Promise<ChecksGateResult>
  /** One reviewer session (default: the SDK-backed runner). */
  reviewRunner?: ReviewRunner
  createManager?: (opts: WorktreeManagerOptions) => WorktreeManager
  resolveRef?: ResolveRef
  /**
   * Uncommitted work in the worktree, generated files excluded (default: `git status --porcelain -z`;
   * skipped when `resolveRef` is injected).
   */
  uncommitted?: (cwd: string) => Promise<string[]>
  readPlan?: (planPath: string) => Promise<string>
  /** Live, short progress lines for the Activity tab. Never throws into a run. */
  onLog?: (projectId: string, line: PipelineLogInput) => void
  newRunId?: () => string
  now?: () => number
  log?: (message: string) => void
}

const defaultUncommitted = (cwd: string): Promise<string[]> =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_PREFIX, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      {
        cwd,
        env: { ...process.env, ...GIT_ENV_ADDITIONS },
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: 'utf8',
        windowsHide: true
      },
      (err, stdout) => (err ? reject(err) : resolve(uncommittedWork(stdout)))
    )
  })

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
  const uncommitted = deps.uncommitted ?? (deps.resolveRef ? async () => [] : defaultUncommitted)
  const readPlan = deps.readPlan ?? defaultReadPlan
  const newRunId = deps.newRunId ?? randomUUID
  const active = new Map<string, ActiveRun>()
  const runGate = deps.gate ?? ((args: ChecksGateArgs) => runChecksGate(args))
  let defaultReviewer: ReviewRunner | null = null
  const runReview: ReviewRunner = (args) => {
    const r = deps.reviewRunner ?? (defaultReviewer ??= createReviewRunner())
    return r(args)
  }

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
    ctx: { settings: ProjectSettings; manager: WorktreeManager; handle: ActiveRun; projectId: string }
  ): Promise<RunSummary> {
    const { manager, handle } = ctx
    const say = (taskId: string | null, role: PipelineLogRole, text: string, tone: PipelineLogTone = 'info', agent: string | null = null): void => {
      try {
        deps.onLog?.(ctx.projectId, { runId, taskId, role, agent, text, tone })
      } catch {
        // the live log never breaks a run
      }
    }
    const update = (taskId: string, patch: TaskPatch): void => {
      const r = deps.store.updateTask(runId, taskId, patch)
      if (!r.ok) throw new RunAbort(`database error: ${r.error}`)
    }
    const status = new Map<string, string>()
    const reasons = new Map<string, string | null>()
    const settle = (taskId: string, st: 'failed' | 'blocked' | 'cancelled' | 'done', reason: string | null, extra: TaskPatch = {}): void => {
      update(taskId, { status: st, reason, finishedAt: now(), stage: null, ...extra })
      say(taskId, 'pipeline', st === 'done' ? 'merged into the run branch' : `${st}${reason ? `: ${reason}` : ''}`, st === 'done' ? 'ok' : 'error')
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
      say(task.id, 'pipeline', `started: ${task.title} (${task.worker})`)
      // Totals over the first worker run, fix rounds and reviewers (each runner reports its own call's value).
      let turnsTotal: number | null = null
      let costTotal: number | null = null
      let checksResult: TaskPatch['checksResult'] = null
      let fixRounds: number | null = null
      let findingsView: TaskFindingsView | null = null
      const addCost = (c: number | null): void => {
        if (c !== null) costTotal = (costTotal ?? 0) + c
      }
      const absorb = (o: WorkerOutcome): void => {
        if (o.turns !== null) turnsTotal = (turnsTotal ?? 0) + o.turns
        addCost(o.costUsd)
        checksResult = o.checksResult
      }
      const timing = (): TaskPatch => ({
        durationMs: now() - startedAt,
        turns: turnsTotal,
        costUsd: costTotal,
        checksResult,
        ...(fixRounds !== null ? { fixRounds } : {}),
        ...(findingsView !== null ? { findings: findingsView } : {})
      })
      /** Settles the task when a worker outcome ends it; false when the worker finished normally. */
      const settleWorkerStop = (o: WorkerOutcome): boolean => {
        if (o.status === 'cancelled') settle(task.id, 'cancelled', null, timing())
        else if (o.status === 'limit') settle(task.id, 'failed', 'limit reached', timing())
        else if (o.blocked !== null) settle(task.id, 'failed', cap(`blocked: ${o.blocked}`), timing())
        else if (o.status === 'error') {
          log(`pipeline: worker error in ${task.id}: ${o.error ?? 'unknown'}`)
          settle(task.id, 'failed', 'worker error', timing())
        } else return false
        return true
      }
      try {
        const wt = await mutex(() => manager.createTaskWorktree(task.id))
        if (abortReason !== null) return
        if (!wt.ok) {
          settle(task.id, 'failed', cap(`worktree error: ${wt.error}`), { durationMs: now() - startedAt })
          return
        }
        update(task.id, { branch: wt.branch, worktreePath: wt.path })
        const startSha = await resolveRef(wt.path, wt.branch)
        const signal = handle.controller.signal

        let outcome = await deps.runner({
          task,
          worktree: wt.path,
          branch: wt.branch,
          settings,
          pluginPath: deps.pluginPath,
          signal,
          onLog: (l) => say(task.id, 'worker', l.text, l.tone)
        })
        if (abortReason !== null) return
        absorb(outcome)
        if (settleWorkerStop(outcome)) return

        let gatedSha: string | null = null
        const checks = settings.checks ?? []
        const reviewers = (settings.reviewers ?? [...DEFAULT_REVIEWERS]).filter(
          (r) => r !== 'security-auditor' || task.sensitive === true
        )
        if (checks.length > 0 || reviewers.length > 0) {
          const maxRounds = settings.autoFixRounds ?? AUTO_FIX_ROUNDS_RANGE.default
          let head = await resolveRef(wt.path, wt.branch)
          if (head === startSha) {
            settle(task.id, 'failed', 'no commit', timing())
            return
          }
          let rounds = 0
          fixRounds = 0
          for (;;) {
            // Checks and reviewers must see exactly the commit that gets merged: leftover work goes back to the worker.
            const left = await uncommitted(wt.path)
            if (abortReason !== null) return
            let fix: { kind: 'checks' | 'review'; text: string } | null = null
            let failReason = ''
            if (left.length > 0) {
              const shown = left.slice(0, MAX_REPORTED_PATHS)
              const more = left.length > shown.length ? ` (+${left.length - shown.length} more)` : ''
              fix = {
                kind: 'checks',
                text:
                  `Uncommitted files in your worktree: ${shown.join(', ')}${more}.\n` +
                  'Commit the ones that belong to this task with git_commit. If they are generated files, add them to ' +
                  '.gitignore when it is in your Owns, otherwise report_blocked naming them.'
              }
              failReason = cap(`uncommitted changes: ${shown.join(', ')}${more}`)
            }

            if (fix === null && checks.length > 0) {
              update(task.id, { stage: 'checks' })
              const gate = await runGate({ worktree: wt.path, checks, signal })
              if (abortReason !== null) return
              if (gate.status === 'failed' && signal.aborted) {
                settle(task.id, 'cancelled', null, timing())
                return
              }
              checksResult = gate.status
              say(task.id, 'pipeline', gate.status === 'failed' ? `checks failed: ${gate.check}` : 'checks passed', gate.status === 'failed' ? 'error' : 'ok')
              if (gate.status === 'failed') {
                fix = { kind: 'checks', text: `Check "${gate.check}":\n${gate.output}` }
                failReason = 'checks failed'
              }
            }

            if (fix === null && reviewers.length > 0) {
              update(task.id, { stage: 'review' })
              const all: Finding[] = []
              for (const reviewer of reviewers) {
                let rv: ReviewOutcome
                try {
                  rv = await runReview({
                    reviewer,
                    task,
                    worktree: wt.path,
                    startSha,
                    settings,
                    pluginPath: deps.pluginPath,
                    signal,
                    onLog: (l) => say(task.id, 'reviewer', l.text, l.tone, reviewer)
                  })
                } catch (e) {
                  if (abortReason !== null) return
                  log(`pipeline: reviewer ${reviewer} failed in ${task.id}: ${short(e)}`)
                  settle(task.id, 'failed', 'review: reviewer error', timing())
                  return
                }
                if (abortReason !== null) return
                addCost(rv.costUsd)
                if (rv.status === 'cancelled') {
                  settle(task.id, 'cancelled', null, timing())
                  return
                }
                if (rv.status !== 'finished') {
                  if (rv.status === 'error') log(`pipeline: reviewer ${reviewer} error in ${task.id}: ${rv.error ?? 'unknown'}`)
                  const why =
                    rv.status === 'no-report' ? 'reviewer did not report' : rv.status === 'limit' ? 'reviewer limit reached' : 'reviewer error'
                  settle(task.id, 'failed', `review: ${why}`, timing())
                  return
                }
                {
                  const b = rv.findings.filter(isBlocking).length
                  say(task.id, 'reviewer', `review: ${b} blocking, ${rv.findings.length - b} minor`, b > 0 ? 'error' : 'ok', reviewer)
                }
                all.push(...rv.findings)
              }
              const blocking = all.filter(isBlocking)
              const rest = all.filter((f) => !isBlocking(f))
              findingsView = {
                blocking: blocking.length,
                minor: rest.length,
                items: [...blocking, ...rest].slice(0, FINDINGS_MAX_COUNT)
              }
              update(task.id, { findings: findingsView })
              if (blocking.length > 0) {
                fix = {
                  kind: 'review',
                  text: blocking
                    .map((f) => `[${f.severity}] (${f.reviewer}) ${f.file}${f.line !== null ? `:${f.line}` : ''}: ${f.text}`)
                    .join('\n')
                }
                failReason = 'review: blocking findings'
              }
            }

            if (fix === null) break
            if (rounds >= maxRounds) {
              settle(task.id, 'failed', failReason, timing())
              return
            }
            rounds += 1
            fixRounds = rounds
            update(task.id, { stage: 'fixing', fixRounds: rounds })
            say(task.id, 'pipeline', `fix round ${rounds}: ${failReason}`)
            outcome = await deps.runner({
              task,
              worktree: wt.path,
              branch: wt.branch,
              settings,
              pluginPath: deps.pluginPath,
              signal,
              fix: { kind: fix.kind, text: fix.text, sessionId: outcome.sessionId ?? null },
              onLog: (l) => say(task.id, 'fix', l.text, l.tone)
            })
            if (abortReason !== null) return
            absorb(outcome)
            if (settleWorkerStop(outcome)) return
            const next = await resolveRef(wt.path, wt.branch)
            if (next === head) {
              settle(task.id, 'failed', 'no commit after fix', timing())
              return
            }
            head = next
          }
          gatedSha = head
          update(task.id, { stage: null })
        }

        // Resolving the end commit and merging share the mutex: merges never overlap.
        const done = await mutex(async () => {
          const endSha = await resolveRef(wt.path, wt.branch)
          if (endSha === startSha) return { endSha, merged: null }
          if (gatedSha !== null && endSha !== gatedSha) return { endSha, merged: 'unreviewed' as const }
          return { endSha, merged: await manager.mergeTask(task.id) }
        })
        if (abortReason !== null) return
        const { endSha, merged } = done
        if (merged === null) {
          settle(task.id, 'failed', 'no commit', timing())
        } else if (merged === 'unreviewed') {
          settle(task.id, 'failed', 'commit changed after review', timing())
        } else if (!merged.ok) {
          settle(task.id, 'failed', cap(`merge failed: ${merged.error}`), { ...timing(), commitSha: endSha })
        } else if (merged.result === 'conflict') {
          settle(task.id, 'failed', 'merge conflict', { ...timing(), commitSha: endSha })
        } else {
          settle(task.id, 'done', null, { ...timing(), commitSha: endSha })
        }
      } catch (e) {
        if (e instanceof RunAbort) throw e
        if (abortReason !== null) return
        log(`pipeline: task ${task.id} failed: ${short(e)}`)
        settle(task.id, 'failed', 'worker error', timing())
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

    say(null, 'pipeline', `run started: ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} in ${plan.waves.length} ${plan.waves.length === 1 ? 'wave' : 'waves'}`)
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
    say(null, 'pipeline', `run ${finalStatus}${runReason ? `: ${runReason}` : ''}`, finalStatus === 'done' ? 'ok' : 'error')
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
        const finished = execute(runId, parsed.plan, { settings: loaded.settings, manager, handle, projectId: input.projectId })
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
