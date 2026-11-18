import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type {
  AppInfo,
  PipelineCancelResult,
  PipelineDiscardResult,
  PipelinePlansResult,
  PipelineRunView,
  PipelineStartResult,
  PipelineStatusResult,
  PlanEntry
} from '../../shared/ipc'
import { PLAN_FILE_PATTERN } from '../../shared/ipc'
import type { PipelineRunRow, PipelineStore, PipelineTaskRow } from '../db/pipelineStore'
import { readGitStatus, type GitStatusResult } from '../git/status'
import type { ProjectStore } from '../projects/store'
import type { Orchestrator } from './orchestrator'
import { MAX_PLAN_BYTES, parsePlan, type PlanError } from './planParser'
import { createWorktreeManager, type WorktreeManager, type WorktreeManagerOptions } from './worktrees'

/**
 * Pipeline operations behind the IPC handlers (plans, start, status, cancel, discard). Every method returns a
 * result value and never throws. The renderer only ever names a plan by file name; paths are resolved here.
 */

export const MAX_PLAN_ENTRIES = 100
export const MAX_ENTRY_ERRORS = 20
const FLOW_FIRST_LINE = 'Format: flow-plan/1'
const MESSAGE_CAP = 300

export interface PipelineService {
  listPlans(projectId: string): Promise<PipelinePlansResult>
  start(projectId: string, planFile: string): Promise<PipelineStartResult>
  status(projectId: string): Promise<PipelineStatusResult>
  cancel(projectId: string, runId: string): Promise<PipelineCancelResult>
  discard(projectId: string, runId: string): Promise<PipelineDiscardResult>
}

export interface PipelineServiceDeps {
  projects: Pick<ProjectStore, 'get'>
  store: PipelineStore
  orchestrator: Orchestrator
  /** Current toolkit state; a run needs `valid`. */
  getToolkit: () => AppInfo['toolkit']
  readBranch?: (projectPath: string) => Promise<GitStatusResult>
  createManager?: (opts: WorktreeManagerOptions) => WorktreeManager
  log?: (message: string) => void
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function createPipelineService(deps: PipelineServiceDeps): PipelineService {
  const log = deps.log ?? (() => undefined)
  const readBranch = deps.readBranch ?? readGitStatus
  const createManager = deps.createManager ?? createWorktreeManager
  /** projectId -> runId of the run in flight ('' while it is being started). */
  const activeRuns = new Map<string, string>()

  async function listEntries(plansDir: string): Promise<PlanEntry[] | 'unreadable'> {
    let dirents
    try {
      dirents = await readdir(plansDir, { withFileTypes: true })
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR'
        ? []
        : 'unreadable'
    }
    const names = dirents
      .filter((d) => d.isFile() && !d.isSymbolicLink() && PLAN_FILE_PATTERN.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, MAX_PLAN_ENTRIES)
    const out: PlanEntry[] = []
    for (const file of names) out.push(await describePlan(plansDir, file))
    return out
  }

  async function describePlan(plansDir: string, file: string): Promise<PlanEntry> {
    const base = { file, title: null, format: 'legacy' as const, taskCount: 0, waveCount: 0 }
    const broken = (message: string, format: PlanEntry['format'] = 'legacy'): PlanEntry => ({
      ...base,
      format,
      ok: false,
      errorCount: 1,
      errors: [{ line: 0, message }]
    })
    const full = path.join(plansDir, file)
    try {
      const st = await lstat(full)
      if (!st.isFile()) return broken('not a regular file')
      if (st.size > MAX_PLAN_BYTES) return broken('plan file is too large')
      const text = (await readFile(full)).toString('utf8')
      const format = text.split(/\r?\n/, 1)[0] === FLOW_FIRST_LINE ? 'flow-plan/1' : 'legacy'
      const parsed = parsePlan(text)
      if (!parsed.ok) {
        return {
          ...base,
          format,
          ok: false,
          errorCount: parsed.errors.length,
          errors: parsed.errors.slice(0, MAX_ENTRY_ERRORS).map((e) => ({ line: e.line, message: e.message }))
        }
      }
      return {
        file,
        title: parsed.plan.title === '' ? null : parsed.plan.title,
        format: parsed.plan.format,
        ok: true,
        taskCount: parsed.plan.waves.reduce((n, w) => n + w.tasks.length, 0),
        waveCount: parsed.plan.waves.length,
        errorCount: 0,
        errors: []
      }
    } catch (e) {
      log(`pipeline: could not read plan ${file}: ${errText(e)}`)
      return broken('could not read the plan')
    }
  }

  /** The absolute path of a top-level regular plan file inside docs/plans, or null. */
  async function resolvePlan(projectPath: string, planFile: string): Promise<string | null> {
    const dir = path.join(projectPath, 'docs', 'plans')
    const full = path.join(dir, planFile)
    try {
      const st = await lstat(full)
      if (!st.isFile() || st.isSymbolicLink()) return null
      const realDir = await realpath(dir)
      const realFile = await realpath(full)
      if (!isInside(realDir, realFile) || path.dirname(realFile) !== realDir) return null
      return full
    } catch {
      return null
    }
  }

  async function ownedRun(
    projectId: string,
    runId: string
  ): Promise<{ project: { path: string }; run: PipelineRunRow } | null> {
    const project = await deps.projects.get(projectId)
    if (project === undefined) return null
    const run = deps.store.getRun(runId)
    if (!run.ok || run.value.projectId !== projectId) return null
    return { project, run: run.value }
  }

  const toView = (run: PipelineRunRow, tasks: PipelineTaskRow[], active: boolean): PipelineRunView => ({
    runId: run.id,
    planFile: path.basename(run.planPath),
    status: run.status,
    active,
    baseBranch: run.baseBranch,
    integrationBranch: run.integrationBranch,
    createdAt: new Date(run.createdAt).toISOString(),
    finishedAt: run.finishedAt === null ? null : new Date(run.finishedAt).toISOString(),
    tasks: tasks.map((t) => ({
      taskId: t.taskId,
      title: t.title,
      worker: t.worker,
      wave: t.wave,
      dependsOn: t.dependsOn,
      status: t.status,
      reason: t.reason,
      commit: t.commitSha === null ? null : t.commitSha.slice(0, 7),
      checks: t.checksResult,
      turns: t.turns,
      costUsd: t.costUsd,
      durationMs: t.durationMs
    }))
  })

  const firstError = (errors: PlanError[]): string => {
    const e = errors[0]
    return e === undefined ? 'invalid plan' : `line ${e.line}: ${e.message}`.slice(0, MESSAGE_CAP)
  }

  return {
    async listPlans(projectId) {
      try {
        const project = await deps.projects.get(projectId)
        if (project === undefined) return { ok: false, error: 'not-found' }
        const plans = await listEntries(path.join(project.path, 'docs', 'plans'))
        return plans === 'unreadable' ? { ok: false, error: 'unreadable' } : { ok: true, plans }
      } catch (e) {
        log(`pipeline: listing plans failed: ${errText(e)}`)
        return { ok: false, error: 'unreadable' }
      }
    },

    async start(projectId, planFile) {
      let reserved = false
      try {
        if (!PLAN_FILE_PATTERN.test(planFile) || planFile.length > 100) return { ok: false, error: 'invalid-plan' }
        const project = await deps.projects.get(projectId)
        if (project === undefined) return { ok: false, error: 'not-found' }
        const planPath = await resolvePlan(project.path, planFile)
        if (planPath === null) return { ok: false, error: 'not-found' }

        const git = await readBranch(project.path)
        if (!git.ok) return { ok: false, error: 'start-failed', message: `git status: ${git.error}` }
        if (git.branch === null) return { ok: false, error: 'detached-head' }

        if (deps.getToolkit().status !== 'valid') return { ok: false, error: 'no-toolkit' }

        let text: string
        try {
          const st = await lstat(planPath)
          if (st.size > MAX_PLAN_BYTES) return { ok: false, error: 'invalid-plan', message: 'plan file is too large' }
          text = (await readFile(planPath)).toString('utf8')
        } catch (e) {
          log(`pipeline: could not read plan ${planFile}: ${errText(e)}`)
          return { ok: false, error: 'not-found' }
        }
        const parsed = parsePlan(text)
        if (!parsed.ok) return { ok: false, error: 'invalid-plan', message: firstError(parsed.errors) }

        // No await between this check and the reservation: two starts cannot both pass.
        if (activeRuns.has(projectId)) return { ok: false, error: 'busy' }
        activeRuns.set(projectId, '')
        reserved = true

        const started = await deps.orchestrator.startRun({
          projectId,
          projectPath: project.path,
          planPath,
          baseBranch: git.branch
        })
        if (!started.ok) {
          const storage = started.error.startsWith('database error') || started.error.startsWith('settings could not')
          return storage
            ? { ok: false, error: 'storage-unavailable' }
            : { ok: false, error: 'start-failed', message: started.error.slice(0, MESSAGE_CAP) }
        }
        activeRuns.set(projectId, started.runId)
        reserved = false
        const release = (): void => {
          if (activeRuns.get(projectId) === started.runId) activeRuns.delete(projectId)
        }
        started.finished.then(release, (e: unknown) => {
          log(`pipeline: run ${started.runId} ended with an error: ${errText(e)}`)
          release()
        })
        return { ok: true, runId: started.runId }
      } catch (e) {
        log(`pipeline: start failed: ${errText(e)}`)
        return { ok: false, error: 'start-failed', message: errText(e).slice(0, MESSAGE_CAP) }
      } finally {
        if (reserved && activeRuns.get(projectId) === '') activeRuns.delete(projectId)
      }
    },

    async status(projectId) {
      try {
        const project = await deps.projects.get(projectId)
        if (project === undefined) return { ok: false, error: 'not-found' }
        const latest = deps.store.latestRunForProject(projectId)
        if (!latest.ok) return { ok: false, error: 'storage-unavailable' }
        if (latest.value === null) return { ok: true, run: null }
        const tasks = deps.store.listTasks(latest.value.id)
        if (!tasks.ok) return { ok: false, error: 'storage-unavailable' }
        return { ok: true, run: toView(latest.value, tasks.value, activeRuns.get(projectId) === latest.value.id) }
      } catch (e) {
        log(`pipeline: status failed: ${errText(e)}`)
        return { ok: false, error: 'storage-unavailable' }
      }
    },

    async cancel(projectId, runId) {
      try {
        if ((await ownedRun(projectId, runId)) === null) return { ok: false, error: 'not-found' }
        if (activeRuns.get(projectId) !== runId) return { ok: false, error: 'not-active' }
        return deps.orchestrator.cancel(runId) ? { ok: true } : { ok: false, error: 'not-active' }
      } catch (e) {
        log(`pipeline: cancel failed: ${errText(e)}`)
        return { ok: false, error: 'not-found' }
      }
    },

    async discard(projectId, runId) {
      try {
        const owned = await ownedRun(projectId, runId)
        if (owned === null) return { ok: false, error: 'not-found' }
        if (activeRuns.get(projectId) === runId) return { ok: false, error: 'active' }
        const manager = createManager({ projectPath: owned.project.path, runId })
        const removed = await manager.removeRun()
        if (!removed.ok) {
          log(`pipeline: could not remove the worktrees of run ${runId}: ${removed.error}`)
          return { ok: false, error: 'cleanup-failed' }
        }
        const deleted = deps.store.deleteRun(runId)
        if (!deleted.ok) {
          log(`pipeline: could not delete run ${runId}: ${deleted.error}`)
          return deleted.error === 'not-found' ? { ok: false, error: 'not-found' } : { ok: false, error: 'cleanup-failed' }
        }
        return { ok: true }
      } catch (e) {
        log(`pipeline: discard failed: ${errText(e)}`)
        return { ok: false, error: 'cleanup-failed' }
      }
    }
  }
}
