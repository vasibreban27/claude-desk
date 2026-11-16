/** Tool allowlist and the deny-by-default PreToolUse guard for chat runs (Phase 2: read-only). */
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

export const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Agent', 'Task', 'Skill'] as const

const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_TOOLS)
/** Read-only tools that touch the filesystem and are pre-approved by `allowedTools`: scoped to the run's cwd. */
const PATH_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob'])

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

/** True when `value` (absolute or relative to cwd) resolves, through symlinks, inside cwd. */
function pathInside(cwd: string, value: string): boolean {
  if (value.startsWith('~')) return false
  if (value.includes('\0')) return false
  const root = realResolve(cwd)
  return isInside(root, realResolve(path.resolve(cwd, value)))
}

const MAGIC = /[*?[\]{}()!]/

function patternInside(cwd: string, pattern: string): boolean {
  if (pattern.includes('\0') || pattern.startsWith('~')) return false
  if (pattern.split(/[\\/]+/).includes('..')) return false
  if (/^[a-zA-Z]:(?![\\/])/.test(pattern)) return false
  if (path.isAbsolute(pattern) || /^[\\/]{2}/.test(pattern)) {
    const idx = pattern.search(MAGIC)
    const prefix = idx === -1 ? pattern : pattern.slice(0, idx)
    return pathInside(cwd, prefix.length > 0 ? prefix : path.sep)
  }
  return true
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
  for (const key of patternKeys) {
    const v = args[key]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string') return 'Malformed tool request.'
    if (!patternInside(cwd, v)) return outside
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
    return {}
  } catch {
    return deny('Tool request could not be checked.')
  }
}

/** True when a guard result denies the call. */
export function isDenied(output: GuardOutput): boolean {
  return output.hookSpecificOutput?.permissionDecision === 'deny'
}
