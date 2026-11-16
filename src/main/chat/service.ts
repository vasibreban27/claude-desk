import { randomUUID } from 'node:crypto'
import type { ChatEvent, ChatMessage, ChatSendResult } from '../../shared/ipc'
import { loadConfig, ConfigError, type ConfigResult } from '../config'
import type { ChatRunner } from './runner'

export interface ChatServiceDeps {
  /** Returns the absolute project path, or undefined when the project is unknown. */
  resolveProjectPath: (projectId: string) => string | undefined
  runner: ChatRunner
  emit: (event: ChatEvent) => void
  loadConfig?: () => ConfigResult
  now?: () => Date
  newId?: () => string
}

const GENERIC_ERROR = 'The Claude session failed. Check that Claude Code is logged in and try again.'

/** One in-memory chat per project. History is lost when the service is discarded. */
export class ChatService {
  private readonly history = new Map<string, ChatMessage[]>()
  private readonly sessions = new Map<string, string>()
  private readonly busy = new Set<string>()
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
    try {
      const cfg = (this.deps.loadConfig ?? (() => loadConfig()))()
      if (!cfg.ok) throw cfg.error
      const stream = this.deps.runner({
        prompt: text,
        cwd: projectPath,
        pluginPath: cfg.config.toolkitPath,
        resume: this.sessions.get(projectId)
      })
      for await (const item of stream) {
        if (item.kind === 'session') {
          this.sessions.set(projectId, item.sessionId)
        } else {
          assistant.text += item.text
          this.deps.emit({ projectId, turnId, type: 'text-delta', text: item.text })
        }
      }
      this.busy.delete(projectId)
      this.deps.emit({ projectId, turnId, type: 'done' })
    } catch (err) {
      this.busy.delete(projectId)
      console.error('chat turn failed:', err instanceof Error ? err.name : 'unknown')
      const message = err instanceof ConfigError ? err.message : GENERIC_ERROR
      this.deps.emit({ projectId, turnId, type: 'error', message })
    }
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
