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
import { ASSISTANT_PROJECT_ID } from '../../shared/ipc'

interface RunState {
  projectId: string
  runId: string
  startedAt: Date
  seq: number
  usage: { usage: RunUsage; agents: AgentUsage[] } | null
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
  send(projectId: string, text: string): ChatSendResult {
    const projectPath = this.deps.resolveProjectPath(projectId)
    if (projectPath === undefined) return { ok: false, error: 'not-found' }
    if (this.busy.has(projectId)) return { ok: false, error: 'busy' }

    this.busy.add(projectId)
    const turnId = this.id()
    this.append(projectId, 'user', text)
    const assistant = this.append(projectId, 'assistant', '')
    void this.runTurn(projectId, turnId, projectPath, text, assistant)
    return { ok: true, turnId }
  }

  private async runTurn(
    projectId: string,
    turnId: string,
    projectPath: string,
    text: string,
    assistant: ChatMessage
  ): Promise<void> {
    let run: RunState | null = null
    // Read once, kept for the whole run: a settings change during a run applies to the next turn.
    const settings = this.readSettings(projectId)
    try {
      const cfg = (this.deps.loadConfig ?? (() => loadConfig()))()
      if (!cfg.ok) throw cfg.error
      run = this.startRun(projectId)
      const stream = this.deps.runner({
        prompt: text,
        cwd: projectPath,
        pluginPath: cfg.config.toolkitPath,
        resume: this.resumeId(projectId, settings),
        settings,
        ...(projectId === ASSISTANT_PROJECT_ID ? { assistant: true } : {})
      })
      for await (const item of stream) {
        if (item.kind === 'session') {
          this.sessions.set(projectId, item.sessionId)
          this.sessionSettings.set(projectId, settings)
        } else if (item.kind === 'activity') {
          this.recordActivity(run, item.draft)
        } else if (item.kind === 'proposal') {
          this.deps.emit({ projectId, turnId, type: 'proposal', name: item.name, brief: item.brief, worker: item.worker })
        } else if (item.kind === 'usage') {
          run.usage = item
        } else {
          assistant.text += item.text
          this.deps.emit({ projectId, turnId, type: 'text-delta', text: item.text })
        }
      }
      this.finishRun(run, run.usage?.usage.isError ? 'error' : 'success')
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

  private startRun(projectId: string): RunState {
    const startedAt = this.now()
    const run: RunState = { projectId, runId: this.id(), startedAt, seq: 0, usage: null, finished: false, finishedTools: new Set() }
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
    if (run.usage && this.deps.runStore && run.projectId !== ASSISTANT_PROJECT_ID) {
      try {
        this.deps.runStore.recordRun({
          runId: run.runId,
          projectId: run.projectId,
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
