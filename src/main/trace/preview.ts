import path from 'node:path'
import {
  TRACE_HEAD_LINES,
  TRACE_INPUT_MAX,
  TRACE_SUMMARY_MAX,
  TRACE_TAIL_LINES,
  TRACE_TEXT_MAX
} from '../../shared/trace'

/** Pure helpers that turn tool inputs and outputs into short, secret-free previews. */

const SECRET_MIN = 6

/** Header values, bearer tokens, well-known key shapes and `key=value` pairs whose name says secret. */
const PATTERNS: readonly [RegExp, string][] = [
  [/(authorization\s*["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;]+/gi, '$1***'],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  [/\b(?:sk-[A-Za-z0-9_-]{10,}|sk_(?:live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|lin_(?:api|oauth)_[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{30,})\b/g, '***'],
  [
    /\b((?:[A-Za-z_-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret))["']?\s*[:=]\s*["']?)(?!\*\*\*)[^\s"',;&]{3,}/gi,
    '$1***'
  ]
]

/** Hides known secret values and anything that looks like a credential. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const s of secrets) {
    if (s.length < SECRET_MIN) continue
    out = out.split(s).join('***')
  }
  for (const [re, to] of PATTERNS) out = out.replace(re, to)
  return out
}

/** Cuts to `max` UTF-16 units without leaving a lone high surrogate. */
export function cut(s: string, max: number): string {
  if (s.length <= max) return s
  const code = s.charCodeAt(max - 1)
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}

/** First `head` and last `tail` lines, capped at `max` characters, with a marker for what was left out. */
export function previewText(
  text: string,
  opts: { head?: number; tail?: number; max?: number } = {}
): string {
  const head = opts.head ?? TRACE_HEAD_LINES
  const tail = opts.tail ?? TRACE_TAIL_LINES
  const max = opts.max ?? TRACE_TEXT_MAX
  const normal = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  const lines = normal.split('\n')
  let out = normal
  if (lines.length > head + tail) {
    const hidden = lines.length - head - tail
    out = [...lines.slice(0, head), `… ${hidden} lines hidden …`, ...(tail > 0 ? lines.slice(-tail) : [])].join('\n')
  }
  if (out.length > max) {
    const hidden = out.length - max
    out = `${cut(out, max)}\n… ${hidden} characters hidden …`
  }
  return out
}

/** One line, capped. */
export function oneLine(text: string, max: number = TRACE_SUMMARY_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${cut(t, max - 1)}…` : t
}

/** Paths inside `cwd` are shown relative, with forward slashes. */
export function relativize(text: string, cwd: string | null): string {
  if (!cwd || cwd.length < 3) return text
  const variants = new Set([cwd, cwd.replace(/\\/g, '/'), path.resolve(cwd)])
  let out = text
  for (const v of variants) {
    if (v.length < 3) continue
    const re = new RegExp(`${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]?`, 'gi')
    // "<cwd>/src/a.ts" -> "src/a.ts"; the folder itself -> "."
    out = out.replace(re, (m: string) => (m.endsWith('/') || m.endsWith('\\') ? '' : '.'))
  }
  return out
}

/** Short tool name: `mcp__work__run_command` -> `run_command`. */
export function shortTool(tool: string): string {
  const i = tool.lastIndexOf('__')
  return tool.startsWith('mcp__') && i > 4 ? tool.slice(i + 2) : tool
}

type Rec = Record<string, unknown>
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

const SUMMARY_KEYS = ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'prompt', 'skill', 'name']

/** The one-line target of a tool call, like the CLI shows it: `Read src/app.ts`, `Bash npm test`. */
export function summarizeInput(tool: string, input: unknown): string {
  if (!isRecord(input)) return ''
  const name = shortTool(tool)
  if (name === 'Grep' || name === 'Glob') {
    const pattern = str(input['pattern']) ?? ''
    const where = str(input['path'])
    return `${pattern}${where ? ` in ${where}` : ''}`
  }
  if (tool === 'Agent' || tool === 'Task') {
    const type = str(input['subagent_type']) ?? 'subagent'
    const what = str(input['description'])
    return what ? `${type}: ${what}` : type
  }
  for (const key of SUMMARY_KEYS) {
    const v = str(input[key])
    if (v !== null) return v
  }
  for (const v of Object.values(input)) {
    const s = str(v)
    if (s !== null) return s
  }
  return ''
}

/** The input as readable text: the command for shells, the prompt for agents, otherwise key: value lines. */
export function formatInput(tool: string, input: unknown): string {
  if (!isRecord(input)) return typeof input === 'string' ? input : ''
  const name = shortTool(tool)
  if ((name === 'Bash' || name === 'run_command' || name === 'run_check') && str(input['command'])) {
    const cmd = String(input['command'])
    const args = Array.isArray(input['args']) ? ` ${input['args'].filter((a) => typeof a === 'string').join(' ')}` : ''
    return `${cmd}${args}`
  }
  if ((tool === 'Agent' || tool === 'Task') && str(input['prompt'])) return String(input['prompt'])
  const skip = new Set(['old_string', 'new_string', 'content', 'edits'])
  const lines: string[] = []
  for (const [k, v] of Object.entries(input)) {
    if (skip.has(k)) continue
    const value = typeof v === 'string' ? v : JSON.stringify(v)
    lines.push(`${k}: ${value}`)
  }
  return lines.join('\n')
}

export interface DiffPreview {
  diff: string
  added: number
  removed: number
}

const lineCount = (s: string): number => (s === '' ? 0 : s.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').length)
const prefix = (s: string, mark: string): string =>
  s === '' ? '' : s.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((l) => `${mark} ${l}`).join('\n')

/** A diff preview for Edit, MultiEdit and Write; null for other tools. */
export function diffFor(tool: string, input: unknown): DiffPreview | null {
  if (!isRecord(input)) return null
  const pairs: { from: string; to: string }[] = []
  if (tool === 'Edit' && typeof input['old_string'] === 'string' && typeof input['new_string'] === 'string') {
    pairs.push({ from: input['old_string'], to: input['new_string'] })
  } else if (tool === 'MultiEdit' && Array.isArray(input['edits'])) {
    for (const e of input['edits']) {
      if (isRecord(e) && typeof e['old_string'] === 'string' && typeof e['new_string'] === 'string') {
        pairs.push({ from: e['old_string'], to: e['new_string'] })
      }
    }
  } else if (tool === 'Write' && typeof input['content'] === 'string') {
    pairs.push({ from: '', to: input['content'] })
  } else {
    return null
  }
  let added = 0
  let removed = 0
  const parts: string[] = []
  for (const p of pairs) {
    removed += lineCount(p.from)
    added += lineCount(p.to)
    parts.push([prefix(p.from, '-'), prefix(p.to, '+')].filter(Boolean).join('\n'))
  }
  return { diff: parts.join('\n…\n'), added, removed }
}

/** Text of a tool_result `content`: a string or an array of text blocks (images are named, not kept). */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text'])
    else if (block['type'] === 'image') parts.push('[image]')
  }
  return parts.join('\n')
}

/** Input text for a tool event: formatted, paths relative, secrets hidden, capped. */
export function inputPreview(tool: string, input: unknown, cwd: string | null, secrets: readonly string[]): string {
  return previewText(redact(relativize(formatInput(tool, input), cwd), secrets), { max: TRACE_INPUT_MAX, head: 30, tail: 5 })
}
