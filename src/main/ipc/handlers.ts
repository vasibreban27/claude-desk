import {
  activityHistoryRequestSchema,
  usageSummaryRequestSchema,
  chatHistoryRequestSchema,
  chatSendRequestSchema,
  pipelineCancelRequestSchema,
  pipelineDiscardRequestSchema,
  pipelinePlansRequestSchema,
  pipelineStartRequestSchema,
  pipelineStatusRequestSchema,
  projectsRefreshRequestSchema,
  settingsGetRequestSchema,
  settingsSetRequestSchema,
  type AppInfoResult,
  type ToolkitListResult,
  type ProjectsCreateResult,
  type ProjectsRootResult,
  projectsCreateRequestSchema,
  toolkitListingSchema,
  type SettingsGetResult,
  type SettingsSetResult,
  type ActivityHistoryResult,
  type UsageSummaryResult,
  type ChatHistoryResult,
  type ChatSendResult,
  type PipelineCancelResult,
  type PipelineDiscardResult,
  type PipelinePlansResult,
  type PipelineStartResult,
  type PipelineStatusResult,
  type ProjectsListResult,
  type ProjectsPickAndAddResult,
  type ProjectsRefreshResult
} from '../../shared/ipc'
import { createProject } from '../projects/createProject'
import type { AppSettings } from '../projects/appSettings'
import { scanToolkit } from '../toolkit/scan'
import type { GitStatusResult } from '../git/status'
import type { ProjectStore } from '../projects/store'
import type { ChatService } from '../chat/service'
import { emptySummary, type RunStore } from '../db'
import { createSettingsStore, type SettingsStore } from '../db/settingsStore'
import type { PipelineService } from '../pipeline/service'
import { defaultSettings, needsSessionReset } from '../../shared/settings'

export interface HandlerDeps {
  store: ProjectStore
  readGitStatus: (path: string) => Promise<GitStatusResult>
  /** Opens the native folder picker; resolves to the chosen path or undefined when cancelled. */
  pickFolder: () => Promise<string | undefined>
  chat: Pick<ChatService, 'getHistory' | 'send' | 'activityHistory'>
  /** Undefined when the database could not be opened. */
  runStore?: Pick<RunStore, 'summary'>
  /** Created in unavailable mode when the database could not be opened. */
  settingsStore?: SettingsStore
  readToolkitInfo?: () => AppInfoResult['toolkit']
  scanToolkit?: (folder: string) => Promise<unknown>
  appSettings?: AppSettings
  gitRun?: (cwd: string, args: string[]) => Promise<void>
  /** Undefined when the pipeline could not be set up; pipeline calls then report storage-unavailable. */
  pipeline?: PipelineService
}

export interface Handlers {
  listProjects(): Promise<ProjectsListResult>
  pickAndAdd(): Promise<ProjectsPickAndAddResult>
  refresh(payload: unknown): Promise<ProjectsRefreshResult>
  chatHistory(payload: unknown): Promise<ChatHistoryResult>
  activityHistory(payload: unknown): Promise<ActivityHistoryResult>
  usageSummary(payload: unknown): Promise<UsageSummaryResult>
  settingsGet(payload: unknown): Promise<SettingsGetResult>
  settingsSet(payload: unknown): Promise<SettingsSetResult>
  appInfo(): Promise<AppInfoResult>
  toolkitList(): Promise<ToolkitListResult>
  createProject(payload: unknown): Promise<ProjectsCreateResult>
  projectsRootGet(): Promise<ProjectsRootResult>
  projectsRootPick(): Promise<ProjectsRootResult>
  pipelinePlans(payload: unknown): Promise<PipelinePlansResult>
  pipelineStart(payload: unknown): Promise<PipelineStartResult>
  pipelineStatus(payload: unknown): Promise<PipelineStatusResult>
  pipelineCancel(payload: unknown): Promise<PipelineCancelResult>
  pipelineDiscard(payload: unknown): Promise<PipelineDiscardResult>
  /**
   * `route` runs before the turn starts (events may be emitted synchronously) and returns
   * an undo function that is called when the send is rejected.
   */
  chatSend(payload: unknown, route?: (projectId: string) => () => void): Promise<ChatSendResult>
}

/** Best-effort `days` for an invalid request so the empty summary still carries a sane window. */
function requestedDays(payload: unknown): number {
  const days = typeof payload === 'object' && payload !== null ? (payload as { days?: unknown }).days : undefined
  return typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= 365 ? days : 30
}

/** Handlers never throw: every failure maps to the contract's error value (or an empty result). */
export function createHandlers(deps: HandlerDeps): Handlers {
  const settingsStore = deps.settingsStore ?? createSettingsStore(null)
  const readToolkitInfo = deps.readToolkitInfo ?? (() => ({ status: 'unset' as const, path: null, version: null }))
  const pipeline = deps.pipeline
  const errName = (err: unknown): string => (err instanceof Error ? err.name : 'unknown')
  return {
    async listProjects() {
      try {
        return await deps.store.list()
      } catch (err) {
        console.error('projects:list failed:', err instanceof Error ? err.name : 'unknown')
        return []
      }
    },

    async pickAndAdd() {
      try {
        const picked = await deps.pickFolder()
        if (picked === undefined) return { ok: false, error: 'cancelled' }
        const status = await deps.readGitStatus(picked)
        if (!status.ok) return { ok: false, error: status.error }
        const added = await deps.store.add({ path: picked, branch: status.branch, dirty: status.dirty })
        return added.ok ? { ok: true, project: added.project } : { ok: false, error: added.error }
      } catch (err) {
        console.error('projects:pick-and-add failed:', err instanceof Error ? err.name : 'unknown')
        return { ok: false, error: 'unreadable' }
      }
    },

    async refresh(payload) {
      const req = projectsRefreshRequestSchema.safeParse(payload)
      if (!req.success) return { ok: false, error: 'not-found' }
      try {
        const project = await deps.store.get(req.data.id)
        if (!project) return { ok: false, error: 'not-found' }
        const status = await deps.readGitStatus(project.path)
        if (!status.ok) return { ok: false, error: 'unreadable' }
        const updated = await deps.store.update(project.id, { branch: status.branch, dirty: status.dirty })
        return updated ? { ok: true, project: updated } : { ok: false, error: 'not-found' }
      } catch (err) {
        console.error('projects:refresh failed:', err instanceof Error ? err.name : 'unknown')
        return { ok: false, error: 'unreadable' }
      }
    },

    async chatHistory(payload) {
      const req = chatHistoryRequestSchema.safeParse(payload)
      if (!req.success) return []
      return deps.chat.getHistory(req.data.projectId)
    },

    async activityHistory(payload) {
      const req = activityHistoryRequestSchema.safeParse(payload)
      if (!req.success) return []
      try {
        return deps.chat.activityHistory(req.data.projectId)
      } catch (err) {
        console.error('activity:history failed:', err instanceof Error ? err.name : 'unknown')
        return []
      }
    },

    async usageSummary(payload) {
      const req = usageSummaryRequestSchema.safeParse(payload)
      if (!req.success) return emptySummary(requestedDays(payload))
      if (!deps.runStore) return emptySummary(req.data.days)
      try {
        return deps.runStore.summary(req.data)
      } catch (err) {
        console.error('usage:summary failed:', err instanceof Error ? err.name : 'unknown')
        return emptySummary(req.data.days)
      }
    },

    async settingsGet(payload) {
      const req = settingsGetRequestSchema.safeParse(payload)
      if (!req.success) return { ok: false, error: 'not-found' }
      try {
        if (!(await deps.store.get(req.data.projectId))) return { ok: false, error: 'not-found' }
        const { settings, notice } = settingsStore.get(req.data.projectId)
        return { ok: true, settings, notice }
      } catch (err) {
        console.error('settings:get failed:', err instanceof Error ? err.name : 'unknown')
        return { ok: false, error: 'not-found' }
      }
    },

    async settingsSet(payload) {
      const req = settingsSetRequestSchema.safeParse(payload)
      if (!req.success) return { ok: false, error: 'invalid' }
      try {
        if (!(await deps.store.get(req.data.projectId))) return { ok: false, error: 'not-found' }
        const previous = settingsStore.get(req.data.projectId).settings
        const saved = settingsStore.set(req.data.projectId, req.data.settings)
        if (!saved.ok) return { ok: false, error: saved.error }
        return { ok: true, settings: saved.settings, sessionReset: needsSessionReset(previous, saved.settings) }
      } catch (err) {
        console.error('settings:set failed:', err instanceof Error ? err.name : 'unknown')
        return { ok: false, error: 'storage-unavailable' }
      }
    },

    async appInfo() {
      try {
        return { toolkit: readToolkitInfo() }
      } catch (err) {
        console.error('app:info failed:', err instanceof Error ? err.name : 'unknown')
        return { toolkit: { status: 'invalid', path: null, version: null } }
      }
    },

    async createProject(payload) {
      const req = projectsCreateRequestSchema.strict().safeParse(payload)
      if (!req.success) return { ok: false, error: 'invalid-name' }
      try {
        const root = (await deps.appSettings?.getProjectsRoot()) ?? null
        const created = await createProject(
          root,
          req.data.name,
          { store: deps.store, ...(deps.gitRun ? { git: deps.gitRun } : {}) },
          { claudeMd: req.data.claudeMd === true }
        )
        // A project the assistant creates may run allow-listed commands (npm install, venv, ...) in its workers.
        if (created.ok && req.data.enableCommands === true) {
          const saved = settingsStore.set(created.project.id, { ...defaultSettings(), allowCommands: true })
          if (!saved.ok) console.error('projects:create: could not enable commands:', saved.error)
        }
        return created
      } catch (err) {
        console.error('projects:create failed:', errName(err))
        return { ok: false, error: 'register-failed' }
      }
    },

    async projectsRootGet() {
      try {
        return { root: (await deps.appSettings?.getProjectsRoot()) ?? null }
      } catch {
        return { root: null }
      }
    },

    async projectsRootPick() {
      try {
        const picked = await deps.pickFolder()
        if (picked !== undefined && deps.appSettings) await deps.appSettings.setProjectsRoot(picked)
        return { root: (await deps.appSettings?.getProjectsRoot()) ?? null }
      } catch {
        return { root: null }
      }
    },

    async toolkitList() {
      try {
        const info = readToolkitInfo()
        if (info.path === null) return { ok: false, error: 'unset' }
        const listing = toolkitListingSchema.safeParse(await (deps.scanToolkit ?? scanToolkit)(info.path))
        return listing.success ? { ok: true, listing: listing.data } : { ok: false, error: 'unreadable' }
      } catch (err) {
        console.error('toolkit:list failed:', errName(err))
        return { ok: false, error: 'unreadable' }
      }
    },

    async pipelinePlans(payload) {
      const req = pipelinePlansRequestSchema.strict().safeParse(payload)
      if (!req.success) return { ok: false, error: 'not-found' }
      if (!pipeline) return { ok: false, error: 'unreadable' }
      try {
        return await pipeline.listPlans(req.data.projectId)
      } catch (err) {
        console.error('pipeline:plans failed:', errName(err))
        return { ok: false, error: 'unreadable' }
      }
    },

    async pipelineStart(payload) {
      const req = pipelineStartRequestSchema.strict().safeParse(payload)
      if (!req.success) {
        const idOk = pipelinePlansRequestSchema.safeParse(payload).success
        return { ok: false, error: idOk ? 'invalid-plan' : 'not-found' }
      }
      if (!pipeline) return { ok: false, error: 'storage-unavailable' }
      try {
        return await pipeline.start(req.data.projectId, req.data.planFile)
      } catch (err) {
        console.error('pipeline:start failed:', errName(err))
        return { ok: false, error: 'start-failed' }
      }
    },

    async pipelineStatus(payload) {
      const req = pipelineStatusRequestSchema.strict().safeParse(payload)
      if (!req.success) return { ok: false, error: 'not-found' }
      if (!pipeline) return { ok: false, error: 'storage-unavailable' }
      try {
        return await pipeline.status(req.data.projectId)
      } catch (err) {
        console.error('pipeline:status failed:', errName(err))
        return { ok: false, error: 'storage-unavailable' }
      }
    },

    async pipelineCancel(payload) {
      const req = pipelineCancelRequestSchema.strict().safeParse(payload)
      if (!req.success) return { ok: false, error: 'not-found' }
      if (!pipeline) return { ok: false, error: 'not-found' }
      try {
        return await pipeline.cancel(req.data.projectId, req.data.runId)
      } catch (err) {
        console.error('pipeline:cancel failed:', errName(err))
        return { ok: false, error: 'not-found' }
      }
    },

    async pipelineDiscard(payload) {
      const req = pipelineDiscardRequestSchema.strict().safeParse(payload)
      if (!req.success) return { ok: false, error: 'not-found' }
      if (!pipeline) return { ok: false, error: 'cleanup-failed' }
      try {
        return await pipeline.discard(req.data.projectId, req.data.runId)
      } catch (err) {
        console.error('pipeline:discard failed:', errName(err))
        return { ok: false, error: 'cleanup-failed' }
      }
    },

    async chatSend(payload, route) {
      const req = chatSendRequestSchema.safeParse(payload)
      if (!req.success) return { ok: false, error: 'invalid' }
      const undo = route?.(req.data.projectId)
      try {
        const result = deps.chat.send(req.data.projectId, req.data.text, req.data.mode ?? 'chat')
        if (!result.ok) undo?.()
        return result
      } catch (err) {
        undo?.()
        console.error('chat:send failed:', err instanceof Error ? err.name : 'unknown')
        return { ok: false, error: 'invalid' }
      }
    }
  }
}
