/** Tool allowlist and the deny-by-default PreToolUse guard for chat runs (Phase 2: read-only). */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
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

/**
 * Characters that start glob syntax for the Glob tool's base directory: it cuts an absolute pattern at the first
 * `*`, `?`, `[` or `{`. `(`, `)`, `!` and `]` are NOT in this set: they are literal (Next.js route groups like
 * `app/(group)/`), so cutting the prefix there would leave the directories after them unchecked (S71, S72).
 * `}` is not needed either: an unmatched one is denied by `expandBraces`. Walking a longer prefix is always safe.
 */
const MAGIC = /[*?[{]/

/** The literal directory prefix: text before the segment that holds the first magic character. */
function literalPrefix(pattern: string): string {
  const idx = pattern.search(MAGIC)
  if (idx === -1) return pattern
  const head = pattern.slice(0, idx)
  const cut = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'))
  return cut === -1 ? '' : head.slice(0, cut + 1)
}

const MAX_EXPANSIONS = 128
const MAX_EXPANSION_LENGTH = 512

/**
 * True when a `[` appears inside a brace group: ripgrep's globset and our splitter parse character classes
 * inside braces differently, so such patterns are denied (defense in depth).
 */
function bracketInsideBraces(pattern: string): boolean {
  let depth = 0
  for (const ch of pattern) {
    if (ch === '{') depth++
    else if (ch === '}') depth = Math.max(0, depth - 1)
    else if (ch === '[' && depth > 0) return true
  }
  return false
}

/**
 * Expands `{a,b}` alternatives (nesting and empty alternatives supported, no ranges). Returns null when the
 * braces are unbalanced or the result exceeds the caps, so callers deny the pattern.
 */
export function expandBraces(pattern: string): string[] | null {
  // The length cap only applies to brace patterns; brace-free patterns behave as before braces were handled.
  const braced = pattern.includes('{')
  if (braced && pattern.length > MAX_EXPANSION_LENGTH) return null
  if (braced && bracketInsideBraces(pattern)) return null
  const results: string[] = []
  const stack: string[] = [pattern]
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (braced && current.length > MAX_EXPANSION_LENGTH) return null
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

/**
 * S70: on win32 a segment ending in "." or a space is normalized away by the OS and by ripgrep but makes
 * `lstat` report ENOENT, so the guard would treat a junction named `x.` as missing. Denied lexically.
 */
function hasWinTrailingDotOrSpace(p: string): boolean {
  const win = process.platform === 'win32'
  return p.split(/[\\/]+/).some((s) => {
    // S73: the Grep/Glob tools `trim()` their path (any whitespace or U+FEFF), so `" C:\Windows"`, `"..\t"` or
    // `"\t\\\\host\\share"` would be resolved by the tool differently from the guard. Denied on every platform.
    if (/^[\s\uFEFF]|[\s\uFEFF]$/.test(s)) return true
    return win && s !== '.' && s !== '..' && s.endsWith('.')
  })
}

/**
 * S74: on win32 the tools map a leading `/x/` or `/cygdrive/x/` to the drive `X:\`, which the guard would resolve
 * against the cwd's drive instead. A rooted path without a drive letter is never a project-relative path: denied.
 */
function isWinRootRelative(p: string): boolean {
  return process.platform === 'win32' && /^[\\/]/.test(p)
}

/** Lexical checks for one expanded pattern; never touches the filesystem. */
function expansionLexicallyOk(pattern: string): boolean {
  if (pattern.includes('\0') || pattern.startsWith('~')) return false
  // F12: on POSIX a backslash escapes the next character, so `\.\./x` would hide a ".." segment from the split below.
  if (process.platform !== 'win32' && pattern.includes('\\')) return false
  // Only the literal prefix names real directories (and a fully literal pattern names the file itself).
  if (hasWinTrailingDotOrSpace(literalPrefix(pattern)) || isWinRootRelative(pattern)) return false
  if (pattern.split(/[\\/]+/).includes('..')) return false
  if (/^[a-zA-Z]:(?![\\/])/.test(pattern)) return false
  if (UNC_LIKE.test(pattern)) return false
  return true
}

/** Hard lexical caps for path arguments and glob expansions, checked before any filesystem access. */
const MAX_PATH_LENGTH = 4096
const MAX_PATH_SEGMENTS = 64

const segmentCount = (p: string): number => p.split(/[\\/]+/).filter((s) => s.length > 0).length

/** Per guard call state: the real cwd is resolved once and filesystem probes are memoized and capped. */
interface ProbeCtx {
  cwd: string
  realCwd: string | null
  probes: number
  /** Per path: the real path of an existing component, or null when it does not exist (or dangles inside). */
  cache: Map<string, string | null>
}

/**
 * S61: links are resolved with `realpathSync.native` (one OS call for the whole chain). The JS `realpathSync`
 * follows every hop in userland: a 60-hop junction chain cost ~130 ms per probe against ~3 ms native.
 * Checked on win32: junction chains, case and 8.3 short names resolve consistently; `realCwd` uses the same
 * function, so containment compares like with like (this also fixes F42: 8.3 and long forms now agree).
 */
/** F40: sized so the documented 128 brace expansions of a typical monorepo glob fit (`{16}/{8}/src/**` costs 272). */
const MAX_PROBES = 512

class ProbeBudgetError extends Error {}

const cacheKey = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

function spend(ctx: ProbeCtx): void {
  if (++ctx.probes > MAX_PROBES) throw new ProbeBudgetError()
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function resolveRealCwd(ctx: ProbeCtx): string {
  if (ctx.realCwd !== null) return ctx.realCwd
  spend(ctx)
  try {
    ctx.realCwd = realpathSync.native(path.resolve(ctx.cwd))
  } catch (error) {
    if (!isMissingError(error)) throw error
    ctx.realCwd = path.resolve(ctx.cwd)
  }
  return ctx.realCwd
}

/**
 * Resolves one component below an already-real directory with a single lstat (links cost one more
 * realpath). Returns its real path, or null when it is missing. A dangling link is allowed only while its
 * literal target stays inside the real cwd. Results are memoized; only cache misses spend the budget.
 */
function probeComponent(ctx: ProbeCtx, realCwd: string, next: string): string | null {
  const key = cacheKey(next)
  const hit = ctx.cache.get(key)
  if (hit !== undefined) return hit
  spend(ctx)
  let stats: ReturnType<typeof lstatSync>
  try {
    stats = lstatSync(next)
  } catch (error) {
    if (!isMissingError(error)) throw error
    ctx.cache.set(key, null)
    return null
  }
  let result: string | null = next
  if (stats.isSymbolicLink()) {
    spend(ctx)
    try {
      result = realpathSync.native(next)
    } catch (error) {
      if (!isMissingError(error)) throw error
      spend(ctx)
      const target = path.resolve(path.dirname(next), readlinkSync(next))
      // Dangling: harmless only if its literal target is inside the project; otherwise report it as outside.
      result = isInside(realCwd, target) || isInside(path.resolve(ctx.cwd), target) ? null : target
    }
  }
  ctx.cache.set(key, result)
  return result
}

/**
 * True when `resolved` stays inside the real cwd. The target is walked from the real cwd downward and stops
 * at the first missing component (the rest cannot leave cwd), so the work is bounded by the existing
 * components. Targets lexically inside neither the cwd nor its real path are outside without any probe.
 */
function targetInside(ctx: ProbeCtx, raw: string, resolved: string): boolean {
  const base = targetBase(ctx, raw, resolved)
  return base !== null && walkDown(ctx, base, resolved)
}

/** Lexical phase: the directory the target is relative to, or null when it is already clearly outside. */
function targetBase(ctx: ProbeCtx, raw: string, resolved: string): string | null {
  if (raw.startsWith('~') || raw.includes(String.fromCharCode(0))) return null
  if (lexicallyOutside(ctx.cwd, raw, resolved)) return null
  const lexicalCwd = path.resolve(ctx.cwd)
  if (isInside(lexicalCwd, resolved)) return lexicalCwd
  // Compare against the real cwd too (cwd reached through a link or a short name), still without walking.
  // F42: the real cwd is the native (long, true-case) form, so a long-form path under an 8.3 cwd is accepted.
  // The reverse (an 8.3 path under a long-form cwd) fails closed: canonicalizing it would need extra probes.
  const realCwd = resolveRealCwd(ctx)
  return isInside(realCwd, resolved) ? realCwd : null
}

function walkDown(ctx: ProbeCtx, base: string, resolved: string): boolean {
  const realCwd = resolveRealCwd(ctx)
  let current = realCwd
  for (const segment of path.relative(base, resolved).split(path.sep)) {
    if (segment === '') continue
    const real = probeComponent(ctx, realCwd, path.join(current, segment))
    if (real === null) return true
    if (!isInside(realCwd, real)) return false
    current = real
  }
  return true
}

const TOO_DEEP = `Path or glob is too long to check safely: use at most ${MAX_PATH_SEGMENTS} path segments and ${MAX_PATH_LENGTH} characters.`
const TOO_COMPLEX = 'Glob pattern is too complex to check safely: use fewer brace alternatives and a shorter literal path prefix.'

/** null when the pattern is acceptable, otherwise the deny reason (`outside` or a complexity reason). */
function patternDenial(ctx: ProbeCtx, base: string, pattern: string, outside: string): string | null {
  // F41: the character cap covers every pattern, brace-free ones included, before any other work.
  if (pattern.length > MAX_PATH_LENGTH) return TOO_DEEP
  const expansions = expandBraces(pattern)
  if (expansions === null) return outside
  // Lexical pass over every expansion first, so a denial never costs a filesystem access.
  if (!expansions.every(expansionLexicallyOk)) return outside
  // Only the literal prefix is walked on disk, so only its segments count (`src/**/*/*/x` is cheap).
  if (expansions.some((e) => segmentCount(literalPrefix(e)) > MAX_PATH_SEGMENTS)) return TOO_DEEP
  const targets = new Map<string, string>()
  for (const expanded of expansions) {
    const prefix = literalPrefix(expanded)
    if (path.isAbsolute(expanded)) {
      const raw = prefix.length > 0 ? prefix : path.sep
      targets.set(path.resolve(ctx.cwd, raw), raw)
    } else {
      // Relative: the literal prefix must stay inside cwd after resolving links and junctions.
      targets.set(path.resolve(ctx.cwd, base, prefix), base)
    }
  }
  try {
    for (const [resolved, raw] of targets) {
      if (!targetInside(ctx, raw, resolved)) return outside
    }
  } catch (error) {
    if (error instanceof ProbeBudgetError) return TOO_COMPLEX
    throw error
  }
  return null
}

/** Path argument check on the shared ProbeCtx: null when allowed, else the deny reason. */
function argDenial(ctx: ProbeCtx, value: string, outside: string): string | null {
  try {
    return targetInside(ctx, value, path.resolve(ctx.cwd, value)) ? null : outside
  } catch (error) {
    if (error instanceof ProbeBudgetError) return TOO_COMPLEX
    throw error
  }
}

function checkPathTool(name: string, input: Record<string, unknown>, cwd: string): string | null {
  const toolInput = input['tool_input']
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) {
    return 'Malformed tool request.'
  }
  const args = toolInput as Record<string, unknown>
  const outside = `Tool "${name}" may only access files inside the project folder. Use relative paths and globs without "..", absolute or "~" paths, with at most ${MAX_EXPANSIONS} brace expansions, no "[" inside braces, and brace patterns of at most ${MAX_EXPANSION_LENGTH} characters.`
  const ctx: ProbeCtx = { cwd, realCwd: null, probes: 0, cache: new Map() }
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
    if (v.length > MAX_PATH_LENGTH || segmentCount(v) > MAX_PATH_SEGMENTS) return TOO_DEEP
    if (hasWinTrailingDotOrSpace(v) || isWinRootRelative(v)) return outside
    const denial = argDenial(ctx, v, outside)
    if (denial !== null) return denial
  }
  const rawBase = args['path']
  const baseDir = typeof rawBase === 'string' && rawBase.length > 0 ? rawBase : '.'
  for (const key of patternKeys) {
    const v = args[key]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string') return 'Malformed tool request.'
    const denial = patternDenial(ctx, baseDir, v, outside)
    if (denial !== null) return denial
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
