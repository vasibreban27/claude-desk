import { execFile as nodeExecFile } from 'node:child_process'
import { posix, win32 } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

// Read-only git tools run in the main process (no Bash). Argv and env come from
// docs/notes/phase-3-spike.md section 4: they were verified against a hostile .git/config.

export const GIT_SERVER_NAME = 'git'
export const GIT_TOOL_NAMES = ['git_status', 'git_log', 'git_diff'] as const
export const GIT_ALLOWED_TOOLS = GIT_TOOL_NAMES.map((n) => `mcp__${GIT_SERVER_NAME}__${n}`)

export const GIT_TIMEOUT_MS = 10_000
export const GIT_OUTPUT_CAP = 200_000
const GIT_MAX_BUFFER = 1024 * 1024
const MAX_FILES = 500
const DEFAULT_LOG_COUNT = 20

const COMMON_PREFIX = [
  '--no-pager',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
  '-c',
  'core.hooksPath=',
  '-c',
  'diff.external=',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'core.quotepath=false'
]

const ENV_ADDITIONS: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_PAGER: 'cat',
  GIT_EXTERNAL_DIFF: '',
  // Not in the spike list: pathspecs built from file names are never magic or globs.
  GIT_LITERAL_PATHSPECS: '1'
}

export interface GitExecOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeout: number
  maxBuffer: number
}

export type GitExec = (file: string, args: string[], options: GitExecOptions) => Promise<{ stdout: string }>

const defaultExec: GitExec = (file, args, options) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, args, { ...options, encoding: 'utf8', windowsHide: true }, (err, stdout) => {
      if (err) {
        Object.assign(err, { stdout })
        reject(err)
        return
      }
      resolve({ stdout })
    })
  })

export interface TextResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

const ok = (text: string): TextResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): TextResult => ({ content: [{ type: 'text', text }], isError: true })

const logSchema = z.object({
  maxCount: z.number().int().min(1).max(100).optional(),
  path: z.string().optional()
})
const diffSchema = z.object({ staged: z.boolean().optional(), path: z.string().optional() })

/** Returns an error message, or null when the path is an acceptable relative pathspec. */
export function validatePathspec(p: string): string | null {
  if (p.length === 0 || p.length > 500) return 'path must be 1..500 characters'
  if (p.includes('\0')) return 'path contains a NUL character'
  if (p.startsWith('-')) return 'path must not start with "-"'
  if (p.startsWith(':')) return 'path must not start with ":"'
  if (posix.isAbsolute(p) || win32.isAbsolute(p) || p.startsWith('\\')) return 'path must be relative'
  if (p.split(/[\\/]/).includes('..')) return 'path must not contain ".."'
  return null
}

export interface GitToolsDeps {
  cwd: string
  /** True when the project-relative path (forward slashes) is protected. */
  isProtected: (relativePath: string) => boolean
  exec?: GitExec
  env?: NodeJS.ProcessEnv
}

export interface GitHandlers {
  git_status: (input: unknown) => Promise<TextResult>
  git_log: (input: unknown) => Promise<TextResult>
  git_diff: (input: unknown) => Promise<TextResult>
}

interface ExecError {
  code?: unknown
  killed?: boolean
  signal?: string | null
  stdout?: unknown
  stderr?: unknown
  message?: string
}

function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= GIT_OUTPUT_CAP) return { text, truncated: false }
  return { text: text.slice(0, GIT_OUTPUT_CAP), truncated: true }
}

export function createGitHandlers(deps: GitToolsDeps): GitHandlers {
  const exec = deps.exec ?? defaultExec
  const env = { ...(deps.env ?? process.env), ...ENV_ADDITIONS }
  const options: GitExecOptions = { cwd: deps.cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }

  type RunResult = { stdout: string; overflow: boolean } | { error: string }

  async function run(subcommand: string[]): Promise<RunResult> {
    try {
      const { stdout } = await exec('git', [...COMMON_PREFIX, ...subcommand], options)
      return { stdout, overflow: false }
    } catch (e) {
      const err = (e ?? {}) as ExecError
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return { stdout: typeof err.stdout === 'string' ? err.stdout : '', overflow: true }
      }
      if (err.killed === true || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
        return { error: 'git timed out' }
      }
      if (err.code === 'ENOENT') return { error: 'git is not installed' }
      const stderr = typeof err.stderr === 'string' ? err.stderr : ''
      if (/not a git repository/i.test(stderr) || /not a git repository/i.test(err.message ?? '')) {
        return { error: 'not a git repo' }
      }
      return { error: `git failed${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}` }
    }
  }

  const finish = (stdout: string, overflow: boolean, empty: string, notes: string[] = []): TextResult => {
    const c = cap(stdout)
    let text = c.text.trim().length === 0 ? empty : c.text
    if (c.truncated || overflow) text += '\n[output truncated]'
    for (const n of notes) text += `\n${n}`
    return ok(text)
  }

  const omitted = (n: number): string =>
    n === 0 ? '' : `${n} protected file${n === 1 ? '' : 's'} omitted`

  const checkPath = (p: string | undefined): string | null => {
    if (p === undefined) return null
    const bad = validatePathspec(p)
    if (bad) return bad
    if (deps.isProtected(p.replace(/\\/g, '/'))) return 'path is protected'
    return null
  }

  const unquote = (p: string): string => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p)

  return {
    async git_status() {
      const r = await run(['status', '--short', '--porcelain=v1', '--untracked-files=normal', '--no-renames'])
      if ('error' in r) return fail(r.error)
      let hidden = 0
      const kept: string[] = []
      for (const line of r.stdout.split('\n')) {
        if (line.length === 0) continue
        if (deps.isProtected(unquote(line.slice(3)))) hidden++
        else kept.push(line)
      }
      return finish(kept.join('\n'), r.overflow, 'Working tree clean.', hidden ? [omitted(hidden)] : [])
    },

    async git_log(input) {
      const parsed = logSchema.safeParse(input ?? {})
      if (!parsed.success) return fail('invalid input: maxCount must be an integer 1..100')
      const bad = checkPath(parsed.data.path)
      if (bad) return fail(bad)
      const args = [
        'log',
        '--no-patch',
        '--no-ext-diff',
        '--no-textconv',
        '--format=%h %ad %an %s',
        '--date=short',
        '-n',
        String(parsed.data.maxCount ?? DEFAULT_LOG_COUNT)
      ]
      if (parsed.data.path !== undefined) args.push('--', parsed.data.path)
      const r = await run(args)
      if ('error' in r) return fail(r.error)
      return finish(r.stdout, r.overflow, 'No commits.')
    },

    async git_diff(input) {
      const parsed = diffSchema.safeParse(input ?? {})
      if (!parsed.success) return fail('invalid input')
      const bad = checkPath(parsed.data.path)
      if (bad) return fail(bad)
      const cached = parsed.data.staged === true ? ['--cached'] : []
      const listArgs = ['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', ...cached]
      if (parsed.data.path !== undefined) listArgs.push('--', parsed.data.path)
      const listed = await run(listArgs)
      if ('error' in listed) return fail(listed.error)
      if (listed.overflow) return fail('too many files')
      const names = listed.stdout.split('\0').filter((n) => n.length > 0)
      const allowed = names.filter((n) => !deps.isProtected(n))
      const hidden = names.length - allowed.length
      if (allowed.length === 0) {
        return ok(`No changes.${hidden ? `\n${omitted(hidden)}` : ''}`)
      }
      if (allowed.length > MAX_FILES) return fail('too many files')
      const r = await run([
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--no-renames',
        ...cached,
        '--',
        ...allowed
      ])
      if ('error' in r) return fail(r.error)
      return finish(r.stdout, r.overflow, 'No changes.', hidden ? [omitted(hidden)] : [])
    }
  }
}

export function createGitMcpServer(deps: GitToolsDeps): ReturnType<typeof createSdkMcpServer> {
  const h = createGitHandlers(deps)
  return createSdkMcpServer({
    name: GIT_SERVER_NAME,
    tools: [
      tool('git_status', 'Short git status of the project. Protected files are omitted.', {}, (a) =>
        h.git_status(a)
      ),
      tool(
        'git_log',
        'One-line git log (hash, date, author, subject). Never shows patches.',
        { maxCount: z.number().int().min(1).max(100).optional(), path: z.string().optional() },
        (a) => h.git_log(a)
      ),
      tool(
        'git_diff',
        'Unified git diff of the working tree (or staged changes). Protected files are omitted.',
        { staged: z.boolean().optional(), path: z.string().optional() },
        (a) => h.git_diff(a)
      )
    ]
  })
}
