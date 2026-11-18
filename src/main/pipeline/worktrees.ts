import { execFile as nodeExecFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Worktree manager for a pipeline run (Phase 4a). Every git call uses the hostile-config argv and env
// from docs/notes/phase-4a-spike.md section 4 (Phase 3 prefix, filter overrides, identity, --no-verify).
// The user's primary checkout is only read (rev-parse, node_modules existence), never written.

export const GIT_TIMEOUT_MS = 60_000
export const GIT_MAX_BUFFER = 1024 * 1024
const ERROR_CAP = 300

export const APP_IDENTITY = ['-c', 'user.name=claude-desk', '-c', 'user.email=claude-desk@localhost', '-c', 'commit.gpgsign=false']

export const GIT_PREFIX = [
  '--no-pager',
  '--no-lazy-fetch',
  '-c',
  'core.sshCommand=',
  '-c',
  'core.gitProxy=',
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
  'core.quotepath=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'gpg.program=',
  '-c',
  'gpg.ssh.program=',
  '-c',
  'gpg.x509.program='
]

export const GIT_ENV_ADDITIONS: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_PAGER: 'cat',
  GIT_EXTERNAL_DIFF: '',
  GIT_NO_LAZY_FETCH: '1',
  GIT_LITERAL_PATHSPECS: '1'
}

const FILTER_LIST_ARGS = ['config', '--get-regexp', '-z', '^filter\\..*\\.(clean|smudge|process)$']
const FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process)$/i
const SAFE_FILTER_NAME = /^[A-Za-z0-9_.-]+$/

export interface GitExecOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeout: number
  maxBuffer: number
}
export type GitExec = (file: string, args: string[], options: GitExecOptions) => Promise<{ stdout: string }>

const defaultExec: GitExec = (file, args, options) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, args, { ...options, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        Object.assign(err, { stdout, stderr })
        reject(err)
        return
      }
      resolve({ stdout })
    })
  })

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string }
export type MergeResult = Result<{ result: 'merged' | 'conflict' }>

export interface WorktreeManagerOptions {
  /** Absolute path of the project's primary checkout (the repository root). */
  projectPath: string
  runId: string
  /** Defaults to `<parent of project>/.worktrees`. Must not be inside the project. */
  worktreesDir?: string
  exec?: GitExec
  env?: NodeJS.ProcessEnv
}

export interface StartedRun {
  baseHash: string
  branch: string
  path: string
}
export interface TaskWorktree {
  branch: string
  path: string
}

export interface WorktreeManager {
  startRun(baseBranch: string): Promise<Result<StartedRun>>
  createTaskWorktree(taskId: string): Promise<Result<TaskWorktree>>
  mergeTask(taskId: string): Promise<MergeResult>
  removeTask(taskId: string): Promise<Result<object>>
  removeRun(): Promise<Result<object>>
}

interface ExecError {
  code?: unknown
  killed?: boolean
  signal?: string | null
  stderr?: unknown
  message?: string
}

const RUN_ID8 = /^[A-Za-z0-9]{8}$/
const TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

class GitFailure extends Error {
  readonly exitCode: unknown
  constructor(message: string, exitCode: unknown) {
    super(message)
    this.exitCode = exitCode
  }
}

function describe(e: unknown): string {
  const err = (e ?? {}) as ExecError
  const stderr = typeof err.stderr === 'string' ? err.stderr : ''
  const text = `${stderr} ${err.message ?? ''}`
  if (err.code === 'ENOENT') return 'git is not installed'
  if (err.killed === true || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') return 'git timed out'
  if (/unknown option:? .*--no-lazy-fetch/i.test(text)) return 'git is too old (2.45 or newer is required)'
  if (/not a git repository/i.test(text)) return 'not a git repo'
  const detail = stderr.trim() || (err.message ?? '').trim()
  return `git failed${detail ? `: ${detail.slice(0, ERROR_CAP)}` : ''}`
}

const isInside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createWorktreeManager(opts: WorktreeManagerOptions): WorktreeManager {
  const exec = opts.exec ?? defaultExec
  const env = { ...(opts.env ?? process.env), ...GIT_ENV_ADDITIONS }
  const run8 = opts.runId.slice(0, 8)
  const runBranch = `run/${run8}`

  let project: string | null = null
  let root: string | null = null
  // Filter overrides are read once per public operation, not once per git call.
  let memo: Promise<string[]> | null = null

  function setup(): string | null {
    memo = null
    if (!RUN_ID8.test(run8)) return 'invalid run id'
    if (project !== null && root !== null) return null
    try {
      const proj = fs.realpathSync.native(opts.projectPath)
      const wanted = opts.worktreesDir ?? path.join(path.dirname(proj), '.worktrees')
      if (!path.isAbsolute(wanted)) return 'worktrees folder must be absolute'
      // Resolve through the deepest existing ancestor so a link or 8.3 name cannot hide "inside the project".
      const resolved = resolveNative(path.resolve(wanted))
      if (isInside(proj, resolved)) return 'worktrees folder must be outside the project'
      project = proj
      root = resolved
      return null
    } catch (e) {
      return `project folder not found: ${message(e)}`.slice(0, ERROR_CAP)
    }
  }

  function resolveNative(p: string): string {
    const missing: string[] = []
    let cur = p
    for (;;) {
      try {
        return path.join(fs.realpathSync.native(cur), ...missing.reverse())
      } catch {
        const parent = path.dirname(cur)
        if (parent === cur) return p
        missing.push(path.basename(cur))
        cur = parent
      }
    }
  }

  async function git(cwd: string, sub: string[], extra: string[] = [], overrides?: string[]): Promise<string> {
    const o = overrides ?? (await (memo ??= filterOverrides()))
    try {
      const { stdout } = await exec('git', [...GIT_PREFIX, ...o, ...extra, ...sub], {
        cwd,
        env,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER
      })
      return stdout
    } catch (e) {
      throw new GitFailure(describe(e), (e as ExecError | null)?.code)
    }
  }

  /** `-c` overrides that blank every configured filter driver. Fails closed. */
  async function filterOverrides(): Promise<string[]> {
    let stdout: string
    try {
      ;({ stdout } = await exec('git', [...GIT_PREFIX, ...FILTER_LIST_ARGS], {
        cwd: project ?? opts.projectPath,
        env,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER
      }))
    } catch (e) {
      if (((e ?? {}) as ExecError).code === 1) return []
      const d = describe(e)
      throw new GitFailure(d.startsWith('git failed') ? 'could not read git filter config' : d, null)
    }
    const names = new Set<string>()
    for (const entry of stdout.split('\0')) {
      if (entry.length === 0) continue
      const m = FILTER_KEY.exec(entry.split('\n')[0] ?? '')
      const name = m?.[1]
      if (name === undefined || !SAFE_FILTER_NAME.test(name)) throw new GitFailure('unsupported git filter config', null)
      names.add(name)
    }
    const args: string[] = []
    for (const name of names) {
      for (const v of ['clean', 'smudge', 'process']) args.push('-c', `filter.${name}.${v}=`)
      args.push('-c', `filter.${name}.required=false`)
    }
    return args
  }

  async function branchExists(branch: string): Promise<boolean> {
    try {
      await git(project as string, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
      return true
    } catch (e) {
      if (e instanceof GitFailure && e.exitCode === 1) return false
      throw e
    }
  }

  const pathExists = (p: string): boolean => {
    try {
      fs.lstatSync(p)
      return true
    } catch {
      return false
    }
  }

  function wtPath(name: string): string {
    return path.join(root as string, name)
  }

  function taskNames(taskId: string): { error: string } | { name: string; branch: string; path: string } {
    const id = taskId.toLowerCase()
    if (id.length === 0 || id.length > 40 || !TASK_ID.test(id)) return { error: 'invalid task id' }
    const name = `${run8}-${id}`
    const p = wtPath(name)
    if (!isInside(root as string, p) || path.dirname(p) !== root || isInside(project as string, p)) {
      return { error: 'worktree path is not allowed' }
    }
    return { name, branch: `task/${name}`, path: p }
  }

  /** Unlinks a node_modules junction/symlink in the worktree, never recursing. Error text when it stays. */
  function unlinkJunction(wt: string): string | null {
    const nm = path.join(wt, 'node_modules')
    let st: fs.Stats
    try {
      st = fs.lstatSync(nm)
    } catch {
      return null
    }
    if (!st.isSymbolicLink()) return null
    try {
      // unlinkSync never recurses and works for symlinks and junctions (rmSync fails with ERR_FS_EISDIR in Electron).
      fs.unlinkSync(nm)
    } catch (e) {
      return `could not unlink node_modules link: ${message(e)}`.slice(0, ERROR_CAP)
    }
    return pathExists(nm) ? 'could not unlink node_modules link' : null
  }

  /**
   * After a failed `git worktree remove`, git may already have emptied and de-registered the folder (on Windows a
   * lock stops the last delete), so a retry fails with "is not a working tree". Deletes the leftover only when it is
   * an EMPTY directory, a direct child of this run's worktrees folder, and not a link. Never recursive.
   * True when the folder is gone afterwards.
   */
  function removeLeftoverFolder(p: string): boolean {
    let st: fs.Stats
    try {
      st = fs.lstatSync(p)
    } catch {
      return true
    }
    if (path.dirname(p) !== root || !path.basename(p).startsWith(`${run8}-`)) return false
    if (st.isSymbolicLink() || !st.isDirectory()) return false
    try {
      if (fs.readdirSync(p).length > 0) return false
      fs.rmdirSync(p)
    } catch {
      return false
    }
    return !pathExists(p)
  }

  async function removeWorktree(p: string, branch: string): Promise<string | null> {
    if (pathExists(p)) {
      const bad = unlinkJunction(p)
      if (bad !== null) return `refusing to remove ${path.basename(p)}: ${bad}`
      try {
        await git(project as string, ['worktree', 'remove', '--force', '--', p])
      } catch (e) {
        try {
          await git(project as string, ['worktree', 'prune'])
        } catch {
          // the folder check below decides
        }
        if (!removeLeftoverFolder(p)) throw e
      }
    }
    await git(project as string, ['worktree', 'prune'])
    if (await branchExists(branch)) await git(project as string, ['branch', '-D', '--', branch])
    return null
  }

  const fail = (e: unknown): { ok: false; error: string } => ({
    ok: false,
    error: e instanceof GitFailure ? e.message : message(e).slice(0, ERROR_CAP)
  })

  return {
    async startRun(baseBranch) {
      const bad = setup()
      if (bad !== null) return { ok: false, error: bad }
      if (baseBranch.length === 0 || baseBranch.startsWith('-') || baseBranch.includes('\0')) {
        return { ok: false, error: 'invalid base branch' }
      }
      const proj = project as string
      try {
        await git(proj, ['rev-parse', '--is-inside-work-tree'])
        let baseHash: string
        try {
          baseHash = (await git(proj, ['rev-parse', '--verify', '--end-of-options', `${baseBranch}^{commit}`])).trim()
        } catch (e) {
          if (e instanceof GitFailure && e.exitCode === 128) return { ok: false, error: `base branch not found: ${baseBranch}` }
          throw e
        }
        const p = wtPath(`${run8}-integration`)
        if (pathExists(p)) return { ok: false, error: 'integration worktree path already exists' }
        if (await branchExists(runBranch)) return { ok: false, error: `branch ${runBranch} already exists` }
        fs.mkdirSync(root as string, { recursive: true })
        await git(proj, ['worktree', 'add', '-b', runBranch, p, baseHash])
        return { ok: true, baseHash, branch: runBranch, path: p }
      } catch (e) {
        return fail(e)
      }
    },

    async createTaskWorktree(taskId) {
      const bad = setup()
      if (bad !== null) return { ok: false, error: bad }
      const n = taskNames(taskId)
      if ('error' in n) return { ok: false, error: n.error }
      const proj = project as string
      // A Node project shares its installed node_modules with each task (linked, never copied). A project without
      // one (new, Python, Java, ...) gets none: its worker installs what it needs with run_command.
      const nodeModules = path.join(proj, 'node_modules')
      let linkNodeModules: boolean
      try {
        linkNodeModules = fs.statSync(nodeModules).isDirectory()
      } catch {
        linkNodeModules = false
      }
      try {
        if (pathExists(n.path)) return { ok: false, error: `worktree path already exists: ${n.name}` }
        if (await branchExists(n.branch)) return { ok: false, error: `branch ${n.branch} already exists` }
        fs.mkdirSync(root as string, { recursive: true })
        await git(proj, ['worktree', 'add', '-b', n.branch, n.path, runBranch])
      } catch (e) {
        return fail(e)
      }
      const real = fs.realpathSync.native(n.path)
      if (!linkNodeModules) return { ok: true, branch: n.branch, path: real }
      try {
        fs.symlinkSync(nodeModules, path.join(real, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
      } catch (e) {
        await removeWorktree(n.path, n.branch).catch(() => undefined)
        return { ok: false, error: `could not link node_modules: ${message(e)}`.slice(0, ERROR_CAP) }
      }
      return { ok: true, branch: n.branch, path: real }
    },

    async mergeTask(taskId) {
      const bad = setup()
      if (bad !== null) return { ok: false, error: bad }
      const n = taskNames(taskId)
      if ('error' in n) return { ok: false, error: n.error }
      const integration = wtPath(`${run8}-integration`)
      if (!pathExists(integration)) return { ok: false, error: 'integration worktree does not exist' }
      try {
        const overrides = await (memo ??= filterOverrides())
        try {
          await git(
            integration,
            ['merge', '--no-ff', '--no-verify', '-m', `Merge ${n.branch} into ${runBranch}`, '--', n.branch],
            APP_IDENTITY,
            overrides
          )
          return { ok: true, result: 'merged' }
        } catch (e) {
          let inProgress = false
          try {
            await git(integration, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], [], overrides)
            inProgress = true
          } catch {
            inProgress = false
          }
          if (!inProgress) throw e
          await git(integration, ['merge', '--abort'], [], overrides)
          const status = await git(integration, ['status', '--porcelain', '--untracked-files=no'], [], overrides)
          if (status.trim().length > 0) return { ok: false, error: 'integration worktree is not clean after aborting the merge' }
          return { ok: true, result: 'conflict' }
        }
      } catch (e) {
        return fail(e)
      }
    },

    async removeTask(taskId) {
      const bad = setup()
      if (bad !== null) return { ok: false, error: bad }
      const n = taskNames(taskId)
      if ('error' in n) return { ok: false, error: n.error }
      try {
        const err = await removeWorktree(n.path, n.branch)
        return err === null ? { ok: true } : { ok: false, error: err }
      } catch (e) {
        return fail(e)
      }
    },

    async removeRun() {
      const bad = setup()
      if (bad !== null) return { ok: false, error: bad }
      try {
        const names = new Set<string>()
        const prefix = `${run8}-`
        let entries: string[] = []
        try {
          entries = fs.readdirSync(root as string)
        } catch {
          entries = []
        }
        for (const e of entries) {
          if (e.startsWith(prefix) && e !== `${run8}-integration`) names.add(e.slice(prefix.length))
        }
        const refs = await git(project as string, ['for-each-ref', '--format=%(refname:short)', `refs/heads/task/${prefix}*`])
        for (const line of refs.split('\n')) {
          const b = line.trim()
          if (b.startsWith(`task/${prefix}`)) names.add(b.slice(`task/${prefix}`.length))
        }
        const errors: string[] = []
        for (const id of names) {
          const n = taskNames(id)
          if ('error' in n) continue
          const err = await removeWorktree(n.path, n.branch)
          if (err !== null) errors.push(err)
        }
        if (errors.length > 0) return { ok: false, error: errors.join('; ').slice(0, ERROR_CAP) }
        const err = await removeWorktree(wtPath(`${run8}-integration`), runBranch)
        return err === null ? { ok: true } : { ok: false, error: err }
      } catch (e) {
        return fail(e)
      }
    }
  }
}
