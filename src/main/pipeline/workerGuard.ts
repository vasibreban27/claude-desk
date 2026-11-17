/**
 * Deny-by-default PreToolUse policy for pipeline workers. Stricter than the chat guard and built on it:
 * `Read`/`Grep`/`Glob` and the read-only git tools follow the Phase 3 rules (cwd = the worktree);
 * `Write`/`Edit` only reach files covered by the task's `Owns`, inside the worktree, through no link, with
 * no other hard link and never under `.git`. The `work` MCP tools are allowed (they validate their own input).
 * Everything else (Bash, PowerShell, Agent, Task, Skill, unknown MCP tools) is denied. Never throws.
 * This guard is the boundary; the SDK `tools` list is only a second layer.
 */
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_PROTECTED_PATHS } from '../../shared/settings'
import { createProtectedMatcher } from '../chat/protectedPaths'
import { GIT_ALLOWED_TOOLS } from '../chat/gitTools'
import { guardPreToolUse, type GuardOutput } from '../chat/tools'
import { ownsCovers } from './planParser'
import { WORK_ALLOWED_TOOLS } from './workerTools'

export interface WorkerGuardContext {
  /** The task's worktree (also the cwd of the session). */
  worktree: string
  owns: readonly string[]
  protectedPatterns: readonly string[]
}

const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob'])
const WRITE_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  Write: new Set(['file_path', 'content']),
  Edit: new Set(['file_path', 'old_string', 'new_string', 'replace_all'])
}
const GIT_SET: ReadonlySet<string> = new Set(GIT_ALLOWED_TOOLS)
const WORK_SET: ReadonlySet<string> = new Set(WORK_ALLOWED_TOOLS)
const MAX_PATH_LENGTH = 4096

function deny(reason: string): GuardOutput {
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason }
  }
}

const isWin = (): boolean => process.platform === 'win32'
const fold = (s: string): string => (isWin() ? s.toLowerCase() : s)

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Lexical rejects that need no filesystem access. Returns a reason or null. */
function lexicalDenial(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_PATH_LENGTH) return 'invalid path length'
  if (raw.includes('\0')) return 'path contains NUL'
  if (/^[\\/]{2}/.test(raw)) return 'UNC and device paths are not allowed'
  if (isWin()) {
    const rest = /^[a-zA-Z]:/.test(raw) ? raw.slice(2) : raw
    if (rest.includes(':')) return 'alternate data streams are not allowed'
    if (raw.split(/[\\/]+/).some((s) => s !== '.' && s !== '..' && (s.endsWith('.') || s.endsWith(' ')))) {
      return 'path segments must not end with "." or a space'
    }
  }
  if (raw.split(/[\\/]+/).includes('..')) return 'path must not contain ".."'
  return null
}

function checkWrite(name: string, rawInput: unknown, ctx: WorkerGuardContext): string | null {
  if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) return 'Malformed tool request.'
  const args = { ...(rawInput as Record<string, unknown>) }
  const allowedKeys = WRITE_KEYS[name] as ReadonlySet<string>
  for (const key of Object.keys(args)) {
    if (!allowedKeys.has(key)) return `Tool "${name}" input "${key}" is not allowed.`
  }
  const filePath = args['file_path']
  if (typeof filePath !== 'string') return 'Malformed tool request.'
  const lexical = lexicalDenial(filePath)
  if (lexical !== null) return `Tool "${name}": ${lexical}.`

  const lexicalRoot = path.resolve(ctx.worktree)
  let realRoot: string
  try {
    realRoot = realpathSync.native(lexicalRoot)
  } catch {
    return 'The worktree could not be resolved.'
  }
  const target = path.resolve(lexicalRoot, filePath)
  let base: string
  if (isInside(lexicalRoot, target)) base = lexicalRoot
  else if (isInside(realRoot, target)) base = realRoot
  else return `Tool "${name}" may only write inside the task's worktree.`
  const rel = path.relative(base, target)
  if (rel === '') return `Tool "${name}" needs a file path.`
  const segments = rel.split(path.sep)
  if (segments.some((s) => fold(s) === '.git')) return `Tool "${name}" may not touch .git.`

  // Walk down from the real root: any link or junction on the way (or as the file itself) is denied.
  let current = realRoot
  for (const segment of segments) {
    const next = path.join(current, segment)
    let stats: ReturnType<typeof lstatSync>
    try {
      stats = lstatSync(next)
    } catch (e) {
      // The rest does not exist yet; a missing component cannot be a link.
      if (isMissing(e)) break
      throw e
    }
    if (stats.isSymbolicLink()) return `Tool "${name}" may not write through a link or junction.`
    current = next
    if (next === path.join(realRoot, ...segments)) {
      if (!stats.isFile()) return `Tool "${name}" may only write regular files.`
      if (stats.nlink !== 1) return `Tool "${name}" may not write a file with other hard links.`
    }
  }
  // An alias (8.3 short name, case on a case-insensitive volume) must resolve to the same name it was written with.
  const existing = existingPrefix(realRoot, segments)
  if (existing !== realRoot) {
    try {
      const canonical = realpathSync.native(existing)
      if (fold(canonical) !== fold(existing)) return `Tool "${name}" path is not in canonical form.`
    } catch (e) {
      if (!isMissing(e)) throw e
    }
  }

  const relPosix = segments.join('/')
  if (!ownsCovers(ctx.owns, relPosix)) return `Tool "${name}" may only write files covered by the task's Owns.`

  let matcher = createProtectedMatcher(ctx.protectedPatterns, { realRoot })
  if (!matcher.usable) matcher = createProtectedMatcher(DEFAULT_PROTECTED_PATHS, { realRoot })
  if (matcher.isProtected(path.join(realRoot, ...segments))) {
    return 'This path is protected by the project settings and cannot be accessed.'
  }
  return null
}

/** The longest prefix of `segments` below `root` that exists (by lstat). */
function existingPrefix(root: string, segments: string[]): string {
  let current = root
  for (const segment of segments) {
    const next = path.join(current, segment)
    try {
      lstatSync(next)
    } catch {
      return current
    }
    current = next
  }
  return current
}

export function guardWorkerToolUse(input: unknown, ctx: WorkerGuardContext): GuardOutput {
  try {
    if (typeof input !== 'object' || input === null) return deny('Malformed tool request.')
    const name = (input as Record<string, unknown>)['tool_name']
    if (typeof name !== 'string' || name.length === 0) return deny('Malformed tool request.')
    if (
      typeof ctx !== 'object' ||
      ctx === null ||
      typeof ctx.worktree !== 'string' ||
      ctx.worktree.length === 0 ||
      !Array.isArray(ctx.owns) ||
      !Array.isArray(ctx.protectedPatterns)
    ) {
      return deny('Malformed worker policy.')
    }
    if (WORK_SET.has(name)) return {}
    if (READ_TOOLS.has(name) || GIT_SET.has(name)) {
      return guardPreToolUse(input, ctx.worktree, {
        protectedPatterns: ctx.protectedPatterns,
        allowGitRead: true,
        allowPlanWrites: false
      })
    }
    if (name === 'Write' || name === 'Edit') {
      const reason = checkWrite(name, (input as Record<string, unknown>)['tool_input'], ctx)
      return reason === null ? {} : deny(reason)
    }
    return deny(`Tool "${name}" is not allowed for pipeline workers.`)
  } catch {
    return deny('Tool request could not be checked.')
  }
}
