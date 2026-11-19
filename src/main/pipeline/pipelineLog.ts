import path from 'node:path'
import {
  PIPELINE_LOG_MAX,
  PIPELINE_LOG_TEXT_MAX,
  type PipelineLogEntry,
  type PipelineLogRole,
  type PipelineLogTone
} from '../../shared/pipelineLog'
import { mapDeniedToolUse, mapHookInput, type ActivityDraft } from '../chat/activity'
import { isDenied, type GuardOutput } from '../chat/tools'

/** What a runner or the orchestrator reports; the log adds project, run, seq and time. */
export interface LogLine {
  text: string
  tone?: PipelineLogTone
}
export type LogSink = (line: LogLine) => void

export interface PipelineLogInput {
  runId: string
  taskId: string | null
  role: PipelineLogRole
  agent?: string | null
  text: string
  tone?: PipelineLogTone
}

export interface PipelineLog {
  add(projectId: string, input: PipelineLogInput): void
  history(projectId: string): PipelineLogEntry[]
}

/**
 * In-memory, per project: the latest run only, capped at PIPELINE_LOG_MAX lines (oldest dropped).
 * Text is single-lined and capped. `emit` never breaks a run.
 */
export function createPipelineLog(emit: (e: PipelineLogEntry) => void, now: () => Date = () => new Date()): PipelineLog {
  const byProject = new Map<string, { runId: string; seq: number; lines: PipelineLogEntry[] }>()
  return {
    add(projectId, input) {
      let state = byProject.get(projectId)
      if (state === undefined || state.runId !== input.runId) {
        state = { runId: input.runId, seq: 0, lines: [] }
        byProject.set(projectId, state)
      }
      const entry: PipelineLogEntry = {
        projectId,
        runId: input.runId,
        seq: state.seq++,
        at: now().toISOString(),
        taskId: input.taskId,
        role: input.role,
        agent: input.agent ?? null,
        text: oneLine(input.text),
        tone: input.tone ?? 'info'
      }
      state.lines.push(entry)
      if (state.lines.length > PIPELINE_LOG_MAX) state.lines.splice(0, state.lines.length - PIPELINE_LOG_MAX)
      try {
        emit(entry)
      } catch {
        // tracking must never break a run
      }
    },
    history(projectId) {
      return (byProject.get(projectId)?.lines ?? []).map((l) => ({ ...l }))
    }
  }
}

export function oneLine(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > PIPELINE_LOG_TEXT_MAX ? `${t.slice(0, PIPELINE_LOG_TEXT_MAX - 1)}…` : t
}

/** Short tool name: `mcp__work__run_command` -> `run_command`. */
export function shortTool(tool: string): string {
  const i = tool.lastIndexOf('__')
  return tool.startsWith('mcp__') && i > 4 ? tool.slice(i + 2) : tool
}

/** Shows paths relative to the worktree (forward slashes); leaves other text alone. */
export function relativize(text: string, worktree: string): string {
  const variants = new Set([worktree, worktree.replace(/\\/g, '/'), path.resolve(worktree)])
  let out = text
  for (const v of variants) {
    if (v.length < 3) continue
    const re = new RegExp(`${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]?`, 'gi')
    out = out.replace(re, '')
  }
  return out.replace(/\\/g, '/')
}

/**
 * A log line for a tool hook event: started tools by name and short target, denied tools marked. Normal
 * finishes are skipped (the work tools report their own outcome) to keep the log short.
 */
export function toolLine(draft: ActivityDraft | null, worktree: string): LogLine | null {
  if (draft === null) return null
  if (draft.type === 'tool-started') {
    const name = shortTool(draft.tool)
    // run_command / run_check / git_commit report their own outcome line.
    if (name === 'run_command' || name === 'run_check' || name === 'git_commit' || name === 'report_blocked') return null
    const target = relativize(draft.summary, worktree)
    return { text: target ? `${name} ${target}` : name }
  }
  if (draft.type === 'tool-finished' && draft.denied) return { text: `${shortTool(draft.tool)} denied`, tone: 'denied' }
  return null
}

/** Grep/Glob: the pattern and, when it is not the whole worktree, the folder searched. Null for other tools. */
export function searchLine(input: unknown, worktree: string): string | null {
  if (typeof input !== 'object' || input === null) return null
  const rec = input as Record<string, unknown>
  const tool = typeof rec['tool_name'] === 'string' ? rec['tool_name'] : ''
  if (tool !== 'Grep' && tool !== 'Glob') return null
  const ti = (typeof rec['tool_input'] === 'object' && rec['tool_input'] !== null ? rec['tool_input'] : {}) as Record<string, unknown>
  const pattern = typeof ti['pattern'] === 'string' ? ti['pattern'].slice(0, 120) : ''
  const where = typeof ti['path'] === 'string' ? relativize(ti['path'], worktree) : ''
  return `${tool}${pattern ? ` ${pattern}` : ''}${where ? ` in ${where}` : ''}`
}

/**
 * Logs a PreToolUse hook call: the started tool, or, when the guard said no, one line with the tool, its target and
 * the guard's reason. Never throws.
 */
export function logToolUse(sink: LogSink | undefined, input: unknown, out: GuardOutput, worktree: string): void {
  if (!sink) return
  try {
    const started = toolLine(mapHookInput(input), worktree)
    const search = searchLine(input, worktree)
    const what = search ?? started?.text ?? null
    if (isDenied(out)) {
      const reason = out.hookSpecificOutput?.permissionDecisionReason
      const tool = toolLine(mapDeniedToolUse(input), worktree)
      if (what === null && tool === null) return
      const why = typeof reason === 'string' && reason.trim() !== '' ? `: ${relativize(reason, worktree)}` : ''
      sink({ text: `${what ?? tool?.text ?? 'tool'} denied${why}`, tone: 'denied' })
      return
    }
    if (what !== null) sink(started && search === null ? started : { text: what })
  } catch {
    // tracking must never break a run
  }
}
