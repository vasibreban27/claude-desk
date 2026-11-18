import { z } from 'zod'
import { projectSettingsSchema, type ProjectSettings } from './settings'

import type { PipelineStage, TaskFindingsView } from './review'

export * from './settings'
export * from './review'

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
  appInfo: 'app:info',
  pipelinePlans: 'pipeline:plans',
  pipelineStart: 'pipeline:start',
  pipelineStatus: 'pipeline:status',
  pipelineCancel: 'pipeline:cancel',
  pipelineDiscard: 'pipeline:discard',
  pipelineEvent: 'pipeline:event'
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

export const pipelinePlansRequestSchema = z.object({ projectId: z.uuid() })
export type PipelinePlansRequest = z.infer<typeof pipelinePlansRequestSchema>

export const PLAN_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.md$/
export const pipelineStartRequestSchema = z.object({
  projectId: z.uuid(),
  /** The whole name is at most 100 characters. */
  planFile: z.string().max(100).regex(PLAN_FILE_PATTERN)
})
export type PipelineStartRequest = z.infer<typeof pipelineStartRequestSchema>

export const pipelineStatusRequestSchema = z.object({ projectId: z.uuid() })
export type PipelineStatusRequest = z.infer<typeof pipelineStatusRequestSchema>

export const pipelineCancelRequestSchema = z.object({
  projectId: z.uuid(),
  runId: z.string().min(1)
})
export type PipelineCancelRequest = z.infer<typeof pipelineCancelRequestSchema>

export const pipelineDiscardRequestSchema = z.object({
  projectId: z.uuid(),
  runId: z.string().min(1)
})
export type PipelineDiscardRequest = z.infer<typeof pipelineDiscardRequestSchema>

// --- Results ----------------------------------------------------------------

export type PlanFormat = 'flow-plan/1' | 'legacy'

export interface PlanEntry {
  file: string
  title: string | null
  format: PlanFormat
  ok: boolean
  taskCount: number
  waveCount: number
  errorCount: number
  /** At most 20. */
  errors: { line: number; message: string }[]
}

export type PipelinePlansResult =
  | { ok: true; plans: PlanEntry[] }
  | { ok: false; error: 'not-found' | 'unreadable' }

export type PipelineStartError =
  | 'not-found'
  | 'invalid-plan'
  | 'busy'
  | 'no-toolkit'
  | 'detached-head'
  | 'storage-unavailable'
  | 'start-failed'
export type PipelineStartResult =
  | { ok: true; runId: string }
  | { ok: false; error: PipelineStartError; message?: string }

export type PipelineRunStatus = 'running' | 'done' | 'failed' | 'cancelled'
export type PipelineTaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled'

export interface PipelineTaskView {
  taskId: string
  title: string
  worker: string
  wave: number
  dependsOn: string[]
  status: PipelineTaskStatus
  reason: string | null
  /** 7 chars. */
  commit: string | null
  checks: 'passed' | 'failed' | 'none' | null
  turns: number | null
  costUsd: number | null
  durationMs: number | null
  stage: PipelineStage | null
  fixRounds: number | null
  findings: TaskFindingsView | null
}

export interface PipelineRunView {
  runId: string
  planFile: string
  status: PipelineRunStatus
  active: boolean
  baseBranch: string
  integrationBranch: string
  /** ISO-8601. */
  createdAt: string
  finishedAt: string | null
  tasks: PipelineTaskView[]
}

export type PipelineStatusResult =
  | { ok: true; run: PipelineRunView | null }
  | { ok: false; error: 'not-found' | 'storage-unavailable' }

export type PipelineCancelResult = { ok: true } | { ok: false; error: 'not-found' | 'not-active' }

export type PipelineDiscardResult =
  | { ok: true }
  | { ok: false; error: 'not-found' | 'active' | 'cleanup-failed' }

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

/** A change signal; the renderer re-fetches pipeline:status. */
export interface PipelineEvent {
  projectId: string
  runId: string
}

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
  pipelinePlans(req: PipelinePlansRequest): Promise<PipelinePlansResult>
  pipelineStart(req: PipelineStartRequest): Promise<PipelineStartResult>
  pipelineStatus(req: PipelineStatusRequest): Promise<PipelineStatusResult>
  pipelineCancel(req: PipelineCancelRequest): Promise<PipelineCancelResult>
  pipelineDiscard(req: PipelineDiscardRequest): Promise<PipelineDiscardResult>
  /** Subscribe to pipeline change signals; returns an unsubscribe function. */
  onPipelineEvent(listener: (event: PipelineEvent) => void): () => void
  /** Subscribe to activity events; returns an unsubscribe function. */
  onActivityEvent(listener: (event: ActivityEvent) => void): () => void
}
