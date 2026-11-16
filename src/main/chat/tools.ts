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
const AGENT_INPUT_KEYS: ReadonlySet<string> = new Set([
  'description',
  'prompt',
  'subagent_type',
  'model',
  'name',
  'resume'
])

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

const MAX_EXPANSIONS = 64
const MAX_EXPANSION_LENGTH = 512

/**
 * Expands `{a,b}` alternatives (nesting and empty alternatives supported, no ranges). Returns null when the
 * braces are unbalanced or the result exceeds the caps, so callers deny the pattern.
 */
export function expandBraces(pattern: string): string[] | null {
  if (pattern.length > MAX_EXPANSION_LENGTH) return null
  const results: string[] = []
  const stack: string[] = [pattern]
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (current.length > MAX_EXPANSION_LENGTH) return null
    const open = current.indexOf('{')
    if (open === -1) {
      if (current.includes('}')) return null
      results.push(current)
      if (results.length > MAX_EXPANSIONS) return null
      continue
    }
    if (current.slice(0, open).includes('}')) return null
    let depth = 0
    let close = -1
    const alts: string[] = []
    let start = open + 1
    for (let i = open; i < current.length; i++) {
      const ch = current[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          close = i
          alts.push(current.slice(start, i))
          break
        }
      } else if (ch === ',' && depth === 1) {
        alts.push(current.slice(start, i))
        start = i + 1
      }
    }
    if (close === -1) return null
    const before = current.slice(0, open)
    const after = current.slice(close + 1)
    for (const alt of alts) stack.push(before + alt + after)
    if (stack.length + results.length > MAX_EXPANSIONS * 2) return null
  }
  return results
}

/** Lexical checks for one expanded pattern; never touches the filesystem. */
function expansionLexicallyOk(pattern: string): boolean {
  if (pattern.includes('\0') || pattern.startsWith('~')) return false
  if (pattern.split(/[\\/]+/).includes('..')) return false
  if (/^[a-zA-Z]:(?![\\/])/.test(pattern)) return false
  if (UNC_LIKE.test(pattern)) return false
  return true
}

function patternInside(cwd: string, base: string, pattern: string): boolean {
  const expansions = expandBraces(pattern)
  if (expansions === null) return false
  // Lexical pass over every expansion first, so a denial never costs a filesystem access.
  if (!expansions.every(expansionLexicallyOk)) return false
  return expansions.every((expanded) => {
    const prefix = literalPrefix(expanded)
    if (path.isAbsolute(expanded)) return pathInside(cwd, prefix.length > 0 ? prefix : path.sep)
    // Relative: the literal prefix must stay inside cwd after resolving links and junctions.
    return pathInside(cwd, base, prefix)
  })
}

function checkPathTool(name: string, input: Record<string, unknown>, cwd: string): string | null {
  const toolInput = input['tool_input']
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) {
    return 'Malformed tool request.'
  }
  const args = toolInput as Record<string, unknown>
  const outside = `Tool "${name}" may only access files inside the project folder. Use relative paths and globs without "..", absolute or "~" paths, and with at most 64 brace alternatives.`
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
    if (typeof (toolInput as Record<string, unknown>)[key] !== 'string') {
      return `Tool "${name}" input "${key}" must be a string.`
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
