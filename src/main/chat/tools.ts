/** Tool allowlist and the deny-by-default PreToolUse guard for chat runs (Phase 2: read-only). */
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

export const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Agent', 'Task', 'Skill'] as const

const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_TOOLS)
/** Read-only tools that touch the filesystem and are pre-approved by `allowedTools`: scoped to the run's cwd. */
const PATH_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob'])
/** Sub-agent tools: their input is inspected so they cannot escape the read-only sandbox (e.g. `isolation`). */
const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])
/**
 * Conservative allowlist of Agent/Task input keys. Revisit when the SDK adds new Agent input fields:
 * anything not listed here is denied until it has been reviewed.
 */
const AGENT_INPUT_KEYS: ReadonlySet<string> = new Set(['description', 'prompt', 'subagent_type', 'model'])

export interface GuardOutput {
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse'
    permissionDecision: 'deny'
    permissionDecisionReason: string
  }
}

function deny(reason: string): GuardOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }
}

export function isToolAllowed(name: string): boolean {
  return ALLOWED_SET.has(name)
}

/** realpath of the nearest existing ancestor plus the not-yet-existing remainder. */
function realResolve(p: string): string {
  let current = path.resolve(p)
  const rest: string[] = []
  for (;;) {
    if (existsSync(current)) {
      return path.join(realpathSync(current), ...rest.reverse())
    }
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(p)
    rest.push(path.basename(current))
    current = parent
  }
}

/** Trailing-separator-safe containment (path.relative is case-insensitive on win32). */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

const sameRoot = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

const UNC_LIKE = /^[\\/]{2}/

/**
 * Lexical pre-check that never touches the filesystem: UNC, extended-length (`\\?\`) and device (`\\.\`)
 * paths and other drives are denied before any realpath (a UNC target would make the process attempt
 * SMB/NTLM authentication).
 */
function lexicallyOutside(cwd: string, raw: string, resolved: string): boolean {
  if (UNC_LIKE.test(raw) || UNC_LIKE.test(resolved)) return true
  return !sameRoot(path.parse(path.resolve(cwd)).root, path.parse(resolved).root)
}

/** True when the joined path (absolute or relative to cwd) resolves, through symlinks, inside cwd. */
function pathInside(cwd: string, ...parts: string[]): boolean {
  if ((parts[0] ?? '').startsWith('~')) return false
  if (parts.some((p) => p.includes('\0'))) return false
  const resolved = path.resolve(cwd, ...parts)
  if (lexicallyOutside(cwd, parts[0] ?? '', resolved)) return false
  const root = realResolve(cwd)
  return isInside(root, realResolve(resolved))
}

const MAGIC = /[*?[\]{}()!]/

/** The literal directory prefix: text before the segment that holds the first magic character. */
function literalPrefix(pattern: string): string {
  const idx = pattern.search(MAGIC)
  if (idx === -1) return pattern
  const head = pattern.slice(0, idx)
  const cut = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'))
  return cut === -1 ? '' : head.slice(0, cut + 1)
}

function patternInside(cwd: string, base: string, pattern: string): boolean {
  if (pattern.includes('\0') || pattern.startsWith('~')) return false
  // Brace expansion can assemble `..` segments out of pieces; not supported in Phase 2.
  if (/[{}]/.test(pattern)) return false
  if (pattern.split(/[\\/]+/).includes('..')) return false
  if (/^[a-zA-Z]:(?![\\/])/.test(pattern)) return false
  if (UNC_LIKE.test(pattern)) return false
  const prefix = literalPrefix(pattern)
  if (path.isAbsolute(pattern)) return pathInside(cwd, prefix.length > 0 ? prefix : path.sep)
  // Relative: the literal prefix must stay inside cwd after resolving links and junctions.
  return pathInside(cwd, base, prefix)
}

function checkPathTool(name: string, input: Record<string, unknown>, cwd: string): string | null {
  const toolInput = input['tool_input']
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) {
    return 'Malformed tool request.'
  }
  const args = toolInput as Record<string, unknown>
  const outside = `Tool "${name}" may only access files inside the project folder.`
  const pathKeys = name === 'Read' ? ['file_path'] : ['path']
  const patternKeys = name === 'Read' ? [] : name === 'Glob' ? ['pattern'] : ['glob']

  if (name === 'Read' && (typeof args['file_path'] !== 'string' || args['file_path'].length === 0)) {
    return 'Malformed tool request.'
  }
  for (const key of pathKeys) {
    const v = args[key]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string') return 'Malformed tool request.'
    if (v.length === 0) continue
    if (!pathInside(cwd, v)) return outside
  }
  const rawBase = args['path']
  const baseDir = typeof rawBase === 'string' && rawBase.length > 0 ? rawBase : '.'
  for (const key of patternKeys) {
    const v = args[key]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string') return 'Malformed tool request.'
    if (!patternInside(cwd, baseDir, v)) return outside
  }
  return null
}

function checkAgentTool(name: string, input: Record<string, unknown>): string | null {
  const toolInput = input['tool_input']
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) {
    return 'Malformed tool request.'
  }
  for (const key of Object.keys(toolInput)) {
    if (!AGENT_INPUT_KEYS.has(key)) {
      return `Tool "${name}" input "${key}" is not allowed in chat.`
    }
  }
  return null
}

/** Fails closed: anything not explicitly allowed, or malformed, is denied. Never throws. */
export function guardPreToolUse(input: unknown, cwd: string): GuardOutput {
  try {
    if (typeof input !== 'object' || input === null) return deny('Malformed tool request.')
    const rec = input as Record<string, unknown>
    const name = rec['tool_name']
    if (typeof name !== 'string' || name.length === 0) return deny('Malformed tool request.')
    if (!isToolAllowed(name)) {
      return deny(`Tool "${name}" is not allowed in chat: only read-only tools, agents and skills are.`)
    }
    if (PATH_TOOLS.has(name)) {
      if (typeof cwd !== 'string' || cwd.length === 0) return deny('Malformed tool request.')
      const reason = checkPathTool(name, rec, cwd)
      if (reason !== null) return deny(reason)
    }
    if (AGENT_TOOLS.has(name)) {
      const reason = checkAgentTool(name, rec)
      if (reason !== null) return deny(reason)
    }
    return {}
  } catch {
    return deny('Tool request could not be checked.')
  }
}

/** True when a guard result denies the call. */
export function isDenied(output: GuardOutput): boolean {
  return output.hookSpecificOutput?.permissionDecision === 'deny'
}
