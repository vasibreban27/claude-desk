import { z } from 'zod'
import { projectSettingsSchema, type ProjectSettings } from './settings'

export * from './settings'

/** Single definition of every IPC channel, payload and event. Shared by main, preload and renderer. */

export const CHAT_TEXT_MAX = 20000
/** Max events kept (and returned) per project for the latest run. */
export const ACTIVITY_BUFFER_MAX = 500

export const IPC = {
  projectsList: 'projects:list',
  projectsPickAndAdd: 'projects:pick-and-add',
  projectsRefresh: 'projects:refresh',
  chatHistory: 'chat:history',
  chatSend: 'chat:send',
  chatEvent: 'chat:event',
  activityEvent: 'activity:event',
  activityHistory: 'activity:history',
  usageSummary: 'usage:summary',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  appInfo: 'app:info'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

// --- Entities ---------------------------------------------------------------

export const projectSchema = z.object({
  id: z.uuid(),
  path: z.string().min(1),
  name: z.string(),
  /** null on a detached HEAD; unborn branch name in a repo with no commits. */
  branch: z.string().nullable(),
  dirty: z.boolean(),
  addedAt: z.iso.datetime({ offset: true })
})
export type Project = z.infer<typeof projectSchema>

export const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  at: z.iso.datetime({ offset: true })
})
export type ChatMessage = z.infer<typeof chatMessageSchema>

// --- Request schemas (validated in main handlers) ---------------------------

export const projectsRefreshRequestSchema = z.object({ id: z.uuid() })
export type ProjectsRefreshRequest = z.infer<typeof projectsRefreshRequestSchema>

export const chatHistoryRequestSchema = z.object({ projectId: z.uuid() })
export type ChatHistoryRequest = z.infer<typeof chatHistoryRequestSchema>

export const chatSendRequestSchema = z.object({
  projectId: z.uuid(),
  text: z.string().min(1).max(CHAT_TEXT_MAX)
})
export type ChatSendRequest = z.infer<typeof chatSendRequestSchema>

export const activityHistoryRequestSchema = z.object({ projectId: z.uuid() })
export type ActivityHistoryRequest = z.infer<typeof activityHistoryRequestSchema>

export const usageSummaryRequestSchema = z.object({
  /** null = all projects. */
  projectId: z.uuid().nullable(),
  /** Window = last `days` local calendar days including today. */
  days: z.number().int().min(1).max(365)
})
export type UsageSummaryRequest = z.infer<typeof usageSummaryRequestSchema>

export const settingsGetRequestSchema = z.object({ projectId: z.uuid() })
export type SettingsGetRequest = z.infer<typeof settingsGetRequestSchema>

export const settingsSetRequestSchema = z.object({
  projectId: z.uuid(),
  settings: projectSettingsSchema
})
export type SettingsSetRequest = z.infer<typeof settingsSetRequestSchema>

// --- Results ----------------------------------------------------------------

export type SettingsNotice = 'defaults-applied' | 'storage-unavailable'
export type SettingsGetResult =
  | { ok: true; settings: ProjectSettings; notice: SettingsNotice | null }
  | { ok: false; error: 'not-found' }

export type SettingsSetError = 'invalid' | 'not-found' | 'storage-unavailable'
// sessionReset is always false for now (all options are honoured on resume,
// see docs/notes/phase-3-spike.md); the field stays in case an SDK change needs it.
export type SettingsSetResult =
  | { ok: true; settings: ProjectSettings; sessionReset: boolean }
  | { ok: false; error: SettingsSetError }

export interface AppInfo {
  toolkit: {
    status: 'valid' | 'invalid' | 'unset'
    path: string | null
    version: string | null
  }
}
export type AppInfoResult = AppInfo

export type ProjectsListResult = Project[]

export type PickAndAddError = 'cancelled' | 'not-a-git-repo' | 'duplicate' | 'unreadable'
export type ProjectsPickAndAddResult =
  | { ok: true; project: Project }
  | { ok: false; error: PickAndAddError }

export type RefreshError = 'not-found' | 'unreadable'
export type ProjectsRefreshResult =
  | { ok: true; project: Project }
  | { ok: false; error: RefreshError }

export type ChatHistoryResult = ChatMessage[]

export type ChatSendError = 'not-found' | 'busy' | 'invalid'
export type ChatSendResult = { ok: true; turnId: string } | { ok: false; error: ChatSendError }

export type ActivityHistoryResult = ActivityEvent[]

export interface UsageTotals {
  runs: number
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface UsageByDay {
  /** Local date, YYYY-MM-DD. */
  day: string
  runs: number
  costUsd: number
  inputTokens: number
  outputTokens: number
}

export interface UsageByAgent {
  agent: string
  steps: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  approximate: boolean
}

export interface UsageByProject {
  projectId: string
  runs: number
  costUsd: number
}

/** Costs are client-side estimates, never billing figures. */
export interface UsageSummary {
  days: number
  estimated: true
  totals: UsageTotals
  byDay: UsageByDay[]
  byAgent: UsageByAgent[]
  /** Empty when the request named a project. */
  byProject: UsageByProject[]
}

export type UsageSummaryResult = UsageSummary

// --- Events (main -> renderer) ----------------------------------------------

export type ChatEvent =
  | { projectId: string; turnId: string; type: 'text-delta'; text: string }
  | { projectId: string; turnId: string; type: 'done' }
  | { projectId: string; turnId: string; type: 'error'; message: string }

export type ActivityEventBody =
  | { type: 'run-started' }
  | { type: 'tool-started'; toolUseId: string; tool: string; summary: string }
  | {
      type: 'tool-finished'
      toolUseId: string
      tool: string
      durationMs: number | null
      denied: boolean
    }
  | { type: 'agent-finished'; summary: string }
  | {
      type: 'run-finished'
      status: 'success' | 'error'
      costUsd: number | null
      durationMs: number | null
    }

export type ActivityEvent = {
  projectId: string
  runId: string
  /** Per run, starts at 0. */
  seq: number
  /** ISO-8601 with offset. */
  at: string
  /** "main" or the subagent type. */
  agent: string
  /** SDK agent_id; null for main. */
  agentId: string | null
} & ActivityEventBody

// --- Renderer-facing API exposed as window.api ------------------------------

export interface DeskApi {
  listProjects(): Promise<ProjectsListResult>
  pickAndAddProject(): Promise<ProjectsPickAndAddResult>
  refreshProject(req: ProjectsRefreshRequest): Promise<ProjectsRefreshResult>
  chatHistory(req: ChatHistoryRequest): Promise<ChatHistoryResult>
  chatSend(req: ChatSendRequest): Promise<ChatSendResult>
  /** Subscribe to chat events; returns an unsubscribe function. */
  onChatEvent(listener: (event: ChatEvent) => void): () => void
  activityHistory(req: ActivityHistoryRequest): Promise<ActivityHistoryResult>
  usageSummary(req: UsageSummaryRequest): Promise<UsageSummaryResult>
  settingsGet(req: SettingsGetRequest): Promise<SettingsGetResult>
  settingsSet(req: SettingsSetRequest): Promise<SettingsSetResult>
  appInfo(): Promise<AppInfoResult>
  /** Subscribe to activity events; returns an unsubscribe function. */
  onActivityEvent(listener: (event: ActivityEvent) => void): () => void
}
