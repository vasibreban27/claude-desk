import type { TraceBody, TraceRole } from '../../shared/trace'
import { TRACE_SUMMARY_MAX } from '../../shared/trace'
import { diffFor, inputPreview, oneLine, previewText, redact, relativize, resultText, summarizeInput } from './preview'

/**
 * Maps one agent session's SDK messages to Activity events. Everything that leaves here is a preview:
 * paths relative to the session folder, secrets hidden, long text cut. Never throws.
 */

/** Where a session belongs; the hub adds project, run, seq and time. */
export interface TraceSessionMeta {
  projectId: string
  runId: string
  taskId: string | null
  role: TraceRole
  /** Label shown for the session, e.g. "worker", "fix round 1", "reviewer security-auditor". */
  session: string
  /** "main", or the worker / reviewer name. */
  agent: string
  /** Folder of the session; paths inside it are shown relative. */
  cwd: string | null
}

/** One event before the hub stamps it. */
export type TraceDraft = {
  taskId: string | null
  role: TraceRole
  session: string
  agent: string
  parentId: string | null
} & TraceBody

/** What a runner feeds: every SDK message, plus the guard's denials (a denied tool never runs). */
export interface TraceSink {
  message(message: unknown): void
  denied(toolUseId: string, reason: string | null): void
}

type Rec = Record<string, unknown>
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const ID_MAX = 100
const id = (v: unknown): string | null => {
  const s = str(v)
  return s === null ? null : s.slice(0, ID_MAX)
}
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])
const SUBAGENT_TYPE_RE = /^[\w:.-]{1,100}$/

export function createSessionRecorder(
  meta: TraceSessionMeta,
  write: (draft: TraceDraft) => void,
  opts: { secrets?: () => readonly string[]; now?: () => number } = {}
): TraceSink {
  const now = opts.now ?? Date.now
  const secrets = (): readonly string[] => {
    try {
      return opts.secrets?.() ?? []
    } catch {
      return []
    }
  }
  /** Agent/Task toolUseId -> subagent type, for naming nested events. */
  const subagents = new Map<string, string>()
  const started = new Map<string, number>()
  const seenTools = new Set<string>()
  const seenResults = new Set<string>()
  const deniedReasons = new Map<string, string | null>()

  const clean = (text: string): string => redact(relativize(text, meta.cwd), secrets())
  const base = (parentId: string | null) => ({
    taskId: meta.taskId,
    role: meta.role,
    session: meta.session,
    agent: parentId !== null ? (subagents.get(parentId) ?? 'subagent') : meta.agent,
    parentId
  })
  const emit = (draft: TraceDraft): void => {
    try {
      write(draft)
    } catch {
      // tracking never breaks a session
    }
  }

  const onAssistant = (message: Rec): void => {
    const inner = message['message']
    if (!isRecord(inner) || !Array.isArray(inner['content'])) return
    const parentId = id(message['parent_tool_use_id'])
    for (const block of inner['content']) {
      if (!isRecord(block)) continue
      if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim() !== '') {
        emit({ ...base(parentId), kind: 'text', text: previewText(clean(block['text'])) })
      } else if (block['type'] === 'tool_use') {
        const toolUseId = id(block['id'])
        const tool = str(block['name'])
        if (toolUseId === null || tool === null || seenTools.has(toolUseId)) continue
        seenTools.add(toolUseId)
        started.set(toolUseId, now())
        const input = block['input']
        if (SUBAGENT_TOOLS.has(tool) && isRecord(input)) {
          const t = input['subagent_type']
          subagents.set(toolUseId, typeof t === 'string' && SUBAGENT_TYPE_RE.test(t) ? t : 'subagent')
        }
        const d = diffFor(tool, input)
        emit({
          ...base(parentId),
          kind: 'tool',
          toolUseId,
          tool: tool.slice(0, 200),
          summary: oneLine(clean(summarizeInput(tool, input)), TRACE_SUMMARY_MAX),
          input: inputPreview(tool, input, meta.cwd, secrets()),
          diff: d ? previewText(clean(d.diff)) : null,
          added: d?.added ?? 0,
          removed: d?.removed ?? 0
        })
      }
    }
  }

  const result = (parentId: string | null, toolUseId: string, ok: boolean, output: string): void => {
    if (seenResults.has(toolUseId)) return
    seenResults.add(toolUseId)
    const t0 = started.get(toolUseId)
    const denied = deniedReasons.has(toolUseId)
    const reason = deniedReasons.get(toolUseId) ?? null
    const text = output.trim() === '' && reason !== null ? reason : output
    emit({
      ...base(parentId),
      kind: 'result',
      toolUseId,
      ok: ok && !denied,
      denied,
      output: previewText(clean(text)),
      durationMs: t0 === undefined ? null : Math.max(0, Math.round(now() - t0))
    })
  }

  const onUser = (message: Rec): void => {
    const inner = message['message']
    if (!isRecord(inner) || !Array.isArray(inner['content'])) return
    const parentId = id(message['parent_tool_use_id'])
    for (const block of inner['content']) {
      if (!isRecord(block) || block['type'] !== 'tool_result') continue
      const toolUseId = id(block['tool_use_id'])
      if (toolUseId === null) continue
      result(parentId, toolUseId, block['is_error'] !== true, resultText(block['content']))
    }
  }

  const onResult = (message: Rec): void => {
    const usage = isRecord(message['usage']) ? message['usage'] : {}
    const cost = message['total_cost_usd']
    const dur = message['duration_ms']
    const turns = message['num_turns']
    emit({
      ...base(null),
      kind: 'turn',
      ok: message['is_error'] !== true,
      turns: typeof turns === 'number' && Number.isInteger(turns) && turns >= 0 ? turns : null,
      durationMs: typeof dur === 'number' && Number.isFinite(dur) && dur >= 0 ? Math.round(dur) : null,
      inputTokens: Math.round(num(usage['input_tokens'])),
      outputTokens: Math.round(num(usage['output_tokens'])),
      cacheTokens: Math.round(num(usage['cache_read_input_tokens']) + num(usage['cache_creation_input_tokens'])),
      costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null
    })
  }

  return {
    message(message) {
      try {
        if (!isRecord(message)) return
        const type = message['type']
        if (type === 'assistant') onAssistant(message)
        else if (type === 'user') onUser(message)
        else if (type === 'result') onResult(message)
      } catch {
        // tracking never breaks a session
      }
    },
    denied(toolUseId, reason) {
      try {
        const key = toolUseId.slice(0, ID_MAX)
        deniedReasons.set(key, reason === null ? null : clean(reason))
      } catch {
        // tracking never breaks a session
      }
    }
  }
}

/** Tells the Activity recorder which tool call the guard refused, and why. Never throws. */
export function reportDenied(
  onDenied: ((toolUseId: string, reason: string | null) => void) | undefined,
  input: unknown,
  output: { hookSpecificOutput?: { permissionDecisionReason?: unknown } }
): void {
  if (!onDenied || typeof input !== 'object' || input === null) return
  try {
    const id = (input as Rec)['tool_use_id']
    if (typeof id !== 'string' || id === '') return
    const reason = output.hookSpecificOutput?.permissionDecisionReason
    onDenied(id, typeof reason === 'string' && reason.trim() !== '' ? reason : null)
  } catch {
    // tracking never breaks the run
  }
}
