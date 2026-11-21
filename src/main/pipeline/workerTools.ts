/**
 * In-process MCP tools for pipeline workers (`work` server): `run_check`, `git_commit`, `report_blocked`.
 * The model supplies a check name, in-worktree paths and text, never a command. There is no push, merge,
 * checkout or branch tool. Git argv and env come from docs/notes/phase-4a-spike.md section 4; npm handling on
 * Windows from section 5 (system `node` plus npm's JS entry, never `cmd.exe`, never `process.execPath`).
 */
import { execFile as nodeExecFile } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { mkdir, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { ALLOWED_COMMANDS, COMMAND_TIMEOUT_MS, checkCommand } from './commandPolicy'
import type { CheckConfig } from '../../shared/settings'
import { ownsCovers } from './planParser'

export const WORK_SERVER_NAME = 'work'
export const WORK_TOOL_NAMES = ['run_check', 'git_commit', 'report_blocked', 'run_command', 'move_files', 'delete_files'] as const
export const WORK_ALLOWED_TOOLS: readonly string[] = WORK_TOOL_NAMES.map((n) => `mcp__${WORK_SERVER_NAME}__${n}`)

export const GIT_COMMIT_TIMEOUT_MS = 30_000
export const CHECK_OUTPUT_BUFFER = 1024 * 1024
export const CHECK_REPLY_CAP = 4000
/** A move of N files commits 2N paths (old and new), so a refactor needs room. */
export const MAX_COMMIT_PATHS = 300
export const MAX_FILE_OPS = 150
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
  signal?: AbortSignal
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
  /** File names in a folder (Maven's boot jar); defaults to readdirSync. */
  listDir?: (dir: string) => string[]
  /** The folder the command runs in (Maven needs it as its project directory). */
  cwd?: string
}

/** The first `name` found in an absolute PATH folder. */
export function findOnPath(name: string, deps: ResolveDeps = {}): string | null {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const exists = deps.fileExists ?? existsSync
  const p = platform === 'win32' ? path.win32 : path.posix
  const raw = env['PATH'] ?? env['Path'] ?? ''
  for (const dir of raw.split(platform === 'win32' ? ';' : ':')) {
    const cleaned = dir.trim().replace(/^"|"$/g, '')
    if (cleaned.length === 0 || !p.isAbsolute(cleaned)) continue
    const candidate = p.join(cleaned, name)
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * Maven on Windows ships only `mvn.cmd`, which cannot run without a shell. It is a launcher for
 * `java -classpath <home>/boot/plexus-classworlds-*.jar ... Launcher`, so that is run directly (no shell).
 */
function resolveMaven(args: string[], deps: ResolveDeps): ResolvedCommand {
  const exists = deps.fileExists ?? existsSync
  const env = deps.env ?? process.env
  const listDir = deps.listDir ?? ((d: string) => readdirSync(d))
  const cmd = findOnPath('mvn.cmd', deps)
  if (cmd === null) return { error: 'cannot run mvn: Maven was not found on PATH' }
  const home = path.win32.dirname(path.win32.dirname(cmd))
  let jar: string | undefined
  try {
    jar = listDir(path.win32.join(home, 'boot')).find((f) => /^plexus-classworlds-[\w.-]+\.jar$/.test(f))
  } catch {
    jar = undefined
  }
  if (jar === undefined) return { error: 'cannot run mvn: the Maven boot jar was not found' }
  const javaHome = env['JAVA_HOME']
  const fromHome = javaHome ? path.win32.join(javaHome, 'bin', 'java.exe') : null
  const java = fromHome !== null && exists(fromHome) ? fromHome : findOnPath('java.exe', deps)
  if (java === null) return { error: 'cannot run mvn: java was not found (set JAVA_HOME or add java to PATH)' }
  return {
    file: java,
    args: [
      '-classpath',
      path.win32.join(home, 'boot', jar),
      `-Dclassworlds.conf=${path.win32.join(home, 'bin', 'm2.conf')}`,
      `-Dmaven.home=${home}`,
      `-Dmaven.multiModuleProjectDirectory=${deps.cwd ?? process.cwd()}`,
      'org.codehaus.plexus.classworlds.launcher.Launcher',
      ...args
    ]
  }
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
  if (stem === 'mvn') return resolveMaven(args, deps)
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
  /** Project setting: enables the allow-listed `run_command` tool. */
  allowCommands?: boolean
  /** Receives one short outcome line per work-tool call (live pipeline log). */
  onLog?: (line: { text: string; tone: 'ok' | 'error' }) => void
  exec?: ExecFn
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  fileExists?: (p: string) => boolean
  /**
   * The worker guard's write check (worktree, links, .git, Owns, protected paths) for one relative path; returns the
   * reason when the path may not be changed. Absent: move_files and delete_files refuse everything.
   */
  checkPath?: (tool: string, relPath: string) => string | null
}

export interface WorkerHandlers {
  run_check: (input: unknown) => Promise<TextResult>
  git_commit: (input: unknown) => Promise<TextResult>
  report_blocked: (input: unknown) => Promise<TextResult>
  run_command: (input: unknown) => Promise<TextResult>
  move_files: (input: unknown) => Promise<TextResult>
  delete_files: (input: unknown) => Promise<TextResult>
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
const moveInput = z.object({
  moves: z.array(z.object({ from: z.string(), to: z.string() })).min(1).max(MAX_FILE_OPS)
})
const deleteInput = z.object({ paths: z.array(z.string()).min(1).max(MAX_FILE_OPS) })

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
        fileExists: deps.fileExists,
        cwd: deps.worktree
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

  async function run_command(input: unknown): Promise<TextResult> {
    if (deps.allowCommands !== true) return fail('run_command is disabled for this project (setting: allow commands)')
    const raw = (typeof input === 'object' && input !== null ? input : {}) as { command?: unknown; args?: unknown }
    const decision = checkCommand(raw.command, raw.args ?? [])
    if (!decision.ok) return fail(decision.error)
    const resolved = resolveCheckCommand(
      { name: 'cmd', executable: decision.command, args: decision.args, timeoutMs: COMMAND_TIMEOUT_MS },
      [],
      { platform: deps.platform, env: deps.env, fileExists: deps.fileExists, cwd: deps.worktree }
    )
    if ('error' in resolved) return fail(resolved.error)
    try {
      const { stdout, stderr } = await exec(resolved.file, resolved.args, {
        cwd: deps.worktree,
        env: checkEnv(deps.env ?? process.env),
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: CHECK_OUTPUT_BUFFER
      })
      const out = tail(`${stdout}
${stderr}`, CHECK_REPLY_CAP)
      return ok(`${decision.command} finished${out ? `
${out}` : ''}`)
    } catch (e) {
      const err = (e ?? {}) as ExecErr
      const out = tail(`${typeof err.stdout === 'string' ? err.stdout : ''}
${typeof err.stderr === 'string' ? err.stderr : ''}`, CHECK_REPLY_CAP)
      if (err.killed === true || err.code === 'ETIMEDOUT') return fail(`${decision.command} timed out${out ? `
${out}` : ''}`)
      if (typeof err.code === 'number') return fail(`${decision.command} failed (exit code ${err.code})${out ? `
${out}` : ''}`)
      return fail(`${decision.command} could not start (${typeof err.code === 'string' ? err.code : 'unknown error'})`)
    }
  }

  /** A relative path as forward slashes without a leading "./". */
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '')

  /** Why a path may not be changed by move/delete, or null. */
  function pathProblem(tool: string, raw: string): string | null {
    const bad = badRelativePath(raw)
    if (bad !== null) return `path "${raw.slice(0, 80)}" rejected: ${bad}`
    if (!deps.checkPath) return 'moving and deleting files is not available'
    return deps.checkPath(tool, raw)
  }

  /** The existing regular file at `rel`, or a reason. */
  function existingFile(rel: string): string | null {
    try {
      const st = lstatSync(path.join(worktreeReal(), ...rel.split('/')))
      return st.isFile() ? null : `"${rel}" is not a regular file`
    } catch {
      return `"${rel}" does not exist`
    }
  }

  /** Removes folders emptied by a move or delete, up to (not including) the worktree root. */
  async function pruneEmpty(rel: string): Promise<void> {
    const root = worktreeReal()
    let dir = path.dirname(path.join(root, ...rel.split('/')))
    while (dir !== root && dir.startsWith(root)) {
      try {
        if ((await readdir(dir)).length > 0) return
        await rmdir(dir)
      } catch {
        return
      }
      dir = path.dirname(dir)
    }
  }

  async function move_files(input: unknown): Promise<TextResult> {
    try {
      const parsed = moveInput.safeParse(input)
      if (!parsed.success) return fail(`invalid input: moves (1..${MAX_FILE_OPS} items of { from, to }) are required`)
      const moves = parsed.data.moves.map((m) => ({ from: norm(m.from), to: norm(m.to) }))
      const root = worktreeReal()
      // Check everything first: either every move is allowed, or nothing is moved.
      const targets = new Set<string>()
      for (const m of moves) {
        const problem =
          pathProblem('move_files', m.from) ??
          pathProblem('move_files', m.to) ??
          existingFile(m.from) ??
          (m.from === m.to ? `"${m.from}" is moved onto itself` : null)
        if (problem !== null) return fail(`nothing was moved: ${problem}`)
        const key = sameCase(m.to)
        if (targets.has(key)) return fail(`nothing was moved: two moves go to "${m.to}"`)
        targets.add(key)
        // A case-only rename on a case-insensitive disk finds its own source here; that is allowed.
        if (existsSync(path.join(root, ...m.to.split('/'))) && sameCase(m.from) !== key) {
          return fail(`nothing was moved: "${m.to}" already exists`)
        }
      }
      const done: string[] = []
      for (const m of moves) {
        const to = path.join(root, ...m.to.split('/'))
        await mkdir(path.dirname(to), { recursive: true })
        await rename(path.join(root, ...m.from.split('/')), to)
        done.push(`${m.from} -> ${m.to}`)
      }
      for (const m of moves) await pruneEmpty(m.from)
      const list = done.slice(0, 40).join('\n') + (done.length > 40 ? `\n... ${done.length - 40} more` : '')
      return ok(
        `moved ${done.length} ${done.length === 1 ? 'file' : 'files'}. Update package and import lines with Edit, then commit both the old and the new paths with git_commit.\n${list}`
      )
    } catch (e) {
      return fail(`move_files failed: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}`)
    }
  }

  async function delete_files(input: unknown): Promise<TextResult> {
    try {
      const parsed = deleteInput.safeParse(input)
      if (!parsed.success) return fail(`invalid input: paths (1..${MAX_FILE_OPS} strings) are required`)
      const paths = parsed.data.paths.map(norm)
      for (const p of paths) {
        const problem = pathProblem('delete_files', p) ?? existingFile(p)
        if (problem !== null) return fail(`nothing was deleted: ${problem}`)
      }
      const root = worktreeReal()
      for (const p of paths) await unlink(path.join(root, ...p.split('/')))
      for (const p of paths) await pruneEmpty(p)
      return ok(`deleted ${paths.length} ${paths.length === 1 ? 'file' : 'files'}. Commit the deleted paths with git_commit.`)
    } catch (e) {
      return fail(`delete_files failed: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}`)
    }
  }

  /** Wraps a handler so each call adds one outcome line to the live log (never the full output). */
  const logged =
    (name: keyof WorkerHandlers, fn: (input: unknown) => Promise<TextResult>) =>
    async (input: unknown): Promise<TextResult> => {
      const r = await fn(input)
      if (deps.onLog) {
        try {
          const first = (r.content[0]?.text ?? '').split(/\r?\n/)[0] ?? ''
          const raw = (typeof input === 'object' && input !== null ? input : {}) as { command?: unknown; args?: unknown }
          const what =
            name === 'run_command' && typeof raw.command === 'string'
              ? `run_command ${raw.command} ${Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === 'string').join(' ') : ''}`.trim()
              : name
          deps.onLog({ text: `${what}: ${first}`, tone: r.isError === true ? 'error' : 'ok' })
        } catch {
          // logging never changes a tool result
        }
      }
      return r
    }

  const handlers: WorkerHandlers = {
    run_check: logged('run_check', run_check),
    git_commit: logged('git_commit', git_commit),
    report_blocked: logged('report_blocked', report_blocked),
    run_command: logged('run_command', run_command),
    move_files: logged('move_files', move_files),
    delete_files: logged('delete_files', delete_files)
  }

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
            'run_command',
            `Run an allow-listed command in the worktree (no shell): ${ALLOWED_COMMANDS.join(', ')}. Example: command "npm", args ["install", "express"]. Commit the files you want with git_commit afterwards.`,
            { command: z.string(), args: z.array(z.string()).optional() },
            (a) => handlers.run_command(a)
          ),
          tool(
            'move_files',
            'Move or rename files inside your Owns (both the old and the new path must be in Owns). All moves are checked first; nothing moves if one is refused. Emptied folders are removed. Then fix package and import lines with Edit and commit the old and new paths with git_commit.',
            { moves: z.array(z.object({ from: z.string(), to: z.string() })) },
            (a) => handlers.move_files(a)
          ),
          tool(
            'delete_files',
            'Delete files inside your Owns (regular files only). Emptied folders are removed. Commit the deleted paths with git_commit.',
            { paths: z.array(z.string()) },
            (a) => handlers.delete_files(a)
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
