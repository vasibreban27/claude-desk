/**
 * In-process MCP tools for pipeline workers (`work` server): `run_check`, `git_commit`, `report_blocked`.
 * The model supplies a check name, in-worktree paths and text, never a command. There is no push, merge,
 * checkout or branch tool. Git argv and env come from docs/notes/phase-4a-spike.md section 4; npm handling on
 * Windows from section 5 (system `node` plus npm's JS entry, never `cmd.exe`, never `process.execPath`).
 */
import { execFile as nodeExecFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { CheckConfig } from '../../shared/settings'
import { ownsCovers } from './planParser'

export const WORK_SERVER_NAME = 'work'
export const WORK_TOOL_NAMES = ['run_check', 'git_commit', 'report_blocked'] as const
export const WORK_ALLOWED_TOOLS: readonly string[] = WORK_TOOL_NAMES.map((n) => `mcp__${WORK_SERVER_NAME}__${n}`)

export const GIT_COMMIT_TIMEOUT_MS = 30_000
export const CHECK_OUTPUT_BUFFER = 1024 * 1024
export const CHECK_REPLY_CAP = 4000
export const MAX_COMMIT_PATHS = 50
export const MAX_MESSAGE_LENGTH = 1000
export const MAX_BLOCKED_REASON = 500
const GIT_MAX_BUFFER = 1024 * 1024

export type CheckResult = 'passed' | 'failed' | 'none'

export interface TextResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

export interface ExecOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeout: number
  maxBuffer: number
}
/** Resolves with output; rejects with an error that may carry `code`, `killed`, `signal`, `stdout`, `stderr`. */
export type ExecFn = (file: string, args: string[], options: ExecOptions) => Promise<{ stdout: string; stderr: string }>

const defaultExec: ExecFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, args, { ...options, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        Object.assign(err, { stdout, stderr })
        reject(err)
        return
      }
      resolve({ stdout, stderr })
    })
  })

const ok = (text: string): TextResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): TextResult => ({ content: [{ type: 'text', text }], isError: true })

// ---------------------------------------------------------------- command resolution

export interface ResolveDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  fileExists?: (p: string) => boolean
}

export type ResolvedCommand = { file: string; args: string[] } | { error: string }

/** The system `node` found on PATH (never the Electron binary). Null when there is none. */
export function findSystemNode(deps: ResolveDeps = {}): string | null {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const exists = deps.fileExists ?? existsSync
  const p = platform === 'win32' ? path.win32 : path.posix
  const raw = env['PATH'] ?? env['Path'] ?? ''
  const delimiter = platform === 'win32' ? ';' : ':'
  const name = platform === 'win32' ? 'node.exe' : 'node'
  for (const dir of raw.split(delimiter)) {
    const cleaned = dir.trim().replace(/^"|"$/g, '')
    if (cleaned.length === 0 || !p.isAbsolute(cleaned)) continue
    const candidate = p.join(cleaned, name)
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * Turns a check into `{ file, args }`. On win32, `npm`/`npx` run as `node <npm-cli.js|npx-cli.js> ...args`
 * (no shell); `.cmd`/`.bat` executables are refused. Other executables run directly.
 */
export function resolveCheckCommand(check: CheckConfig, extraArgs: string[], deps: ResolveDeps = {}): ResolvedCommand {
  const platform = deps.platform ?? process.platform
  const exists = deps.fileExists ?? existsSync
  const args = [...check.args, ...extraArgs]
  if (platform !== 'win32') return { file: check.executable, args }
  const base = path.win32.basename(check.executable).toLowerCase()
  if (/\.(cmd|bat)$/.test(base)) {
    return { error: `Check "${check.name}" uses a .cmd/.bat command, which cannot run without a shell: use a node or exe command.` }
  }
  const stem = base.replace(/\.exe$/, '')
  if (stem === 'npm' || stem === 'npx') {
    const node = findSystemNode(deps)
    if (node === null) return { error: `cannot run ${stem}: node was not found on PATH` }
    const entry = path.win32.join(path.win32.dirname(node), 'node_modules', 'npm', 'bin', `${stem}-cli.js`)
    if (!exists(entry)) return { error: `cannot run ${stem}: ${stem}-cli.js was not found next to node` }
    return { file: node, args: [entry, ...args] }
  }
  return { file: check.executable, args }
}

// ---------------------------------------------------------------- git

const GIT_PREFIX = [
  '--no-pager',
  '--no-lazy-fetch',
  '-c', 'core.sshCommand=',
  '-c', 'core.gitProxy=',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.pager=cat',
  '-c', 'core.hooksPath=',
  '-c', 'diff.external=',
  '-c', 'core.untrackedCache=false',
  '-c', 'core.quotepath=false',
  '-c', 'log.showSignature=false',
  '-c', 'gpg.program=',
  '-c', 'gpg.ssh.program=',
  '-c', 'gpg.x509.program='
]
const IDENTITY = ['-c', 'user.name=claude-desk', '-c', 'user.email=claude-desk@localhost', '-c', 'commit.gpgsign=false']
const GIT_ENV: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_PAGER: 'cat',
  GIT_EXTERNAL_DIFF: '',
  GIT_NO_LAZY_FETCH: '1',
  GIT_LITERAL_PATHSPECS: '1'
}
const FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process)$/i
const SAFE_FILTER_NAME = /^[A-Za-z0-9_.-]+$/

/** Returns an error message, or null when the path is a plain relative file path. */
function badRelativePath(p: string): string | null {
  if (p.length === 0 || p.length > 500) return 'path must be 1..500 characters'
  if (p.includes('\0')) return 'path contains a NUL character'
  if (p.startsWith('-') || p.startsWith(':')) return 'path must not start with "-" or ":"'
  if (/^[A-Za-z]:/.test(p) || path.posix.isAbsolute(p) || path.win32.isAbsolute(p) || p.startsWith('\\')) {
    return 'path must be relative'
  }
  if (p.includes(':')) return 'path must not contain ":"'
  if (p.split(/[\\/]/).includes('..')) return 'path must not contain ".."'
  return null
}

const CHECK_ENV_ALLOW: ReadonlySet<string> = new Set(
  ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'PATHEXT'].map((k) =>
    k.toUpperCase()
  )
)

/** Allow-listed environment for check processes: no API keys, GIT_*, NODE_OPTIONS or tokens. */
export function checkEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && CHECK_ENV_ALLOW.has(key.toUpperCase())) out[key] = value
  }
  out['CI'] = '1'
  return out
}

const sameCase = (a: string): string => (process.platform === 'win32' ? a.toLowerCase() : a)

// ---------------------------------------------------------------- tools

export interface WorkerToolsDeps {
  taskId: string
  worktree: string
  /** The expected `task/<runId8>-<taskId>` branch. */
  branch: string
  owns: readonly string[]
  checks: readonly CheckConfig[]
  /** Called with the (capped) reason when the worker reports it is blocked. */
  onBlocked: (reason: string) => void
  exec?: ExecFn
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  fileExists?: (p: string) => boolean
}

export interface WorkerHandlers {
  run_check: (input: unknown) => Promise<TextResult>
  git_commit: (input: unknown) => Promise<TextResult>
  report_blocked: (input: unknown) => Promise<TextResult>
}

export interface WorkerTools {
  handlers: WorkerHandlers
  /** Last `run_check` outcome for this task. */
  getCheckResult: () => CheckResult
  /** Builds the in-process MCP server (name `work`). */
  createServer: () => ReturnType<typeof createSdkMcpServer>
}

const checkInput = z.object({ name: z.string().min(1).max(64), testPath: z.string().optional() })
const commitInput = z.object({
  paths: z.array(z.string()).min(1).max(MAX_COMMIT_PATHS),
  message: z.string()
})
const blockedInput = z.object({ reason: z.string() })

interface ExecErr {
  code?: unknown
  killed?: boolean
  signal?: string | null
  stdout?: unknown
  stderr?: unknown
  message?: string
}

function tail(text: string, max: number): string {
  const t = text.trim()
  return t.length <= max ? t : `[truncated] ...${t.slice(t.length - max)}`
}

export function createWorkerTools(deps: WorkerToolsDeps): WorkerTools {
  const exec = deps.exec ?? defaultExec
  let lastResult: CheckResult = 'none'
  let realWorktree: string | null = null

  function worktreeReal(): string {
    if (realWorktree === null) {
      try {
        realWorktree = realpathSync.native(deps.worktree)
      } catch {
        realWorktree = path.resolve(deps.worktree)
      }
    }
    return realWorktree
  }

  /** The testPath as a relative forward-slash path inside the worktree, or an error message. */
  function validateTestPath(raw: string): { path: string } | { error: string } {
    const bad = badRelativePath(raw)
    if (bad !== null) return { error: `testPath rejected: ${bad}` }
    const root = worktreeReal()
    const target = path.resolve(root, raw)
    const rel = path.relative(root, target)
    if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      return { error: 'testPath rejected: must lie inside the worktree' }
    }
    if (existsSync(target)) {
      try {
        const real = realpathSync.native(target)
        const r = path.relative(root, real)
        if (r === '' || r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)) {
          return { error: 'testPath rejected: must lie inside the worktree' }
        }
      } catch {
        return { error: 'testPath rejected: cannot be resolved' }
      }
    }
    const segments = rel.split(/[\\/]/)
    if (segments.some((s) => s.startsWith('-'))) {
      return { error: 'testPath rejected: no path segment may start with "-"' }
    }
    // The "./" prefix keeps the argument from ever being read as an option.
    return { path: `./${segments.join('/')}` }
  }

  async function run_check(input: unknown): Promise<TextResult> {
    try {
      const parsed = checkInput.safeParse(input)
      if (!parsed.success) return fail('invalid input: name (string) is required')
      if (deps.checks.length === 0) return ok('no checks configured')
      const check = deps.checks.find((c) => c.name === parsed.data.name)
      if (check === undefined) {
        return fail(`unknown check "${parsed.data.name}"; available: ${deps.checks.map((c) => c.name).join(', ')}`)
      }
      const extra: string[] = []
      if (parsed.data.testPath !== undefined) {
        if (check.acceptsTestPath !== true) return fail(`check "${check.name}" does not accept a testPath`)
        const v = validateTestPath(parsed.data.testPath)
        if ('error' in v) return fail(v.error)
        extra.push(v.path)
      }
      const command = resolveCheckCommand(check, extra, {
        platform: deps.platform,
        env: deps.env,
        fileExists: deps.fileExists
      })
      if ('error' in command) {
        lastResult = 'failed'
        return fail(command.error)
      }
      try {
        const { stdout, stderr } = await exec(command.file, command.args, {
          cwd: deps.worktree,
          env: checkEnv(deps.env ?? process.env),
          timeout: check.timeoutMs,
          maxBuffer: CHECK_OUTPUT_BUFFER
        })
        lastResult = 'passed'
        const out = tail(`${stdout}\n${stderr}`, CHECK_REPLY_CAP)
        return ok(`check "${check.name}" passed${out ? `\n${out}` : ''}`)
      } catch (e) {
        lastResult = 'failed'
        const err = (e ?? {}) as ExecErr
        const out = tail(
          `${typeof err.stdout === 'string' ? err.stdout : ''}\n${typeof err.stderr === 'string' ? err.stderr : ''}`,
          CHECK_REPLY_CAP
        )
        if (err.killed === true || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
          return fail(`check "${check.name}" timed out after ${check.timeoutMs} ms${out ? `\n${out}` : ''}`)
        }
        if (typeof err.code === 'number') {
          return fail(`check "${check.name}" failed (exit code ${err.code})${out ? `\n${out}` : ''}`)
        }
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return fail(`check "${check.name}" failed: output too large${out ? `\n${out}` : ''}`)
        }
        const why = typeof err.code === 'string' ? err.code : 'unknown error'
        return fail(`check "${check.name}" could not start (${why})`)
      }
    } catch {
      return fail('run_check failed unexpectedly')
    }
  }

  const gitOptions = (): ExecOptions => ({
    cwd: deps.worktree,
    env: { ...(deps.env ?? process.env), ...GIT_ENV },
    timeout: GIT_COMMIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER
  })

  async function filterOverrides(): Promise<string[]> {
    let stdout: string
    try {
      ;({ stdout } = await exec(
        'git',
        [...GIT_PREFIX, 'config', '--get-regexp', '-z', '^filter\\..*\\.(clean|smudge|process)$'],
        gitOptions()
      ))
    } catch (e) {
      if (((e ?? {}) as ExecErr).code === 1) return []
      throw new Error('could not read git filter config', { cause: e })
    }
    const names = new Set<string>()
    for (const entry of stdout.split('\0')) {
      if (entry.length === 0) continue
      const m = FILTER_KEY.exec(entry.split('\n')[0] ?? '')
      const name = m?.[1]
      if (name === undefined || !SAFE_FILTER_NAME.test(name)) throw new Error('unsupported git filter config')
      names.add(name)
    }
    const args: string[] = []
    for (const name of names) {
      for (const v of ['clean', 'smudge', 'process']) args.push('-c', `filter.${name}.${v}=`)
      args.push('-c', `filter.${name}.required=false`)
    }
    return args
  }

  async function git_commit(input: unknown): Promise<TextResult> {
    try {
      const parsed = commitInput.safeParse(input)
      if (!parsed.success) return fail(`invalid input: paths (1..${MAX_COMMIT_PATHS} strings) and message are required`)
      const message = parsed.data.message.trim()
      if (message.length === 0) return fail('message must not be empty')
      if (message.length > MAX_MESSAGE_LENGTH || message.includes('\0')) {
        return fail(`message is too long or invalid (at most ${MAX_MESSAGE_LENGTH} characters)`)
      }
      const paths: string[] = []
      for (const raw of parsed.data.paths) {
        const bad = badRelativePath(raw)
        if (bad !== null) return fail(`path "${raw.slice(0, 80)}" rejected: ${bad}`)
        const norm = raw.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
        if (!ownsCovers(deps.owns, norm)) return fail(`path "${norm}" is outside this task's Owns`)
        if (!paths.some((p) => sameCase(p) === sameCase(norm))) paths.push(norm)
      }

      const head = await exec('git', [...GIT_PREFIX, 'rev-parse', '--abbrev-ref', 'HEAD'], gitOptions())
      if (head.stdout.trim() !== deps.branch) {
        return fail(`HEAD is not on the expected branch ${deps.branch}; nothing was committed`)
      }
      const overrides = await filterOverrides()
      const status = await exec(
        'git',
        [
          ...GIT_PREFIX,
          ...overrides,
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--no-renames',
          '--ignore-submodules=all',
          '--',
          ...paths
        ],
        gitOptions()
      )
      const changed = new Set(
        status.stdout
          .split('\0')
          .filter((e) => e.length > 3)
          .map((e) => sameCase(e.slice(3)))
      )
      const unchanged = paths.filter((p) => !changed.has(sameCase(p)))
      if (unchanged.length > 0) return fail(`no change to commit in: ${unchanged.join(', ')}`)

      await exec('git', [...GIT_PREFIX, ...overrides, 'add', '--', ...paths], gitOptions())
      const fullMessage = `${message}\n\nTask: ${deps.taskId}`
      try {
        await exec(
          'git',
          [...GIT_PREFIX, ...overrides, ...IDENTITY, 'commit', '--no-verify', '-m', fullMessage, '--only', '--', ...paths],
          gitOptions()
        )
      } catch (commitError) {
        // F6: do not leave these paths staged after a failed commit. Best effort; the commit error is reported.
        try {
          await exec('git', [...GIT_PREFIX, ...overrides, 'reset', '-q', '--', ...paths], gitOptions())
        } catch {
          // ignored on purpose
        }
        throw commitError
      }
      const hash = await exec('git', [...GIT_PREFIX, 'rev-parse', '--short', 'HEAD'], gitOptions())
      return ok(`committed ${paths.length} file(s) as ${hash.stdout.trim()}`)
    } catch (e) {
      const err = (e ?? {}) as ExecErr
      if (err.killed === true || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') return fail('git timed out')
      if (err.code === 'ENOENT') return fail('git is not installed')
      const stderr = typeof err.stderr === 'string' ? err.stderr.trim().slice(0, 200) : ''
      return fail(`git failed${stderr ? `: ${stderr}` : ''}`)
    }
  }

  async function report_blocked(input: unknown): Promise<TextResult> {
    const parsed = blockedInput.safeParse(input)
    if (!parsed.success) return fail('invalid input: reason (string) is required')
    const reason = parsed.data.reason.trim().slice(0, MAX_BLOCKED_REASON)
    if (reason.length === 0) return fail('reason must not be empty')
    try {
      deps.onBlocked(reason)
    } catch {
      return fail('could not record the reason')
    }
    return ok('Blocked recorded. Stop working on this task now.')
  }

  const handlers: WorkerHandlers = { run_check, git_commit, report_blocked }

  return {
    handlers,
    getCheckResult: () => lastResult,
    createServer: () =>
      createSdkMcpServer({
        name: WORK_SERVER_NAME,
        tools: [
          tool(
            'run_check',
            'Run one of the project checks by name (for example the tests). Optionally pass testPath, a path inside the worktree, for checks that accept one.',
            { name: z.string(), testPath: z.string().optional() },
            (a) => handlers.run_check(a)
          ),
          tool(
            'git_commit',
            'Commit explicit files (each inside your Owns, each changed) on your task branch. Pass paths and a short message.',
            { paths: z.array(z.string()), message: z.string() },
            (a) => handlers.git_commit(a)
          ),
          tool(
            'report_blocked',
            'Report that you cannot finish (for example a file outside Owns is needed). Give a short reason, then stop.',
            { reason: z.string() },
            (a) => handlers.report_blocked(a)
          )
        ]
      })
  }
}
