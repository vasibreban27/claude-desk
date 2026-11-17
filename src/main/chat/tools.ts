/** Tool allowlist and the deny-by-default PreToolUse guard for chat runs (Phase 2: read-only). */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_PROTECTED_PATHS } from '../../shared/settings'
import { GIT_ALLOWED_TOOLS } from './gitTools'
import { createProtectedMatcher, type ProtectedMatcher } from './protectedPaths'

/**
 * Per-turn policy derived from the project settings. Without a policy the guard behaves as in Phase 2 (read-only),
 * with the default protected list applied to path checks.
 */
export interface ToolPolicy {
  /** Gitignore-style patterns; an unusable list falls back to the defaults. */
  protectedPatterns: readonly string[]
  /** Allows the three in-process git tools (and `ToolSearch`, which loads them). */
  allowGitRead: boolean
  /** Allows `Write` for exactly `docs/plans/<slug>.md`. */
  allowPlanWrites: boolean
}

const DEFAULT_POLICY: ToolPolicy = {
  protectedPatterns: DEFAULT_PROTECTED_PATHS,
  allowGitRead: false,
  allowPlanWrites: false
}

/** Null when the policy is malformed (the guard then denies everything). */
function readPolicy(policy: unknown): ToolPolicy | null {
  if (policy === undefined) return DEFAULT_POLICY
  if (typeof policy !== 'object' || policy === null) return null
  const p = policy as Record<string, unknown>
  if (!Array.isArray(p['protectedPatterns']) || !p['protectedPatterns'].every((x) => typeof x === 'string')) return null
  if (typeof p['allowGitRead'] !== 'boolean' || typeof p['allowPlanWrites'] !== 'boolean') return null
  const patterns = p['protectedPatterns'] as string[]
  // An unusable list (invalid entry) must never loosen anything: use the defaults, here and in the matcher.
  const usable = createProtectedMatcher(patterns, { realRoot: path.resolve('.') }).usable
  return {
    protectedPatterns: usable ? patterns : DEFAULT_PROTECTED_PATHS,
    allowGitRead: p['allowGitRead'],
    allowPlanWrites: p['allowPlanWrites']
  }
}

const GIT_TOOL_SET: ReadonlySet<string> = new Set(GIT_ALLOWED_TOOLS)

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
    permissionDecision: 'deny' | 'allow'
    permissionDecisionReason?: string
    /** Set only with `allow`: the tool runs with this input instead of the original (Grep exclusion globs). */
    updatedInput?: Record<string, unknown>
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

/** Deny-by-default: the base read-only set plus only what the policy adds. */
export function isToolAllowed(name: string, policy?: ToolPolicy): boolean {
  if (ALLOWED_SET.has(name)) return true
  if (policy === undefined) return false
  if (policy.allowGitRead && (GIT_TOOL_SET.has(name) || name === 'ToolSearch')) return true
  return policy.allowPlanWrites && name === 'Write'
}

const PROTECTED_MESSAGE = 'This path is protected by the project settings and cannot be accessed.'

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
 * S1: on NTFS `name::$DATA`, `name:$DATA`, `dir::$INDEX_ALLOCATION` and `dir:$I30:$INDEX_ALLOCATION` reach the same
 * file or directory as `name`, but `lstat` reports a plain file and no pattern matches the suffixed name. Any `:`
 * other than the drive colon of an absolute path (`C:\`) is denied lexically on win32 (legal on POSIX, so no rule there).
 */
function hasWinStreamColon(p: string): boolean {
  if (process.platform !== 'win32') return false
  const rest = /^[a-zA-Z]:/.test(p) ? p.slice(2) : p
  return rest.includes(':')
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
  if (hasWinStreamColon(pattern)) return false
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
  patterns: readonly string[]
  /** Built lazily from the real cwd; null until first needed. */
  matcher: ProtectedMatcher | null
}

function newCtx(cwd: string, patterns: readonly string[]): ProbeCtx {
  return { cwd, realCwd: null, probes: 0, cache: new Map(), patterns, matcher: null }
}

/** True when the real path is protected (outside the project counts as protected: fail closed). */
function isProtectedReal(ctx: ProbeCtx, real: string): boolean {
  if (ctx.matcher === null) {
    const realRoot = resolveRealCwd(ctx)
    let matcher = createProtectedMatcher(ctx.patterns, { realRoot })
    if (!matcher.usable) matcher = createProtectedMatcher(DEFAULT_PROTECTED_PATHS, { realRoot })
    ctx.matcher = matcher
  }
  return ctx.matcher.isProtected(real)
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
function targetReal(ctx: ProbeCtx, raw: string, resolved: string): string | null {
  const base = targetBase(ctx, raw, resolved)
  return base === null ? null : walkDown(ctx, base, resolved)
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

/**
 * True when a name written differently could reach the same file: Windows 8.3 short names (`ENV~1` for `.env`;
 * the case difference is handled by the case-insensitive matcher) and case-insensitive macOS volumes.
 */
function mayBeAlias(relative: string): boolean {
  if (process.platform === 'darwin') return true
  return process.platform === 'win32' && relative.includes('~')
}

/**
 * The real path of the target when it stays inside the real cwd, else null. When a name may be an alias the
 * existing prefix is canonicalized with one more native realpath, so it matches the protected patterns by its
 * true name; components below the first missing one are appended as written.
 */
function walkDown(ctx: ProbeCtx, base: string, resolved: string): string | null {
  const realCwd = resolveRealCwd(ctx)
  let current = realCwd
  const rest: string[] = []
  let missing = false
  for (const segment of path.relative(base, resolved).split(path.sep)) {
    if (segment === '') continue
    if (missing) {
      rest.push(segment)
      continue
    }
    const real = probeComponent(ctx, realCwd, path.join(current, segment))
    if (real === null) {
      missing = true
      rest.push(segment)
      continue
    }
    if (!isInside(realCwd, real)) return null
    current = real
  }
  if (current !== realCwd && mayBeAlias(path.relative(realCwd, current))) {
    spend(ctx)
    try {
      current = realpathSync.native(current)
    } catch (error) {
      if (!isMissingError(error)) throw error
    }
    if (!isInside(realCwd, current)) return null
  }
  return rest.length > 0 ? path.join(current, ...rest) : current
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
      const real = targetReal(ctx, raw, resolved)
      if (real === null) return outside
      if (isProtectedReal(ctx, real)) return PROTECTED_MESSAGE
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
    const real = targetReal(ctx, value, path.resolve(ctx.cwd, value))
    if (real === null) return outside
    return isProtectedReal(ctx, real) ? PROTECTED_MESSAGE : null
  } catch (error) {
    if (error instanceof ProbeBudgetError) return TOO_COMPLEX
    throw error
  }
}

function checkPathTool(name: string, input: Record<string, unknown>, ctx: ProbeCtx): string | null {
  const toolInput = input['tool_input']
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) {
    return 'Malformed tool request.'
  }
  const args = toolInput as Record<string, unknown>
  const outside = `Tool "${name}" may only access files inside the project folder. Use relative paths and globs without "..", absolute or "~" paths, with at most ${MAX_EXPANSIONS} brace expansions, no "[" inside braces, and brace patterns of at most ${MAX_EXPANSION_LENGTH} characters.`
  const pathKeys = name === 'Read' ? ['file_path'] : ['path']
  const patternKeys = name === 'Read' ? [] : name === 'Glob' ? ['pattern'] : name === 'Grep' ? ['glob'] : []

  if (name === 'Read' && (typeof args['file_path'] !== 'string' || args['file_path'].length === 0)) {
    return 'Malformed tool request.'
  }
  for (const key of pathKeys) {
    const v = args[key]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string') return 'Malformed tool request.'
    if (v.length === 0) continue
    if (v.length > MAX_PATH_LENGTH || segmentCount(v) > MAX_PATH_SEGMENTS) return TOO_DEEP
    if (hasWinTrailingDotOrSpace(v) || hasWinStreamColon(v) || isWinRootRelative(v)) return outside
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

const GIT_INPUT_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  git_status: new Set(),
  git_log: new Set(['maxCount', 'path']),
  git_diff: new Set(['staged', 'path'])
}

function checkGitTool(name: string, input: Record<string, unknown>, ctx: ProbeCtx): string | null {
  const toolInput = input['tool_input']
  // Absent input is the same as `{}` for the argument-less tools.
  const args = toolInput === undefined ? {} : toolInput
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'Malformed tool request.'
  const allowed = GIT_INPUT_KEYS[name.slice(name.lastIndexOf('__') + 2)]
  if (allowed === undefined) return 'Malformed tool request.'
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) return `Tool "${name}" input "${key}" is not allowed in chat.`
  }
  return checkPathTool(name, { tool_input: args }, ctx)
}

/** Largest `content` a plan write may carry (bytes of UTF-8). */
export const PLAN_CONTENT_CAP = 200_000
const PLAN_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PLAN_RELATIVE = /^docs\/plans\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/

/** The slug when `raw` is exactly an accepted `file_path` string, else null. No normalisation: no filesystem access. */
function planSlug(raw: string, cwd: string): string | null {
  const relative = PLAN_RELATIVE.exec(raw)
  let slug: string | null = relative === null ? null : (relative[1] as string)
  if (slug === null) {
    const prefix = path.join(cwd, 'docs', 'plans') + path.sep
    if (raw.startsWith(prefix) && raw.endsWith('.md')) slug = raw.slice(prefix.length, -'.md'.length)
  }
  return slug !== null && slug.length <= 64 && PLAN_SLUG.test(slug) ? slug : null
}

/** An existing component must be a real directory (no link or junction); 'missing' when it does not exist. */
function dirState(p: string): boolean | 'missing' {
  let stats: ReturnType<typeof lstatSync>
  try {
    stats = lstatSync(p)
  } catch (error) {
    if (isMissingError(error)) return 'missing'
    throw error
  }
  return !stats.isSymbolicLink() && stats.isDirectory()
}

const WIN_DEVICE_SLUG = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

function checkPlanWrite(input: Record<string, unknown>, ctx: ProbeCtx): string | null {
  const toolInput = input['tool_input']
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) return 'Malformed tool request.'
  const args = toolInput as Record<string, unknown>
  const shape = 'Tool "Write" may only create or overwrite docs/plans/<slug>.md (lowercase letters, digits and single hyphens).'
  for (const key of Object.keys(args)) {
    if (key !== 'file_path' && key !== 'content') return `Tool "Write" input "${key}" is not allowed in chat.`
  }
  const filePath = args['file_path']
  const content = args['content']
  if (typeof filePath !== 'string' || typeof content !== 'string') return 'Malformed tool request.'
  if (filePath.length > MAX_PATH_LENGTH) return shape
  if (Buffer.byteLength(content, 'utf8') > PLAN_CONTENT_CAP) {
    return `Tool "Write" content is too large: at most ${PLAN_CONTENT_CAP} bytes.`
  }
  const slug = planSlug(filePath, ctx.cwd)
  if (slug === null) return shape
  // F2: Windows device names (`nul.md` opens the device) are valid slugs but never a plan file.
  if (process.platform === 'win32' && WIN_DEVICE_SLUG.test(slug)) return shape
  // Filesystem phase (only now): Write creates missing parents, so existing ones must be real directories.
  try {
    const realCwd = resolveRealCwd(ctx)
    const docs = path.join(realCwd, 'docs')
    const plans = path.join(docs, 'plans')
    const target = path.join(plans, `${slug}.md`)
    // F3: the protected check sees the canonical name (case-insensitive volumes), like the other path tools.
    const protectedOrNull = (t: string): string | null => {
      const real = walkDown(ctx, realCwd, t)
      return real === null ? shape : isProtectedReal(ctx, real) ? PROTECTED_MESSAGE : null
    }
    const linkMessage = 'Tool "Write": docs and docs/plans must be real folders inside the project, not links.'
    const docsState = dirState(docs)
    if (docsState === false) return linkMessage
    if (docsState === 'missing') return protectedOrNull(target)
    const plansState = dirState(plans)
    if (plansState === false) return linkMessage
    if (plansState === 'missing') return protectedOrNull(target)
    let stats: ReturnType<typeof lstatSync> | null = null
    try {
      stats = lstatSync(target)
    } catch (error) {
      if (!isMissingError(error)) throw error
    }
    if (stats !== null && (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1)) {
      return 'Tool "Write" may only overwrite a regular file that is not a link and has no other hard links.'
    }
    return protectedOrNull(target)
  } catch (error) {
    if (error instanceof ProbeBudgetError) return TOO_COMPLEX
    throw error
  }
}

const isLetter = (ch: string): boolean => ch.toLowerCase() !== ch.toUpperCase()
const swapCase = (ch: string): string => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase())

/** Adds the other case to every letter and same-case letter range of a character class body (`a-z` -> `a-zA-Z`). */
function foldClassBody(body: string): string {
  const chars = [...body]
  let i = 0
  let out = ''
  if (chars[0] === '!' || chars[0] === '^') {
    out += chars[0]
    i = 1
  }
  for (; i < chars.length; i++) {
    const lo = chars[i] as string
    const hi = chars[i + 2]
    if (chars[i + 1] === '-' && hi !== undefined) {
      out += `${lo}-${hi}`
      const sameCase = (lo === lo.toLowerCase()) === (hi === hi.toLowerCase())
      if (isLetter(lo) && isLetter(hi) && sameCase) {
        out += `${swapCase(lo)}-${swapCase(hi)}`
      }
      i += 2
    } else {
      out += lo
      if (isLetter(lo)) out += swapCase(lo)
    }
  }
  return out
}

/** Case-insensitive glob for case-insensitive file systems: letters become `[xX]`, class bodies gain both cases. */
function foldCase(s: string): string {
  let inClass = false
  let body = ''
  let result = ''
  for (const ch of s) {
    if (inClass) {
      if (ch === ']') {
        inClass = false
        result += `[${foldClassBody(body)}]`
      } else {
        body += ch
      }
    } else if (ch === '[') {
      inClass = true
      body = ''
    } else if (isLetter(ch)) {
      result += `[${ch.toLowerCase()}${ch.toUpperCase()}]`
    } else {
      result += ch
    }
  }
  return inClass ? `${result}[${body}` : result
}

/**
 * Converts gitignore `\x` escapes to a ripgrep glob that means the same on every platform (ripgrep does not treat
 * `\` as an escape on win32): `\*`, `\?`, `\[`, `\]` become one-character classes, an escaped whitespace or `\\`
 * becomes `?` (over-excludes), any other `\x` becomes `x` (`\#`, `\!`). A lone trailing `\` is dropped.
 */
function unescapeGitignore(s: string): string {
  let out = ''
  const chars = [...s]
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = chars[++i]
    if (next === undefined) break
    if ('*?[]'.includes(next)) out += `[${next}]`
    else if (next === '\\' || /\s/.test(next)) out += '?'
    else out += next
  }
  return out
}

/**
 * One ripgrep exclusion glob per protected pattern that converts. Skipped (no exclusion): empty patterns, `#`
 * comments (an unescaped leading `#` is a comment in gitignore, so it protects nothing) and `!` re-allow entries
 * (skipping those only excludes more). Escapes such as `\#secret.txt` are converted, never skipped.
 */
export function protectedGrepExclusions(patterns: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = []
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue
    let s = pattern.replace(/[ \t]+$/, '')
    if (s === '' || s.startsWith('!') || s.startsWith('#')) continue
    s = unescapeGitignore(s)
    const dirOnly = s.endsWith('/')
    if (dirOnly) s = s.slice(0, -1)
    // Anchored and nested patterns are excluded at any depth: over-excluding is the safe direction.
    s = s.replace(/^\/+/, '').replace(/\s/g, '?')
    if (s === '') continue
    if (platform === 'win32') s = foldCase(s)
    if (!dirOnly) out.push(`!**/${s}`)
    out.push(`!**/${s}/**`)
  }
  return out
}

function grepRewrite(rec: Record<string, unknown>, patterns: readonly string[]): GuardOutput {
  const exclusions = protectedGrepExclusions(patterns)
  if (exclusions.length === 0) return {}
  const args = rec['tool_input'] as Record<string, unknown>
  const user = typeof args['glob'] === 'string' ? args['glob'].trim() : ''
  const glob = [...(user.length > 0 ? [user] : []), ...exclusions].join(' ')
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...args, glob }
    }
  }
}

/**
 * Fails closed: anything not explicitly allowed, or malformed, is denied. Never throws.
 * Without `policy` the Phase 2 behaviour applies (read-only, default protected list, no input rewriting).
 */
export function guardPreToolUse(input: unknown, cwd: string, policy?: ToolPolicy): GuardOutput {
  try {
    const resolved = readPolicy(policy)
    if (resolved === null) return deny('Malformed tool policy.')
    if (typeof input !== 'object' || input === null) return deny('Malformed tool request.')
    const original = input as Record<string, unknown>
    const name = original['tool_name']
    if (typeof name !== 'string' || name.length === 0) return deny('Malformed tool request.')
    // Snapshot tool_input once (plain own-property copy; a throwing getter lands in the catch and denies). Every
    // check and the rewritten updatedInput use this copy, so check and use cannot diverge.
    const rawInput = original['tool_input']
    const rec: Record<string, unknown> = {
      tool_name: name,
      tool_input:
        typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput)
          ? { ...(rawInput as Record<string, unknown>) }
          : rawInput
    }
    if (!isToolAllowed(name, resolved)) {
      return deny(`Tool "${name}" is not allowed in chat: only read-only tools, agents and skills are.`)
    }
    const needsCwd = PATH_TOOLS.has(name) || GIT_TOOL_SET.has(name) || name === 'Write'
    if (needsCwd && (typeof cwd !== 'string' || cwd.length === 0)) return deny('Malformed tool request.')
    if (PATH_TOOLS.has(name)) {
      const reason = checkPathTool(name, rec, newCtx(cwd, resolved.protectedPatterns))
      if (reason !== null) return deny(reason)
      if (name === 'Grep' && policy !== undefined) return grepRewrite(rec, resolved.protectedPatterns)
    }
    if (GIT_TOOL_SET.has(name)) {
      const reason = checkGitTool(name, rec, newCtx(cwd, resolved.protectedPatterns))
      if (reason !== null) return deny(reason)
    }
    if (name === 'Write') {
      const reason = checkPlanWrite(rec, newCtx(cwd, resolved.protectedPatterns))
      if (reason !== null) return deny(reason)
    }
    if (name === 'ToolSearch') {
      const toolInput = rec['tool_input']
      if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) {
        return deny('Malformed tool request.')
      }
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
