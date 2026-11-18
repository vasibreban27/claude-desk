import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APP_IDENTITY,
  GIT_ENV_ADDITIONS,
  GIT_PREFIX,
  createWorktreeManager,
  type GitExec,
  type GitExecOptions
} from './worktrees'

const RUN_ID = 'abcd1234-0000-4000-8000-000000000000'
const R8 = 'abcd1234'
const BLANK_FILTER = ['-c', 'filter.evil.clean=', '-c', 'filter.evil.smudge=', '-c', 'filter.evil.process=', '-c', 'filter.evil.required=false']

let base: string
let repo: string
let markers: string

/** Test helper git: hardened so that the test's own setup never trips the hostile config. */
function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_PREFIX, ...BLANK_FILTER, ...APP_IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV_ADDITIONS }
  })
}

const fwd = (p: string): string => p.replace(/\\/g, '/')

function setupRepo(): void {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-')))
  repo = path.join(base, 'repo')
  markers = path.join(base, 'markers')
  fs.mkdirSync(repo)
  fs.mkdirSync(markers)
  g(repo, 'init', '-b', 'main')
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  fs.writeFileSync(path.join(repo, 'shared.md'), 'one\n')
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=evil\n')
  g(repo, 'add', '--', '.')
  g(repo, 'commit', '--no-verify', '-m', 'init')
  fs.mkdirSync(path.join(repo, 'node_modules'))
  fs.writeFileSync(path.join(repo, 'node_modules', 'sentinel.txt'), 'keep\n')
}

/** Installs hooks, fsmonitor and a filter driver that write marker files. Called last. */
function installHostileConfig(): void {
  const hooksDir = path.join(base, 'hooks')
  fs.mkdirSync(hooksDir)
  for (const dir of [hooksDir, path.join(repo, '.git', 'hooks')]) {
    for (const h of ['post-checkout', 'pre-commit', 'commit-msg', 'post-commit', 'post-merge', 'pre-merge-commit', 'prepare-commit-msg', 'reference-transaction']) {
      fs.writeFileSync(path.join(dir, h), `#!/bin/sh\necho x > "${fwd(markers)}/${path.basename(dir)}-${h}"\nexit 0\n`, { mode: 0o755 })
    }
  }
  const cfg = (k: string, v: string): string => execFileSync('git', ['config', k, v], { cwd: repo, encoding: 'utf8' })
  cfg('core.hooksPath', fwd(hooksDir))
  cfg('core.fsmonitor', `echo x > ${fwd(markers)}/fsmonitor`)
  cfg('filter.evil.clean', `echo x > ${fwd(markers)}/filter-clean; cat`)
  cfg('filter.evil.smudge', `echo x > ${fwd(markers)}/filter-smudge; cat`)
}

const mgr = (extra: Partial<Parameters<typeof createWorktreeManager>[0]> = {}): ReturnType<typeof createWorktreeManager> =>
  createWorktreeManager({ projectPath: repo, runId: RUN_ID, ...extra })

const wtRoot = (): string => path.join(base, '.worktrees')

// Real git on Windows is slow (several processes per manager call).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

beforeEach(setupRepo)
afterEach(() => {
  vi.restoreAllMocks()
  // Unlink junctions first so the recursive cleanup never follows them.
  const root = wtRoot()
  if (fs.existsSync(root)) {
    for (const d of fs.readdirSync(root)) {
      const nm = path.join(root, d, 'node_modules')
      try {
        if (fs.lstatSync(nm).isSymbolicLink()) fs.rmSync(nm)
      } catch {
        // not there
      }
    }
  }
  fs.rmSync(base, { recursive: true, force: true })
})

describe('startRun', () => {
  it('records the base hash, creates run/<id8> in the integration worktree, later base commits change nothing', async () => {
    const m = mgr()
    const baseHash = g(repo, 'rev-parse', 'main').trim()
    const r = await m.startRun('main')
    expect(r).toEqual({ ok: true, baseHash, branch: `run/${R8}`, path: path.join(wtRoot(), `${R8}-integration`) })
    expect(g(repo, 'rev-parse', `run/${R8}`).trim()).toBe(baseHash)
    expect(fs.existsSync(path.join(wtRoot(), `${R8}-integration`, 'a.txt'))).toBe(true)

    fs.writeFileSync(path.join(repo, 'later.md'), 'later\n')
    g(repo, 'add', '--', 'later.md')
    g(repo, 'commit', '--no-verify', '-m', 'later')
    expect(g(repo, 'rev-parse', `run/${R8}`).trim()).toBe(baseHash)
    expect(g(repo, 'rev-parse', 'main').trim()).not.toBe(baseHash)
  })

  it('returns a short error and creates nothing for a missing base branch', async () => {
    const r = await mgr().startRun('nope')
    expect(r).toEqual({ ok: false, error: 'base branch not found: nope' })
    expect(fs.existsSync(wtRoot())).toBe(false)
    expect(g(repo, 'branch', '--list', 'run/*').trim()).toBe('')
  })

  it('rejects an option-like branch name', async () => {
    const r = await mgr().startRun('--upload-pack=x')
    expect(r).toEqual({ ok: false, error: 'invalid base branch' })
  })

  it('reports a folder that is not a git repo and creates nothing', async () => {
    const plain = path.join(base, 'plain')
    fs.mkdirSync(plain)
    const r = await mgr({ projectPath: plain, worktreesDir: path.join(base, 'wts') }).startRun('main')
    expect(r).toEqual({ ok: false, error: 'not a git repo' })
    expect(fs.existsSync(path.join(base, 'wts'))).toBe(false)
  })

  it('reports git that is too old', async () => {
    const exec: GitExec = () =>
      Promise.reject(Object.assign(new Error('x'), { code: 129, stderr: 'unknown option: --no-lazy-fetch' }))
    const r = await mgr({ exec }).startRun('main')
    expect(r).toEqual({ ok: false, error: 'git is too old (2.45 or newer is required)' })
    expect(fs.existsSync(wtRoot())).toBe(false)
  })

  it('reports a missing git binary', async () => {
    const exec: GitExec = () => Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))
    expect(await mgr({ exec }).startRun('main')).toEqual({ ok: false, error: 'git is not installed' })
  })

  it('rejects a worktrees folder inside the project', async () => {
    const r = await mgr({ worktreesDir: path.join(repo, 'wts') }).startRun('main')
    expect(r).toEqual({ ok: false, error: 'worktrees folder must be outside the project' })
    expect(fs.existsSync(path.join(repo, 'wts'))).toBe(false)
  })

  it('fails when the integration path or branch already exists', async () => {
    const m = mgr()
    expect((await m.startRun('main')).ok).toBe(true)
    const again = await m.startRun('main')
    expect(again.ok).toBe(false)
  })
})

describe('createTaskWorktree', () => {
  it('branches from the current tip of the run branch and leaves a dirty primary checkout alone', async () => {
    const m = mgr()
    await m.startRun('main')
    fs.writeFileSync(path.join(repo, 'shared.md'), 'dirty\n')
    fs.writeFileSync(path.join(repo, 'untracked.md'), 'u\n')
    const statusBefore = g(repo, 'status', '--porcelain')
    const t = await m.createTaskWorktree('T1')
    expect(t).toEqual({ ok: true, branch: `task/${R8}-t1`, path: path.join(wtRoot(), `${R8}-t1`) })
    expect(g(repo, 'rev-parse', `task/${R8}-t1`).trim()).toBe(g(repo, 'rev-parse', `run/${R8}`).trim())
    expect(g(repo, 'status', '--porcelain')).toBe(statusBefore)
    expect(fs.readFileSync(path.join(repo, 'shared.md'), 'utf8')).toBe('dirty\n')
    expect(g(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
  })

  it('later tasks branch from the merged tip', async () => {
    const m = mgr()
    await m.startRun('main')
    const t1 = await m.createTaskWorktree('t1')
    if (!t1.ok) throw new Error(t1.error)
    fs.writeFileSync(path.join(t1.path, 'one.md'), '1\n')
    g(t1.path, 'add', '--', 'one.md')
    g(t1.path, 'commit', '--no-verify', '-m', 't1')
    expect(await m.mergeTask('t1')).toEqual({ ok: true, result: 'merged' })
    const t2 = await m.createTaskWorktree('t2')
    if (!t2.ok) throw new Error(t2.error)
    expect(fs.existsSync(path.join(t2.path, 'one.md'))).toBe(true)
  })

  it('fails clearly when the branch or the path already exists', async () => {
    const m = mgr()
    await m.startRun('main')
    expect((await m.createTaskWorktree('t1')).ok).toBe(true)
    const dup = await m.createTaskWorktree('t1')
    expect(dup).toEqual({ ok: false, error: `worktree path already exists: ${R8}-t1` })

    g(repo, 'branch', `task/${R8}-t2`, 'main')
    const br = await m.createTaskWorktree('t2')
    expect(br).toEqual({ ok: false, error: `branch task/${R8}-t2 already exists` })
  })

  it('rejects task ids with separators or ..', async () => {
    const m = mgr()
    await m.startRun('main')
    for (const id of ['a/b', 'a\\b', '..', '../x', '', 'a..b', 'T 1']) {
      const r = await m.createTaskWorktree(id)
      expect(r, id).toEqual({ ok: false, error: 'invalid task id' })
    }
    expect(fs.readdirSync(wtRoot())).toEqual([`${R8}-integration`])
  })

  it('returns an error and creates nothing when the primary has no node_modules', async () => {
    const m = mgr()
    await m.startRun('main')
    fs.rmSync(path.join(repo, 'node_modules'), { recursive: true })
    const r = await m.createTaskWorktree('t1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/no node_modules/)
    expect(fs.existsSync(path.join(wtRoot(), `${R8}-t1`))).toBe(false)
    expect(g(repo, 'branch', '--list', 'task/*').trim()).toBe('')
  })

  it('links node_modules to the primary checkout', async () => {
    const m = mgr()
    await m.startRun('main')
    const t = await m.createTaskWorktree('t1')
    if (!t.ok) throw new Error(t.error)
    expect(fs.readFileSync(path.join(t.path, 'node_modules', 'sentinel.txt'), 'utf8')).toBe('keep\n')
  })
})

describe('mergeTask', () => {
  async function commitIn(p: string, file: string, content: string): Promise<void> {
    fs.writeFileSync(path.join(p, file), content)
    g(p, 'add', '--', file)
    g(p, 'commit', '--no-verify', '-m', `edit ${file}`)
  }

  it('merges disjoint tasks with --no-ff merge commits by the app identity', async () => {
    const m = mgr()
    await m.startRun('main')
    const a = await m.createTaskWorktree('t1')
    const b = await m.createTaskWorktree('t2')
    if (!a.ok || !b.ok) throw new Error('setup')
    await commitIn(a.path, 'one.md', '1\n')
    await commitIn(b.path, 'two.md', '2\n')
    expect(await m.mergeTask('t1')).toEqual({ ok: true, result: 'merged' })
    expect(await m.mergeTask('t2')).toEqual({ ok: true, result: 'merged' })
    const integration = path.join(wtRoot(), `${R8}-integration`)
    expect(fs.existsSync(path.join(integration, 'one.md'))).toBe(true)
    expect(fs.existsSync(path.join(integration, 'two.md'))).toBe(true)
    const merges = g(repo, 'log', `run/${R8}`, '--merges', '--format=%an <%ae>|%cn <%ce>|%P').trim().split('\n')
    expect(merges).toHaveLength(2)
    for (const line of merges) {
      const [author, committer, parents] = line.split('|')
      expect(author).toBe('claude-desk <claude-desk@localhost>')
      expect(committer).toBe('claude-desk <claude-desk@localhost>')
      expect((parents ?? '').split(' ')).toHaveLength(2)
    }
  })

  it('aborts a conflicting merge, leaves the integration worktree clean and returns conflict', async () => {
    const m = mgr()
    await m.startRun('main')
    const a = await m.createTaskWorktree('t1')
    const b = await m.createTaskWorktree('t2')
    if (!a.ok || !b.ok) throw new Error('setup')
    await commitIn(a.path, 'shared.md', 'from a\n')
    await commitIn(b.path, 'shared.md', 'from b\n')
    expect(await m.mergeTask('t1')).toEqual({ ok: true, result: 'merged' })
    expect(await m.mergeTask('t2')).toEqual({ ok: true, result: 'conflict' })
    const integration = path.join(wtRoot(), `${R8}-integration`)
    expect(g(integration, 'status', '--porcelain').trim()).toBe('')
    expect(fs.existsSync(path.join(integration, '.git'))).toBe(true)
    expect(fs.readFileSync(path.join(integration, 'shared.md'), 'utf8')).toBe('from a\n')
  })

  it('returns a plain error (not a conflict) for a branch that does not exist', async () => {
    const m = mgr()
    await m.startRun('main')
    const r = await m.mergeTask('ghost')
    expect(r.ok).toBe(false)
  })
})

describe('removal', () => {
  it('removes worktree and branch, is safe to repeat, and keeps the primary node_modules', async () => {
    const m = mgr()
    await m.startRun('main')
    const t = await m.createTaskWorktree('t1')
    if (!t.ok) throw new Error(t.error)
    expect(await m.removeTask('t1')).toEqual({ ok: true })
    expect(fs.existsSync(t.path)).toBe(false)
    expect(g(repo, 'branch', '--list', 'task/*').trim()).toBe('')
    expect(fs.readFileSync(path.join(repo, 'node_modules', 'sentinel.txt'), 'utf8')).toBe('keep\n')
    expect(await m.removeTask('t1')).toEqual({ ok: true })
  })

  it('unlinks the junction before removal with a non-recursive link primitive', async () => {
    const m = mgr()
    await m.startRun('main')
    const t = await m.createTaskWorktree('t1')
    if (!t.ok) throw new Error(t.error)
    const spy = vi.spyOn(fs, 'unlinkSync')
    expect(await m.removeTask('t1')).toEqual({ ok: true })
    const nmCalls = spy.mock.calls.filter(([p]) => String(p).endsWith('node_modules'))
    expect(nmCalls).toHaveLength(1)
    expect(fs.existsSync(path.join(repo, 'node_modules', 'sentinel.txt'))).toBe(true)
  })

  it('still removes the worktree when fs.rmSync fails on the link with ERR_FS_EISDIR (Electron)', async () => {
    const m = mgr()
    await m.startRun('main')
    const t = await m.createTaskWorktree('t1')
    if (!t.ok) throw new Error(t.error)
    const real = fs.rmSync.bind(fs)
    vi.spyOn(fs, 'rmSync').mockImplementation((p, opts) => {
      if (String(p).endsWith('node_modules')) {
        throw Object.assign(new Error('Path is a directory'), { code: 'ERR_FS_EISDIR' })
      }
      real(p, opts)
    })
    const r = await m.removeTask('t1')
    vi.restoreAllMocks()
    expect(r).toEqual({ ok: true })
    expect(fs.existsSync(t.path)).toBe(false)
    expect(g(repo, 'branch', '--list', 'task/*').trim()).toBe('')
    expect(fs.readFileSync(path.join(repo, 'node_modules', 'sentinel.txt'), 'utf8')).toBe('keep\n')
  })

  it('refuses to remove a worktree whose junction could not be unlinked', async () => {
    const m = mgr()
    await m.startRun('main')
    const t = await m.createTaskWorktree('t1')
    if (!t.ok) throw new Error(t.error)
    const real = fs.unlinkSync.bind(fs)
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw new Error('EBUSY')
    })
    const r = await m.removeTask('t1')
    vi.restoreAllMocks()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/refusing to remove/)
    expect(fs.existsSync(t.path)).toBe(true)
    expect(fs.existsSync(path.join(repo, 'node_modules', 'sentinel.txt'))).toBe(true)
    real(path.join(t.path, 'node_modules'))
  })

  describe('leftover folder after a failed removal (F7)', () => {
    /** Runs real git for the manager (so the repo and worktrees are real). */
    const realGit: GitExec = async (file, args, o) => {
      try {
        const stdout = execFileSync(file, args, {
          cwd: o.cwd,
          env: o.env,
          encoding: 'utf8',
          timeout: o.timeout,
          maxBuffer: o.maxBuffer,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        return { stdout }
      } catch (e) {
        // Like execFile: the exit status is reported as `code`.
        const err = e as Error & { status?: number | null }
        throw Object.assign(err, { code: err.status })
      }
    }
    const taskDir = (): string => path.join(wtRoot(), `${R8}-t1`)
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

    it('removes an empty folder git no longer knows (the retry after a locked removal), plus its branch', async () => {
      const m = mgr()
      await m.startRun('main')
      fs.mkdirSync(taskDir())
      g(repo, 'branch', `task/${R8}-t1`)
      expect(await m.removeTask('t1')).toEqual({ ok: true })
      expect(fs.existsSync(taskDir())).toBe(false)
      expect(g(repo, 'branch', '--list', 'task/*').trim()).toBe('')
    })

    it('recovers on retry after a failed removal left an empty folder, with a hardened prune', async () => {
      const calls: string[][] = []
      let locked = true
      const exec: GitExec = async (file, args, o) => {
        calls.push(args)
        const out = await realGit(file, args, o)
        if (locked && args.includes('worktree') && args.includes('remove')) {
          // What git does on Windows when a process holds the folder: contents gone, worktree de-registered,
          // the folder itself stays and the delete is refused.
          fs.mkdirSync(taskDir(), { recursive: true })
          throw Object.assign(new Error('git failed'), {
            stderr: `error: failed to delete '${fwd(taskDir())}': Permission denied\n`,
            code: 255
          })
        }
        return out
      }
      const m = mgr({ exec })
      await m.startRun('main')
      const t = await m.createTaskWorktree('t1')
      if (!t.ok) throw new Error(t.error)

      vi.spyOn(fs, 'rmdirSync').mockImplementation(() => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      })
      const first = await m.removeTask('t1')
      vi.restoreAllMocks()
      expect(first.ok).toBe(false)
      if (!first.ok) expect(first.error).toMatch(/Permission denied/)
      expect(fs.readdirSync(taskDir())).toEqual([])
      expect(g(repo, 'worktree', 'list')).not.toContain(`${R8}-t1`)

      locked = false
      calls.length = 0
      expect(await m.removeTask('t1')).toEqual({ ok: true })
      expect(fs.existsSync(taskDir())).toBe(false)
      expect(g(repo, 'branch', '--list', 'task/*').trim()).toBe('')
      expect(fs.readFileSync(path.join(repo, 'node_modules', 'sentinel.txt'), 'utf8')).toBe('keep\n')
      const prune = calls.filter((a) => a.includes('worktree') && a.includes('prune'))
      expect(prune.length).toBeGreaterThan(0)
      for (const a of prune) expect(a.slice(0, GIT_PREFIX.length)).toEqual([...GIT_PREFIX])
    })

    it.runIf(process.platform === 'win32')(
      'recovers after a real lock: a process holds the worktree folder, removal fails, the process exits, removal works',
      async () => {
        const m = mgr()
        await m.startRun('main')
        const t = await m.createTaskWorktree('t1')
        if (!t.ok) throw new Error(t.error)
        const locker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: t.path, stdio: 'ignore' })
        try {
          await sleep(800)
          const first = await m.removeTask('t1')
          expect(first.ok).toBe(false)
          expect(fs.existsSync(taskDir())).toBe(true)
        } finally {
          locker.kill()
          await new Promise<void>((r) => (locker.exitCode !== null ? r() : locker.once('exit', () => r())))
          await sleep(500)
        }
        expect(await m.removeTask('t1')).toEqual({ ok: true })
        expect(fs.existsSync(taskDir())).toBe(false)
        expect(g(repo, 'branch', '--list', 'task/*').trim()).toBe('')
        expect(fs.readFileSync(path.join(repo, 'node_modules', 'sentinel.txt'), 'utf8')).toBe('keep\n')
      }
    )

    it('removeRun also clears an empty leftover task folder and the integration worktree', async () => {
      const m = mgr()
      await m.startRun('main')
      fs.mkdirSync(taskDir())
      g(repo, 'branch', `task/${R8}-t1`)
      expect(await m.removeRun()).toEqual({ ok: true })
      expect(fs.readdirSync(wtRoot())).toEqual([])
      expect(g(repo, 'branch', '--list', 'task/*', 'run/*').trim()).toBe('')
    })

    it('keeps a leftover folder that is not empty and reports the failure', async () => {
      const m = mgr()
      await m.startRun('main')
      fs.mkdirSync(taskDir())
      fs.writeFileSync(path.join(taskDir(), 'keep.txt'), 'mine\n')
      const r = await m.removeTask('t1')
      expect(r.ok).toBe(false)
      expect(fs.readFileSync(path.join(taskDir(), 'keep.txt'), 'utf8')).toBe('mine\n')
    })

    it('keeps a leftover that is a link, even to an empty folder, and never touches its target', async () => {
      const m = mgr()
      await m.startRun('main')
      const target = path.join(base, 'elsewhere')
      fs.mkdirSync(target)
      fs.symlinkSync(target, taskDir(), process.platform === 'win32' ? 'junction' : 'dir')
      try {
        const r = await m.removeTask('t1')
        expect(r.ok).toBe(false)
        expect(fs.lstatSync(taskDir()).isSymbolicLink()).toBe(true)
        expect(fs.existsSync(target)).toBe(true)
      } finally {
        fs.unlinkSync(taskDir())
      }
    })
  })

  it('removeRun removes every task worktree, the integration worktree and all branches, twice', async () => {
    const m = mgr()
    await m.startRun('main')
    await m.createTaskWorktree('t1')
    await m.createTaskWorktree('t2')
    expect(await m.removeRun()).toEqual({ ok: true })
    expect(fs.readdirSync(wtRoot())).toEqual([])
    expect(g(repo, 'branch', '--list', 'task/*', 'run/*').trim()).toBe('')
    expect(fs.readFileSync(path.join(repo, 'node_modules', 'sentinel.txt'), 'utf8')).toBe('keep\n')
    expect(await m.removeRun()).toEqual({ ok: true })
  })
})

describe('hostile config', () => {
  it('writes no marker through the whole flow', async () => {
    installHostileConfig()
    const m = mgr()
    expect((await m.startRun('main')).ok).toBe(true)
    const a = await m.createTaskWorktree('t1')
    const b = await m.createTaskWorktree('t2')
    if (!a.ok || !b.ok) throw new Error('setup')
    for (const [p, f] of [
      [a.path, 'one.md'],
      [b.path, 'shared.md']
    ] as const) {
      fs.writeFileSync(path.join(p, f), `${f}\n`)
      g(p, 'add', '--', f)
      g(p, 'commit', '--no-verify', '-m', f)
    }
    expect(await m.mergeTask('t1')).toEqual({ ok: true, result: 'merged' })
    expect(await m.mergeTask('t2')).toEqual({ ok: true, result: 'merged' })
    expect((await m.removeRun()).ok).toBe(true)
    expect(fs.readdirSync(markers)).toEqual([])
  })
})

describe('git argv and env', () => {
  interface Call {
    file: string
    args: string[]
    options: GitExecOptions
  }

  function fakeExec(calls: Call[]): GitExec {
    return (file, args, options) => {
      calls.push({ file, args, options })
      const sub = args.slice(GIT_PREFIX.length)
      if (sub[0] === 'config') return Promise.reject(Object.assign(new Error('none'), { code: 1 }))
      if (sub[0] === 'rev-parse' && sub.includes('--quiet')) {
        return Promise.reject(Object.assign(new Error('none'), { code: 1 }))
      }
      if (sub[0] === 'rev-parse' && sub.includes('--end-of-options')) return Promise.resolve({ stdout: 'f'.repeat(40) + '\n' })
      return Promise.resolve({ stdout: '' })
    }
  }

  it('uses the spike argv, argument arrays, cwd, timeout, buffer cap and env', async () => {
    const calls: Call[] = []
    const r = await mgr({ exec: fakeExec(calls), env: { PATH: 'p' } }).startRun('main')
    const hash = 'f'.repeat(40)
    const integration = path.join(wtRoot(), `${R8}-integration`)
    expect(r).toEqual({ ok: true, baseHash: hash, branch: `run/${R8}`, path: integration })

    const subs = calls.map((c) => c.args.slice(GIT_PREFIX.length))
    expect(subs).toEqual([
      ['config', '--get-regexp', '-z', '^filter\\..*\\.(clean|smudge|process)$'],
      ['rev-parse', '--is-inside-work-tree'],
      ['rev-parse', '--verify', '--end-of-options', 'main^{commit}'],
      ['rev-parse', '--verify', '--quiet', `refs/heads/run/${R8}`],
      ['worktree', 'add', '-b', `run/${R8}`, integration, hash]
    ])
    for (const c of calls) {
      expect(c.file).toBe('git')
      expect(c.args.slice(0, GIT_PREFIX.length)).toEqual(GIT_PREFIX)
      expect(c.options.cwd).toBe(repo)
      expect(c.options.timeout).toBeGreaterThan(0)
      expect(c.options.maxBuffer).toBeGreaterThan(0)
      expect(c.options.env).toMatchObject({ PATH: 'p', ...GIT_ENV_ADDITIONS })
    }
  })

  it('adds filter overrides to every call and the identity to merge', async () => {
    const calls: Call[] = []
    const exec: GitExec = (file, args, options) => {
      calls.push({ file, args, options })
      const sub = args.slice(GIT_PREFIX.length)
      if (sub[0] === 'config') return Promise.resolve({ stdout: 'filter.evil.clean\ncat\0filter.evil.smudge\ncat\0' })
      return Promise.resolve({ stdout: '' })
    }
    fs.mkdirSync(path.join(wtRoot(), `${R8}-integration`), { recursive: true })
    const r = await mgr({ exec }).mergeTask('t1')
    expect(r).toEqual({ ok: true, result: 'merged' })
    const merge = calls.find((c) => c.args.includes('merge'))
    expect(merge?.args).toEqual([
      ...GIT_PREFIX,
      ...BLANK_FILTER,
      ...APP_IDENTITY,
      'merge',
      '--no-ff',
      '--no-verify',
      '-m',
      `Merge task/${R8}-t1 into run/${R8}`,
      '--',
      `task/${R8}-t1`
    ])
    expect(merge?.options.cwd).toBe(path.join(wtRoot(), `${R8}-integration`))
  })

  it('fails closed on an unsafe filter name', async () => {
    const exec: GitExec = (_f, args) =>
      args.includes('--get-regexp') ? Promise.resolve({ stdout: 'filter.a b.clean\nx\0' }) : Promise.resolve({ stdout: '' })
    const r = await mgr({ exec }).startRun('main')
    expect(r).toEqual({ ok: false, error: 'unsupported git filter config' })
  })
})
