import { z } from 'zod'
import { MODEL_CHOICES, projectSettingsSchema, type CheckConfig, type DeliveryChoice, type ModelChoice, type ProjectSettings } from './settings'

import type { PipelineStage, TaskFindingsView } from './review'
import type { ToolkitListResult } from './toolkit'
import type { PipelineLogEntry, PipelineLogRequest, PipelineLogResult } from './pipelineLog'
import type { McpDeleteResult, McpIdRequest, McpListResult, McpSaveRequest, McpSaveResult, McpTestResult } from './mcp'
import type { PlanUsageRequest, PlanUsageResult } from './usage'
import type { TraceEventsRequest, TraceEventsResult, TracePush, TraceRunsRequest, TraceRunsResult } from './trace'

export * from './settings'
export * from './review'
export * from './toolkit'
export * from './pipelineLog'
export * from './mcp'
export * from './usage'
export * from './trace'

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
  activityRuns: 'activity:runs',
  activityEvents: 'activity:events',
  activityTrace: 'activity:trace',
  usageSummary: 'usage:summary',
  usagePlan: 'usage:plan',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsSuggestions: 'settings:suggestions',
  appInfo: 'app:info',
  appModelGet: 'app:model-get',
  appModelSet: 'app:model-set',
  projectsCreate: 'projects:create',
  projectsRootGet: 'projects:root-get',
  projectsRootPick: 'projects:root-pick',
  projectsRemove: 'projects:remove',
  toolkitList: 'toolkit:list',
  pipelinePlans: 'pipeline:plans',
  pipelineStart: 'pipeline:start',
  pipelineStatus: 'pipeline:status',
  pipelineCancel: 'pipeline:cancel',
  pipelineResume: 'pipeline:resume',
  pipelineDiscard: 'pipeline:discard',
  pipelineMerge: 'pipeline:merge',
  pipelinePr: 'pipeline:pr',
  openUrl: 'app:open-url',
  mcpList: 'mcp:list',
  mcpSave: 'mcp:save',
  mcpDelete: 'mcp:delete',
  mcpTest: 'mcp:test',
  pipelineEvent: 'pipeline:event',
  pipelineLog: 'pipeline:log',
  pipelineLogEvent: 'pipeline:log-event'
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
  addedAt: z.iso.datetime({ offset: true }),
  /** Set by projects:list when the folder no longer exists (never stored). */
  missing: z.boolean().optional()
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

/** `plan`: the toolkit planner (flow:plan, Opus) that may write docs/plans/ only. */
export const CHAT_MODES = ['chat', 'plan'] as const
export type ChatMode = (typeof CHAT_MODES)[number]

export const chatSendRequestSchema = z.object({
  projectId: z.uuid(),
  text: z.string().min(1).max(CHAT_TEXT_MAX),
  mode: z.enum(CHAT_MODES).optional()
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

export const appModelSetRequestSchema = z.object({ model: z.enum(MODEL_CHOICES) })
export type AppModelSetRequest = z.infer<typeof appModelSetRequestSchema>
export type AppModelSetResult = { ok: true; model: ModelChoice } | { ok: false; error: 'invalid' | 'unavailable' }

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

/** Continues a failed or cancelled run: merged tasks are kept, the others run again. */
export const pipelineResumeRequestSchema = z.object({
  projectId: z.uuid(),
  runId: z.string().min(1)
})
export type PipelineResumeRequest = z.infer<typeof pipelineResumeRequestSchema>

export const pipelineDiscardRequestSchema = z.object({
  projectId: z.uuid(),
  runId: z.string().min(1)
})
export type PipelineDiscardRequest = z.infer<typeof pipelineDiscardRequestSchema>

/** Fast-forwards the base branch of the project to a finished run's branch (the user's click is the policy). */
export const pipelineMergeRequestSchema = z.object({
  projectId: z.uuid(),
  runId: z.string().min(1).max(100)
})
export type PipelineMergeRequest = z.infer<typeof pipelineMergeRequestSchema>

/** Pushes a finished run's branch to origin and opens a PR (gh) / MR (glab) into the base branch. Nothing merges. */
export const pipelinePrRequestSchema = pipelineMergeRequestSchema
export type PipelinePrRequest = PipelineMergeRequest
export type PipelinePrResult =
  | { ok: true; url: string; branch: string; host: 'github' | 'gitlab' }
  | {
      ok: false
      error:
        | 'not-found'
        | 'not-finished'
        | 'no-remote'
        | 'unsupported-host'
        | 'no-cli'
        | 'not-logged-in'
        | 'base-not-on-remote'
        | 'push-failed'
        | 'pr-failed'
      message?: string
    }

/** Opens an https URL in the default browser (for example a pull request just created). */
export const openUrlRequestSchema = z.object({ url: z.url({ protocol: /^https$/ }).max(2000) })
export type OpenUrlRequest = z.infer<typeof openUrlRequestSchema>
export type PipelineMergeResult =
  | { ok: true; baseBranch: string; head: string; planCommitted: boolean; cleanedUp: boolean }
  | {
      ok: false
      error: 'not-found' | 'not-finished' | 'wrong-branch' | 'dirty' | 'not-fast-forward' | 'git-failed'
      message?: string
    }

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

export type PipelineResumeError = 'not-found' | 'busy' | 'no-toolkit' | 'storage-unavailable' | 'resume-failed'
export type PipelineResumeResult =
  | { ok: true; runId: string }
  | { ok: false; error: PipelineResumeError; message?: string }

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
  delivery?: { policy: DeliveryChoice; status: 'pending' | 'working' | 'done' | 'failed'; url?: string; message?: string }
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

export const projectsCreateRequestSchema = z.object({
  name: z.string().min(1).max(100),
  claudeMd: z.boolean().optional(),
  /** Lets this project's pipeline workers use the allow-listed run_command tool (npm install, venv, ...). */
  enableCommands: z.boolean().optional()
})
export type ProjectsCreateRequest = z.infer<typeof projectsCreateRequestSchema>
export type ProjectsCreateResult =
  | { ok: true; project: Project }
  | { ok: false; error: 'invalid-name' | 'no-root' | 'exists' | 'escape' | 'git-failed' | 'register-failed' }
export type ProjectsRootResult = { root: string | null }

export const projectsRemoveRequestSchema = z.object({
  id: z.uuid(),
  /** Also move the project folder to the Recycle Bin / Trash (recoverable). */
  deleteFolder: z.boolean()
})
export type ProjectsRemoveRequest = z.infer<typeof projectsRemoveRequestSchema>
export type ProjectsRemoveResult =
  | { ok: true; folderDeleted: boolean }
  | { ok: false; error: 'not-found' | 'busy' | 'unsafe-path' | 'trash-failed' | 'unreadable'; message?: string }

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
  /** Input + output + cache read + cache write. */
  tokens: number
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

/** What a recorded session was: a chat turn, a planner turn, a pipeline worker or a reviewer. */
export const USAGE_KINDS = ['chat', 'plan', 'worker', 'reviewer'] as const
export type UsageKind = (typeof USAGE_KINDS)[number]

export interface UsageByKind {
  kind: UsageKind
  runs: number
  costUsd: number
  /** Input + output + cache read + cache write. */
  tokens: number
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
  /** Only kinds with at least one run, largest first. */
  byKind: UsageByKind[]
  /** Empty when the request named a project. */
  byProject: UsageByProject[]
}

export type UsageSummaryResult = UsageSummary

// --- Events (main -> renderer) ----------------------------------------------

export type ChatEvent =
  | { projectId: string; turnId: string; type: 'text-delta'; text: string }
  | { projectId: string; turnId: string; type: 'done' }
  | { projectId: string; turnId: string; type: 'error'; message: string }
  | { projectId: string; turnId: string; type: 'plan-ready'; planFile: string; problem: string | null }
  | { projectId: string; turnId: string; type: 'pipeline-started'; planFile: string; runId: string }

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
  usagePlan(req: PlanUsageRequest): Promise<PlanUsageResult>
  settingsGet(req: SettingsGetRequest): Promise<SettingsGetResult>
  settingsSet(req: SettingsSetRequest): Promise<SettingsSetResult>
  settingsSuggestions(req: SettingsGetRequest): Promise<CheckConfig[]>
  appInfo(): Promise<AppInfoResult>
  appModelGet(): Promise<{ model: ModelChoice }>
  appModelSet(req: AppModelSetRequest): Promise<AppModelSetResult>
  toolkitList(): Promise<ToolkitListResult>
  createProject(req: ProjectsCreateRequest): Promise<ProjectsCreateResult>
  projectsRootGet(): Promise<ProjectsRootResult>
  projectsRootPick(): Promise<ProjectsRootResult>
  removeProject(req: ProjectsRemoveRequest): Promise<ProjectsRemoveResult>
  pipelinePlans(req: PipelinePlansRequest): Promise<PipelinePlansResult>
  pipelineStart(req: PipelineStartRequest): Promise<PipelineStartResult>
  pipelineStatus(req: PipelineStatusRequest): Promise<PipelineStatusResult>
  pipelineCancel(req: PipelineCancelRequest): Promise<PipelineCancelResult>
  pipelineResume(req: PipelineResumeRequest): Promise<PipelineResumeResult>
  pipelineDiscard(req: PipelineDiscardRequest): Promise<PipelineDiscardResult>
  pipelineMerge(req: PipelineMergeRequest): Promise<PipelineMergeResult>
  pipelinePr(req: PipelinePrRequest): Promise<PipelinePrResult>
  openUrl(req: OpenUrlRequest): Promise<boolean>
  mcpList(): Promise<McpListResult>
  mcpSave(req: McpSaveRequest): Promise<McpSaveResult>
  mcpDelete(req: McpIdRequest): Promise<McpDeleteResult>
  /** Connects to the server, lists its tools and stores them; nothing is sent to the model. */
  mcpTest(req: McpIdRequest): Promise<McpTestResult>
  /** Subscribe to pipeline change signals; returns an unsubscribe function. */
  onPipelineEvent(listener: (event: PipelineEvent) => void): () => void
  /** The latest run's live log lines for a project (in memory, capped). */
  pipelineLog(req: PipelineLogRequest): Promise<PipelineLogResult>
  /** Subscribe to live pipeline log lines; returns an unsubscribe function. */
  onPipelineLog(listener: (entry: PipelineLogEntry) => void): () => void
  /** Subscribe to activity events; returns an unsubscribe function. */
  onActivityEvent(listener: (event: ActivityEvent) => void): () => void
  /** Detailed Activity: the project's recent runs, newest first. */
  activityRuns(req: TraceRunsRequest): Promise<TraceRunsResult>
  /** Detailed Activity: every kept event of one run, oldest first. */
  activityEvents(req: TraceEventsRequest): Promise<TraceEventsResult>
  /** Subscribe to live Detailed Activity events and run changes; returns an unsubscribe function. */
  onActivityTrace(listener: (push: TracePush) => void): () => void
}
