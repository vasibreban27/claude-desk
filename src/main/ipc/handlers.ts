import {
  activityHistoryRequestSchema,
  traceRunsRequestSchema,
  traceEventsRequestSchema,
  type TraceRunsResult,
  type TraceEventsResult,
  usageSummaryRequestSchema,
  planUsageRequestSchema,
  type PlanUsageResult,
  chatHistoryRequestSchema,
  chatSendRequestSchema,
  pipelineCancelRequestSchema,
  pipelineResumeRequestSchema,
  pipelineDiscardRequestSchema,
  pipelineMergeRequestSchema,
  pipelineBranchRequestSchema,
  type PipelineBranchResult,
  pipelinePrRequestSchema,
  openUrlRequestSchema,
  type PipelinePrResult,
  pipelineLogRequestSchema,
  type PipelineLogResult,
  type PipelineMergeResult,
  pipelinePlansRequestSchema,
  pipelineStartRequestSchema,
  pipelineStatusRequestSchema,
  projectsRefreshRequestSchema,
  settingsGetRequestSchema,
  settingsSetRequestSchema,
  appModelSetRequestSchema,
  type AppModelSetResult,
  type AppInfoResult,
  type ToolkitListResult,
  type ProjectsCreateResult,
  type ProjectsRootResult,
  type ProjectsRemoveResult,
  projectsRemoveRequestSchema,
  projectsCreateRequestSchema,
  toolkitListingSchema,
  type SettingsGetResult,
  type SettingsSetResult,
  type ActivityHistoryResult,
  type UsageSummaryResult,
  type ChatHistoryResult,
  type ChatSendResult,
  type PipelineCancelResult,
  type PipelineResumeResult,
  type PipelineDiscardResult,
  type PipelinePlansResult,
  type PipelineStartResult,
  type PipelineStatusResult,
  type ProjectsListResult,
  type ProjectsPickAndAddResult,
  type ProjectsRefreshResult
} from '../../shared/ipc'
import { createProject } from '../projects/createProject'
import { suggestChecks } from '../projects/suggestChecks'
import { removeProject } from '../projects/removeProject'
import type { AppSettings } from '../projects/appSettings'
import { scanToolkit } from '../toolkit/scan'
import type { GitStatusResult } from '../git/status'
import type { ProjectStore } from '../projects/store'
import type { ChatService } from '../chat/service'
import { emptySummary, type RunStore } from '../db'
import { createSettingsStore, type SettingsStore } from '../db/settingsStore'
import type { PipelineService } from '../pipeline/service'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import {
  mcpIdRequestSchema,
  mcpSaveRequestSchema,
  type McpDeleteResult,
  type McpListResult,
  type McpSaveResult,
  type McpTestResult
} from '../../shared/mcp'
import type { McpStore } from '../mcp/store'
import type { DiscoverResult } from '../mcp/discover'
import { serverConfig } from '../mcp/servers'
import type { PlanUsageReader } from '../usage/planUsage'
import { defaultSettings, needsSessionReset } from '../../shared/settings'
import type { ModelChoice } from '../../shared/settings'
import type { CheckConfig } from '../../shared/settings'

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
  /** Moves a folder to the Recycle Bin / Trash (Electron shell.trashItem). Absent: folders are never deleted. */
  trash?: (folder: string) => Promise<void>
  /** Folders that are never deleted besides the projects root (for example the app's data folder). */
  protectedFolders?: () => string[]
  /** Marks listed projects whose folder is gone (absent: no check). */
  folderExists?: (folder: string) => Promise<boolean>
  /** Live pipeline log (history only; lines are broadcast by the log itself). */
  pipelineLog?: { history(projectId: string): PipelineLogResult }
  /** Opens an https URL in the default browser (Electron shell.openExternal). */
  openExternal?: (url: string) => Promise<void>
  gitRun?: (cwd: string, args: string[]) => Promise<void>
  /** Undefined when the pipeline could not be set up; pipeline calls then report storage-unavailable. */
  pipeline?: PipelineService
  /** MCP connections (store + tool discovery). Absent: the MCP calls report errors. */
  mcp?: {
    store: McpStore
    discover: (server: string, config: McpServerConfig) => Promise<DiscoverResult>
  }
  /** Reads the plan limits (Claude Code `/usage`). Absent: usage:plan reports failed. */
  planUsage?: PlanUsageReader
  /** Detailed Activity reader. Absent: no runs. */
  trace?: { runs(projectId: string): TraceRunsResult; events(projectId: string, runId: string): TraceEventsResult }
}

export interface Handlers {
  listProjects(): Promise<ProjectsListResult>
  pickAndAdd(): Promise<ProjectsPickAndAddResult>
  refresh(payload: unknown): Promise<ProjectsRefreshResult>
  chatHistory(payload: unknown): Promise<ChatHistoryResult>
  activityHistory(payload: unknown): Promise<ActivityHistoryResult>
  activityRuns(payload: unknown): Promise<TraceRunsResult>
  activityEvents(payload: unknown): Promise<TraceEventsResult>
  usageSummary(payload: unknown): Promise<UsageSummaryResult>
  usagePlan(payload: unknown): Promise<PlanUsageResult>
  settingsGet(payload: unknown): Promise<SettingsGetResult>
  settingsSet(payload: unknown): Promise<SettingsSetResult>
  settingsSuggestions(payload: unknown): Promise<CheckConfig[]>
  appInfo(): Promise<AppInfoResult>
  appModelGet(): Promise<{ model: ModelChoice }>
  appModelSet(payload: unknown): Promise<AppModelSetResult>
  toolkitList(): Promise<ToolkitListResult>
  createProject(payload: unknown): Promise<ProjectsCreateResult>
  projectsRootGet(): Promise<ProjectsRootResult>
  projectsRootPick(): Promise<ProjectsRootResult>
  removeProject(payload: unknown): Promise<ProjectsRemoveResult>
  pipelinePlans(payload: unknown): Promise<PipelinePlansResult>
  pipelineStart(payload: unknown): Promise<PipelineStartResult>
  pipelineStatus(payload: unknown): Promise<PipelineStatusResult>
  pipelineCancel(payload: unknown): Promise<PipelineCancelResult>
  pipelineResume(payload: unknown): Promise<PipelineResumeResult>
  pipelineDiscard(payload: unknown): Promise<PipelineDiscardResult>
  pipelineMerge(payload: unknown): Promise<PipelineMergeResult>
  pipelinePr(payload: unknown): Promise<PipelinePrResult>
  pipelineBranch(payload: unknown): Promise<PipelineBranchResult>
  openUrl(payload: unknown): Promise<boolean>
  pipelineLog(payload: unknown): Promise<PipelineLogResult>
  mcpList(): Promise<McpListResult>
  mcpSave(payload: unknown): Promise<McpSaveResult>
  mcpDelete(payload: unknown): Promise<McpDeleteResult>
  mcpTest(payload: unknown): Promise<McpTestResult>
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
        const list = await deps.store.list()
        const exists = deps.folderExists
        if (!exists) return list
        // A folder deleted outside the app is shown as missing, so it can be removed from the list.
        return await Promise.all(list.map(async (p) => ((await exists(p.path).catch(() => true)) ? p : { ...p, missing: true })))
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

    async activityRuns(payload) {
      const req = traceRunsRequestSchema.safeParse(payload)
      if (!req.success || !deps.trace) return []
      try {
        return deps.trace.runs(req.data.projectId)
      } catch (err) {
        console.error('activity:runs failed:', err instanceof Error ? err.name : 'unknown')
        return []
      }
    },

    async activityEvents(payload) {
      const req = traceEventsRequestSchema.safeParse(payload)
      if (!req.success || !deps.trace) return []
      try {
        return deps.trace.events(req.data.projectId, req.data.runId)
      } catch (err) {
        console.error('activity:events failed:', err instanceof Error ? err.name : 'unknown')
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

    async usagePlan(payload) {
      const req = planUsageRequestSchema.strict().safeParse(payload)
      if (!req.success) return { ok: false, error: 'failed', message: 'invalid request' }
      if (!deps.planUsage) return { ok: false, error: 'failed', message: 'plan usage is not available' }
      try {
        return await deps.planUsage.get(req.data.refresh)
      } catch (err) {
        console.error('usage:plan failed:', errName(err))
        return { ok: false, error: 'failed' }
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

    async settingsSuggestions(payload) {
      const req = settingsGetRequestSchema.strict().safeParse(payload)
      if (!req.success) return []
      try {
        const project = await deps.store.get(req.data.projectId)
        return project ? await suggestChecks(project.path) : []
      } catch {
        return []
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

    async appModelGet() {
      try {
        return { model: await deps.appSettings?.getDefaultModel() ?? 'auto' }
      } catch {
        return { model: 'auto' }
      }
    },

    async appModelSet(payload) {
      const req = appModelSetRequestSchema.strict().safeParse(payload)
      if (!req.success) return { ok: false, error: 'invalid' }
      if (!deps.appSettings) return { ok: false, error: 'unavailable' }
      try {
        await deps.appSettings.setDefaultModel(req.data.model)
        return { ok: true, model: req.data.model }
      } catch {
        return { ok: false, error: 'unavailable' }
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
        // A project created in the app may run allow-listed commands (npm install, venv, ...) in its workers.
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

    async removeProject(payload) {
      const req = projectsRemoveRequestSchema.strict().safeParse(payload)
      if (!req.success) return { ok: false, error: 'not-found' }
      if (req.data.deleteFolder && !deps.trash) return { ok: false, error: 'trash-failed', message: 'Deleting folders is not available.' }
      try {
        const root = (await deps.appSettings?.getProjectsRoot()) ?? null
        return await removeProject(req.data.id, req.data.deleteFolder, {
          store: deps.store,
          trash: deps.trash ?? (async () => undefined),
          protectedFolders: [...(deps.protectedFolders?.() ?? []), ...(root ? [root] : [])],
          isBusy: async (id) => {
            const s = await pipeline?.status(id)
            return s?.ok === true && s.run !== null && s.run.active
          },
          cleanupRuns: async (id) => {
            const s = await pipeline?.status(id)
            if (s?.ok && s.run && !s.run.active) await pipeline?.discard(id, s.run.runId)
          }
        })
      } catch (err) {
        console.error('projects:remove failed:', errName(err))
        return { ok: false, error: 'unreadable' }
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

    async pipelineResume(payload) {
      const req = pipelineResumeRequestSchema.strict().safeParse(payload)
      if (!req.success) return { ok: false, error: 'not-found' }
      if (!pipeline) return { ok: false, error: 'storage-unavailable' }
      try {
        return await pipeline.resume(req.data.projectId, req.data.runId)
      } catch (err) {
        console.error('pipeline:resume failed:', errName(err))
        return { ok: false, error: 'resume-failed' }
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

    async pipelineLog(payload) {
      const req = pipelineLogRequestSchema.strict().safeParse(payload)
      if (!req.success || !deps.pipelineLog) return []
      try {
        return deps.pipelineLog.history(req.data.projectId)
      } catch {
        return []
      }
    },

    async mcpList() {
      if (!deps.mcp) return { ok: false, error: 'unreadable' }
      try {
        return { ok: true, connections: await deps.mcp.store.list(), secretsAvailable: deps.mcp.store.secretsAvailable() }
      } catch (err) {
        console.error('mcp:list failed:', errName(err))
        return { ok: false, error: 'unreadable' }
      }
    },

    async mcpSave(payload) {
      const req = mcpSaveRequestSchema.strict().safeParse(payload)
      if (!req.success) return { ok: false, error: 'invalid', message: req.error.issues[0]?.message ?? 'invalid connection' }
      if (!deps.mcp) return { ok: false, error: 'storage-error' }
      try {
        return await deps.mcp.store.save(req.data)
      } catch (err) {
        console.error('mcp:save failed:', errName(err))
        return { ok: false, error: 'storage-error' }
      }
    },

    async mcpDelete(payload) {
      const req = mcpIdRequestSchema.strict().safeParse(payload)
      if (!req.success) return { ok: false, error: 'not-found' }
      if (!deps.mcp) return { ok: false, error: 'storage-error' }
      try {
        return await deps.mcp.store.remove(req.data.id)
      } catch (err) {
        console.error('mcp:delete failed:', errName(err))
        return { ok: false, error: 'storage-error' }
      }
    },

    async mcpTest(payload) {
      const req = mcpIdRequestSchema.strict().safeParse(payload)
      if (!req.success) return { ok: false, error: 'not-found' }
      const mcp = deps.mcp
      if (!mcp) return { ok: false, error: 'test-failed' }
      try {
        const c = await mcp.store.get(req.data.id)
        if (c === undefined) return { ok: false, error: 'not-found' }
        const found = await mcp.discover(c.name, serverConfig(c, await mcp.store.secretsFor(c.id)))
        const updated = found.status === 'connected' ? await mcp.store.setKnownTools(c.id, found.tools) : undefined
        return { ok: true, status: found.status, tools: found.tools, error: found.error, connection: updated ?? c }
      } catch (err) {
        // Never echo the error text: it could contain a header or env value.
        console.error('mcp:test failed:', errName(err))
        return { ok: false, error: 'test-failed' }
      }
    },

    async pipelinePr(payload) {
      const req = pipelinePrRequestSchema.strict().safeParse(payload)
      if (!req.success) return { ok: false, error: 'not-found' }
      if (!pipeline) return { ok: false, error: 'pr-failed' }
      try {
        return await pipeline.openPr(req.data.projectId, req.data.runId)
      } catch (err) {
        console.error('pipeline:pr failed:', errName(err))
        return { ok: false, error: 'pr-failed' }
      }
    },

    async pipelineBranch(payload) {
      const req = pipelineBranchRequestSchema.safeParse(payload)
      if (!req.success) {
        const named = typeof payload === 'object' && payload !== null && 'branch' in payload
        return named ? { ok: false, error: 'invalid-branch', message: 'That is not a valid branch name.' } : { ok: false, error: 'not-found' }
      }
      if (!pipeline) return { ok: false, error: 'git-failed' }
      try {
        return await pipeline.saveBranch(req.data.projectId, req.data.runId, req.data.branch)
      } catch (err) {
        console.error('pipeline:branch failed:', errName(err))
        return { ok: false, error: 'git-failed' }
      }
    },

    async openUrl(payload) {
      const req = openUrlRequestSchema.strict().safeParse(payload)
      if (!req.success || !deps.openExternal) return false
      try {
        await deps.openExternal(req.data.url)
        return true
      } catch {
        return false
      }
    },

    async pipelineMerge(payload) {
      const req = pipelineMergeRequestSchema.strict().safeParse(payload)
      if (!req.success) return { ok: false, error: 'not-found' }
      if (!pipeline) return { ok: false, error: 'git-failed' }
      try {
        return await pipeline.merge(req.data.projectId, req.data.runId)
      } catch (err) {
        console.error('pipeline:merge failed:', errName(err))
        return { ok: false, error: 'git-failed' }
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
