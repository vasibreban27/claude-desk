import { randomUUID } from 'node:crypto'
import {
  ACTIVITY_BUFFER_MAX,
  type ActivityEvent,
  type ChatEvent,
  type ChatMessage,
  type ChatSendResult
} from '../../shared/ipc'
import { loadConfig, ConfigError, type ConfigResult } from '../config'
import type { RunStore } from '../db'
import {
  needsSessionReset,
  parseSettingsOrDefaults,
  projectSettingsSchema,
  type ProjectSettings
} from '../../shared/settings'
import type { ActivityDraft, AgentUsage, RunUsage } from './activity'
import type { ChatRunner } from './runner'
import type { ChatMcp } from '../mcp/servers'
import type { ChatMode, PipelineStartResult } from '../../shared/ipc'
import { BUILD_IN_APP_NOTE } from './deskTools'
import { PLAN_COMMAND, findPlansWrittenSince, framePlanFormat, loadPlanFormat, type PlanFound } from './plans'

interface RunState {
  projectId: string
  runId: string
  startedAt: Date
  seq: number
  usage: { usage: RunUsage; agents: AgentUsage[] } | null
  /** Recorded as a `plan` run (planner) or a `chat` run. */
  kind: 'chat' | 'plan'
  finished: boolean
  /** toolUseIds that already have a tool-finished (a denied tool may also fire PostToolUseFailure). */
  finishedTools: Set<string>
}

export interface ChatServiceDeps {
  /** Returns the absolute project path, or undefined when the project is unknown. */
  resolveProjectPath: (projectId: string) => string | undefined
  runner: ChatRunner
  emit: (event: ChatEvent) => void
  /** Receives stamped activity events (same routing as `emit` is the caller's job). */
  emitActivity?: (event: ActivityEvent) => void
  /** Where finished runs' usage is saved; optional so chat works without a database. */
  runStore?: Pick<RunStore, 'recordRun'>
  loadConfig?: () => ConfigResult
  /** Per-project settings; read once per turn. Absent or throwing means the safe defaults. */
  settings?: { get(projectId: string): { settings: ProjectSettings; notice: string | null } }
  /** Session rule; defaults to the shared `needsSessionReset`. Injectable for tests. */
  needsSessionReset?: (previous: ProjectSettings, next: ProjectSettings) => boolean
  now?: () => Date
  newId?: () => string
  /** Plans written during a planning turn (default: mtime scan of docs/plans). */
  findPlans?: (projectPath: string, sinceMs: number) => Promise<PlanFound[]>
  loadPlanFormat?: (pluginPath: string) => Promise<string | null>
  /** Plan mode: lets the planner start the app's pipeline when the user asks to build. */
  startPipeline?: (projectId: string, planFile: string) => Promise<PipelineStartResult>
  /** The user's MCP connections for Chat and Plan turns; read once per turn. A failure means none. */
  loadMcp?: () => Promise<ChatMcp>
}

const GENERIC_ERROR = 'The Claude session failed. Check that Claude Code is logged in and try again.'

/** One in-memory chat per project. History is lost when the service is discarded. */
export class ChatService {
  private readonly history = new Map<string, ChatMessage[]>()
  private readonly sessions = new Map<string, string>()
  /** The settings each project's stored session was started with. */
  private readonly sessionSettings = new Map<string, ProjectSettings>()
  private readonly busy = new Set<string>()
  private readonly activity = new Map<string, ActivityEvent[]>()
  private readonly deps: ChatServiceDeps

  constructor(deps: ChatServiceDeps) {
    this.deps = deps
  }

  getHistory(projectId: string): ChatMessage[] {
    return (this.history.get(projectId) ?? []).map((m) => ({ ...m }))
  }

  /** Accepts a turn synchronously; progress is reported through `emit`. */
  send(projectId: string, text: string, mode: ChatMode = 'chat'): ChatSendResult {
    const projectPath = this.deps.resolveProjectPath(projectId)
    if (projectPath === undefined) return { ok: false, error: 'not-found' }
    if (this.busy.has(projectId)) return { ok: false, error: 'busy' }

    this.busy.add(projectId)
    const turnId = this.id()
    this.append(projectId, 'user', text)
    const assistant = this.append(projectId, 'assistant', '')
    void this.runTurn(projectId, turnId, projectPath, text, assistant, mode)
    return { ok: true, turnId }
  }

  private async runTurn(
    projectId: string,
    turnId: string,
    projectPath: string,
    text: string,
    assistant: ChatMessage,
    mode: ChatMode = 'chat'
  ): Promise<void> {
    let run: RunState | null = null
    const planning = mode === 'plan'
    // Read once, kept for the whole run: a settings change during a run applies to the next turn.
    // Plan mode: the toolkit planner (flow:plan) on Opus, allowed to write docs/plans/ only.
    const base = this.readSettings(projectId)
    const settings: ProjectSettings = planning ? { ...base, model: 'opus', allowPlanWrites: true } : base
    const turnStarted = (this.deps.now ?? (() => new Date()))().getTime()
    try {
      const cfg = (this.deps.loadConfig ?? (() => loadConfig()))()
      if (!cfg.ok) throw cfg.error
      run = this.startRun(projectId, planning ? 'plan' : 'chat')
      const resume = this.resumeId(projectId, settings)
      const format = planning ? await (this.deps.loadPlanFormat ?? loadPlanFormat)(cfg.config.toolkitPath).catch(() => null) : null
      const mcp = this.deps.loadMcp ? await this.deps.loadMcp().catch(() => null) : null
      const stream = this.deps.runner({
        // A new planning session starts the toolkit's plan skill; later turns continue that conversation.
        prompt: planning && resume === undefined ? `${PLAN_COMMAND} ${text}` : text,
        cwd: projectPath,
        pluginPath: cfg.config.toolkitPath,
        resume,
        settings,
        ...(mcp !== null && mcp.allowedTools.length > 0 ? { mcp } : {}),
        ...(planning
          ? { appendPrompt: [format ? framePlanFormat(format) : '', BUILD_IN_APP_NOTE].filter(Boolean).join('\n\n') }
          : {}),
        ...(planning && this.deps.startPipeline ? { startPipeline: (planFile: string) => this.startFromChat(projectId, turnId, planFile) } : {})
      })
      for await (const item of stream) {
        if (item.kind === 'session') {
          this.sessions.set(projectId, item.sessionId)
          this.sessionSettings.set(projectId, settings)
        } else if (item.kind === 'activity') {
          this.recordActivity(run, item.draft)
        } else if (item.kind === 'usage') {
          run.usage = item
        } else {
          assistant.text += item.text
          this.deps.emit({ projectId, turnId, type: 'text-delta', text: item.text })
        }
      }
      this.finishRun(run, run.usage?.usage.isError ? 'error' : 'success')
      if (planning) await this.reportPlans(projectId, turnId, projectPath, turnStarted)
      this.busy.delete(projectId)
      this.deps.emit({ projectId, turnId, type: 'done' })
    } catch (err) {
      if (run) this.finishRun(run, 'error')
      this.busy.delete(projectId)
      console.error('chat turn failed:', err instanceof Error ? err.name : 'unknown')
      const message = err instanceof ConfigError ? err.message : GENERIC_ERROR
      this.deps.emit({ projectId, turnId, type: 'error', message })
    }
  }

  /** The planner asked to build: start the pipeline, tell the UI, and give the model a one-line result. */
  private async startFromChat(projectId: string, turnId: string, planFile: string): Promise<string> {
    const start = this.deps.startPipeline
    if (!start) return 'Starting the pipeline from chat is not available.'
    const r = await start(projectId, planFile).catch((): PipelineStartResult => ({ ok: false, error: 'start-failed' }))
    if (r.ok) {
      this.deps.emit({ projectId, turnId, type: 'pipeline-started', planFile, runId: r.runId })
      return `Pipeline started for docs/plans/${planFile} (run ${r.runId.slice(0, 8)}). Progress is in the Pipeline tab.`
    }
    const why: Record<string, string> = {
      busy: 'a pipeline run is already active for this project',
      'invalid-plan': 'the plan is not valid',
      'not-found': 'the plan file was not found',
      'detached-head': 'the project is on a detached HEAD',
      'no-toolkit': 'the toolkit is not available'
    }
    return `The pipeline did not start: ${r.message ?? why[r.error] ?? r.error}.`
  }

  /** Emits `plan-ready` for each docs/plans/*.md written during the turn, with its parse result. Never throws. */
  private async reportPlans(projectId: string, turnId: string, projectPath: string, since: number): Promise<void> {
    try {
      const found = await (this.deps.findPlans ?? findPlansWrittenSince)(projectPath, since)
      for (const p of found) this.deps.emit({ projectId, turnId, type: 'plan-ready', planFile: p.planFile, problem: p.problem })
    } catch (err) {
      console.error('chat: plan scan failed:', err instanceof Error ? err.name : 'unknown')
    }
  }

  /** Never throws: a failing or invalid reader gives the safe defaults. */
  private readSettings(projectId: string): ProjectSettings {
    const reader = this.deps.settings
    if (reader) {
      try {
        const parsed = projectSettingsSchema.safeParse(reader.get(projectId)?.settings)
        if (parsed.success) return parsed.data
      } catch {
        console.error('reading project settings failed')
      }
    }
    return parseSettingsOrDefaults(undefined).settings
  }

  /** The stored session id, or undefined when none exists or an option that is not honoured on resume changed. */
  private resumeId(projectId: string, current: ProjectSettings): string | undefined {
    const id = this.sessions.get(projectId)
    if (id === undefined) return undefined
    const previous = this.sessionSettings.get(projectId)
    if (previous === undefined) return id
    const rule = this.deps.needsSessionReset ?? ((a, b) => needsSessionReset(a, b))
    try {
      return rule(previous, current) ? undefined : id
    } catch {
      return undefined
    }
  }

  /** Latest run's events for a project, oldest first; [] when none. */
  activityHistory(projectId: string): ActivityEvent[] {
    return (this.activity.get(projectId) ?? []).map((e) => ({ ...e }))
  }

  private startRun(projectId: string, kind: RunState['kind']): RunState {
    const startedAt = this.now()
    const run: RunState = { projectId, runId: this.id(), startedAt, seq: 0, usage: null, kind, finished: false, finishedTools: new Set() }
    this.activity.set(projectId, [])
    this.recordActivity(run, { agent: 'main', agentId: null, type: 'run-started' })
    return run
  }

  private recordActivity(run: RunState, draft: ActivityDraft): void {
    if (draft.type === 'tool-finished') {
      if (run.finishedTools.has(draft.toolUseId)) return
      run.finishedTools.add(draft.toolUseId)
    }
    const event = {
      ...draft,
      projectId: run.projectId,
      runId: run.runId,
      seq: run.seq++,
      at: this.now().toISOString()
    } as ActivityEvent
    const buffer = this.activity.get(run.projectId)
    if (buffer) {
      buffer.push(event)
      if (buffer.length > ACTIVITY_BUFFER_MAX) buffer.splice(0, buffer.length - ACTIVITY_BUFFER_MAX)
    }
    try {
      this.deps.emitActivity?.(event)
    } catch {
      console.error('activity emit failed')
    }
  }

  /** Emits exactly one run-finished and stores the run's usage; a store failure never breaks the chat turn. */
  private finishRun(run: RunState, status: 'success' | 'error'): void {
    if (run.finished) return
    run.finished = true
    this.recordActivity(run, {
      agent: 'main',
      agentId: null,
      type: 'run-finished',
      status,
      costUsd: run.usage?.usage.costUsd ?? null,
      durationMs: run.usage?.usage.durationMs ?? null
    })
    if (run.usage && this.deps.runStore) {
      try {
        this.deps.runStore.recordRun({
          runId: run.runId,
          projectId: run.projectId,
          kind: run.kind,
          startedAt: run.startedAt.getTime(),
          usage: run.usage.usage,
          agents: run.usage.agents
        })
      } catch (err) {
        console.error('recording run usage failed:', err instanceof Error ? err.name : 'unknown')
      }
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private append(projectId: string, role: ChatMessage['role'], text: string): ChatMessage {
    const message: ChatMessage = {
      id: this.id(),
      role,
      text,
      at: (this.deps.now?.() ?? new Date()).toISOString()
    }
    const list = this.history.get(projectId) ?? []
    list.push(message)
    this.history.set(projectId, list)
    return message
  }

  private id(): string {
    return (this.deps.newId ?? randomUUID)()
  }
}
