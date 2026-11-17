import {
  activityHistoryRequestSchema,
  usageSummaryRequestSchema,
  chatHistoryRequestSchema,
  chatSendRequestSchema,
  projectsRefreshRequestSchema,
  settingsGetRequestSchema,
  settingsSetRequestSchema,
  type AppInfoResult,
  type SettingsGetResult,
  type SettingsSetResult,
  type ActivityHistoryResult,
  type UsageSummaryResult,
  type ChatHistoryResult,
  type ChatSendResult,
  type ProjectsListResult,
  type ProjectsPickAndAddResult,
  type ProjectsRefreshResult
} from '../../shared/ipc'
import type { GitStatusResult } from '../git/status'
import type { ProjectStore } from '../projects/store'
import type { ChatService } from '../chat/service'
import { emptySummary, type RunStore } from '../db'
import { createSettingsStore, type SettingsStore } from '../db/settingsStore'
import { needsSessionReset } from '../../shared/settings'

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

    async chatSend(payload, route) {
      const req = chatSendRequestSchema.safeParse(payload)
      if (!req.success) return { ok: false, error: 'invalid' }
      const undo = route?.(req.data.projectId)
      try {
        const result = deps.chat.send(req.data.projectId, req.data.text)
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
