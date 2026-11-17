import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_OUTPUT_CAP,
  GIT_TIMEOUT_MS,
  createGitHandlers,
  validatePathspec,
  type GitExec
} from './gitTools'

const PREFIX = [
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

const FILTER_LIST_ARGS = ['config', '--get-regexp', '-z', '^filter\\..*\\.(clean|smudge|process)$']
const REAL = 30_000

const isProtected = (p: string): boolean => p === '.env' || p.endsWith('.pem')

const isHelperCall = (args: string[]): boolean => args.includes('config') || args.includes('rev-parse')

/**
 * Answers the helper calls (filter listing, show-prefix) itself and hands the remaining calls the
 * given outputs in order (the last one repeats).
 */
function mockExec(
  stdouts: string | string[] = '',
  helpers: { config?: string; prefix?: string } = {}
): ReturnType<typeof vi.fn<GitExec>> {
  const queue = Array.isArray(stdouts) ? [...stdouts] : [stdouts]
  return vi.fn<GitExec>(async (_file, args) => {
    if (args.includes('config')) return { stdout: helpers.config ?? '' }
    if (args.includes('rev-parse')) return { stdout: helpers.prefix ?? '' }
    return { stdout: queue.length > 1 ? queue.shift()! : (queue[0] ?? '') }
  })
}

/** Calls other than the filter listing and the prefix lookup. */
const mainCalls = (exec: ReturnType<typeof vi.fn<GitExec>>): string[][] =>
  exec.mock.calls.map((c) => c[1]).filter((a) => !isHelperCall(a))

const filterOverrides = (name: string): string[] => [
  '-c',
  `filter.${name}.clean=`,
  '-c',
  `filter.${name}.smudge=`,
  '-c',
  `filter.${name}.process=`,
  '-c',
  `filter.${name}.required=false`
]

describe('argv', () => {
  it('git_status uses the exact argv, cwd, timeout and env', async () => {
    const exec = mockExec(' M a.txt\0')
    const h = createGitHandlers({ cwd: '/proj', isProtected, exec, env: { PATH: 'x' } })
    const r = await h.git_status({})
    expect(r.content[0]?.text).toBe(' M a.txt')
    const calls = mainCalls(exec)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([
      ...PREFIX,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
      '--no-renames',
      '--ignore-submodules=all',
      '--',
      '.'
    ])
    for (const [file, , opts] of exec.mock.calls) {
      expect(file).toBe('git')
      expect(opts.cwd).toBe('/proj')
      expect(opts.timeout).toBe(GIT_TIMEOUT_MS)
      expect(opts.maxBuffer).toBeGreaterThan(0)
      expect(opts.env).toMatchObject({
        PATH: 'x',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_PAGER: 'cat',
        GIT_EXTERNAL_DIFF: ''
      })
    }
  })

  it('lists filter config with the hardened prefix before the main call', async () => {
    const exec = mockExec('')
    await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log({})
    expect(exec.mock.calls[0]![1]).toEqual([...PREFIX, ...FILTER_LIST_ARGS])
    expect(exec.mock.calls[1]![1].slice(0, PREFIX.length)).toEqual(PREFIX)
  })

  it('neutralizes every configured filter on every run', async () => {
    const config = 'filter.evil.clean\nsh x\0filter.evil.smudge\ncat\0filter.lfs.process\ngit-lfs filter-process\0'
    const exec = mockExec(' M a.txt\0', { config })
    await createGitHandlers({ cwd: '/p', isProtected, exec }).git_status({})
    const main = mainCalls(exec)[0]!
    expect(main.slice(0, PREFIX.length + 16)).toEqual([...PREFIX, ...filterOverrides('evil'), ...filterOverrides('lfs')])
    expect(main).toContain('status')
  })

  it('treats a config exit code of 1 (no filters) as empty', async () => {
    const exec = vi.fn<GitExec>(async (_f, args) => {
      if (args.includes('config')) throw Object.assign(new Error('x'), { code: 1, stdout: '' })
      return { stdout: '' }
    })
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log({})
    expect(r.isError).toBeUndefined()
    expect(mainCalls(exec)).toHaveLength(1)
  })

  it('fails closed when the filter listing fails', async () => {
    const exec = vi.fn<GitExec>(async (_f, args) => {
      if (args.includes('config')) throw Object.assign(new Error('x'), { code: 128, stderr: 'fatal: bad' })
      return { stdout: '' }
    })
    for (const tool of ['git_status', 'git_log', 'git_diff'] as const) {
      const r = await createGitHandlers({ cwd: '/p', isProtected, exec })[tool]({})
      expect(r.isError).toBe(true)
    }
    expect(mainCalls(exec)).toHaveLength(0)
  })

  it.each([['a=b'], ['we ird'], ['x\ny'], ['é']])('fails closed on the unsafe filter name %j', async (name) => {
    const exec = mockExec('', { config: `filter.${name}.clean\ncmd\0` })
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_diff({})
    expect(r.isError).toBe(true)
    expect(mainCalls(exec)).toHaveLength(0)
  })

  it('fails closed on unparseable filter listing output', async () => {
    const exec = mockExec('', { config: 'garbage without separator' })
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_status({})
    expect(r.isError).toBe(true)
    expect(mainCalls(exec)).toHaveLength(0)
  })

  it('git_status omits protected files and reports the count', async () => {
    const h = createGitHandlers({
      cwd: '/p',
      isProtected,
      exec: mockExec(' M a.txt\0 M .env\0?? k.pem\0')
    })
    const r = await h.git_status({})
    expect(r.content[0]?.text).toBe(' M a.txt\n2 protected files omitted')
  })

  it('git_status matches protected names that old porcelain output would have quoted (F6)', async () => {
    const h = createGitHandlers({
      cwd: '/p',
      isProtected,
      exec: mockExec('?? a\tb.pem\0?? say "hi".pem\0 M ok.txt\0')
    })
    const r = await h.git_status({})
    expect(r.content[0]?.text).toBe(' M ok.txt\n2 protected files omitted')
  })

  it('git_status strips the project prefix and drops paths outside the project (F7)', async () => {
    const exec = mockExec(' M sub/a.txt\0?? other/b.txt\0 M sub/.env\0', { prefix: 'sub/\n' })
    const r = await createGitHandlers({ cwd: '/p/sub', isProtected, exec }).git_status({})
    expect(r.content[0]?.text).toBe(' M a.txt\n1 protected file omitted')
    expect(exec.mock.calls.some((c) => c[1].includes('rev-parse') && c[1].includes('--show-prefix'))).toBe(true)
  })

  it('git_log uses the exact argv with a pathspec after --', async () => {
    const exec = mockExec('abc1234 2026-01-01 Me msg\n')
    const h = createGitHandlers({ cwd: '/p', isProtected, exec })
    await h.git_log({ maxCount: 5, path: 'src/a.ts' })
    expect(mainCalls(exec)[0]).toEqual([
      ...PREFIX,
      'log',
      '--no-patch',
      '--no-ext-diff',
      '--no-textconv',
      '--format=%h %ad %an %s',
      '--date=short',
      '-n',
      '5',
      '--',
      'src/a.ts'
    ])
  })

  it('git_diff lists names then diffs explicit pathspecs', async () => {
    const exec = mockExec(['a.txt\0.env\0', 'diff --git a/a.txt b/a.txt\n'])
    const h = createGitHandlers({ cwd: '/p', isProtected, exec })
    const r = await h.git_diff({ staged: true })
    const calls = mainCalls(exec)
    expect(calls[0]).toEqual([
      ...PREFIX,
      'diff',
      '--name-only',
      '-z',
      '--relative',
      '--ignore-submodules=all',
      '--no-ext-diff',
      '--no-textconv',
      '--cached'
    ])
    expect(calls[1]).toEqual([
      ...PREFIX,
      'diff',
      '--relative',
      '--ignore-submodules=all',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--no-renames',
      '--cached',
      '--',
      'a.txt'
    ])
    expect(r.content[0]?.text).toContain('diff --git a/a.txt')
    expect(r.content[0]?.text).toContain('1 protected file omitted')
  })

  it('git_diff skips the second call when every changed file is protected', async () => {
    const exec = mockExec('.env\0')
    const h = createGitHandlers({ cwd: '/p', isProtected, exec })
    const r = await h.git_diff({})
    expect(mainCalls(exec)).toHaveLength(1)
    expect(r.content[0]?.text).toBe('No changes.\n1 protected file omitted')
  })
})

describe('git_log input', () => {
  it.each([[500], [0], [1.5], ['3']])('rejects maxCount %s without running git', async (maxCount) => {
    const exec = mockExec()
    const h = createGitHandlers({ cwd: '/p', isProtected, exec })
    const r = await h.git_log({ maxCount })
    expect(r.isError).toBe(true)
    expect(exec).not.toHaveBeenCalled()
  })

  it('never passes -p or a patch flag', async () => {
    const exec = mockExec('x')
    await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log({})
    const args = mainCalls(exec)[0]!
    expect(args).toContain('--no-patch')
    expect(args).not.toContain('-p')
    expect(args.slice(-2)).toEqual(['-n', '20'])
  })
})

describe('path validation', () => {
  it.each([['../x'], ['a/../b'], ['a\\..\\b'], ['/etc/passwd'], ['C:\\x'], ['-rf'], [':(top)x'], [''], ['a\0b']])(
    'rejects %j before execFile runs',
    async (path) => {
      for (const tool of ['git_log', 'git_diff'] as const) {
        const exec = mockExec()
        const r = await createGitHandlers({ cwd: '/p', isProtected, exec })[tool]({ path })
        expect(r.isError).toBe(true)
        expect(exec).not.toHaveBeenCalled()
      }
    }
  )

  it('rejects a protected path', async () => {
    const exec = mockExec()
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_diff({ path: '.env' })
    expect(r.isError).toBe(true)
    expect(exec).not.toHaveBeenCalled()
  })

  it('accepts a normal relative path', () => {
    expect(validatePathspec('src/a.ts')).toBeNull()
  })
})

describe('failure modes never throw', () => {
  it('reports not a git repo', async () => {
    const exec = vi.fn<GitExec>(async (_f, args) => {
      if (args.includes('config') || args.includes('rev-parse')) return { stdout: '' }
      throw Object.assign(new Error('x'), { code: 128, stderr: 'fatal: not a git repository (or any parent)' })
    })
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_status({})
    expect(r).toMatchObject({ isError: true, content: [{ text: 'not a git repo' }] })
  })

  it('reports a timeout', async () => {
    const exec = vi.fn<GitExec>().mockRejectedValue(Object.assign(new Error('t'), { killed: true, signal: 'SIGTERM' }))
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log({})
    expect(r).toMatchObject({ isError: true, content: [{ text: 'git timed out' }] })
  })

  it('marks truncation when the buffer overflows', async () => {
    const exec = vi.fn<GitExec>(async (_f, args) => {
      if (args.includes('config')) return { stdout: '' }
      throw Object.assign(new Error('b'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: 'partial' })
    })
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log({})
    expect(r.isError).toBeUndefined()
    expect(r.content[0]?.text).toBe('partial\n[output truncated]')
  })

  it('truncates output above the cap', async () => {
    const exec = mockExec('x'.repeat(GIT_OUTPUT_CAP + 10))
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log({})
    expect(r.content[0]?.text.endsWith('[output truncated]')).toBe(true)
    expect(r.content[0]!.text.length).toBeLessThan(GIT_OUTPUT_CAP + 50)
  })

  it('maps an unknown error to a short message', async () => {
    const exec = vi.fn<GitExec>().mockRejectedValue('boom')
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_status({})
    expect(r.isError).toBe(true)
  })
})

describe('real temp repo', () => {
  let dir = ''
  let extra = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    if (extra) rmSync(extra, { recursive: true, force: true })
    dir = ''
    extra = ''
  })

  const gitIn =
    (cwd: string) =>
    (...a: string[]): string =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'protocol.file.allow=always', ...a], {
        cwd,
        encoding: 'utf8',
        input: ''
      })
  const fwd = (p: string): string => p.replace(/\\/g, '/')

  function initRepo(): (...a: string[]) => string {
    dir = mkdtempSync(join(tmpdir(), 'gittools-'))
    const git = gitIn(dir)
    git('init', '-q')
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    writeFileSync(join(dir, '.env'), 'S=1\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    return git
  }

  it('diffs only the unprotected modified file', { timeout: REAL }, async () => {
    initRepo()
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    writeFileSync(join(dir, '.env'), 'S=2\n')

    const h = createGitHandlers({ cwd: dir, isProtected })
    const r = await h.git_diff({})
    const text = r.content[0]!.text
    expect(text).toContain('a.txt')
    expect(text).toContain('+two')
    expect(text).not.toContain('S=2')
    expect(text).toContain('1 protected file omitted')

    const s = await h.git_status({})
    const lines = s.content[0]!.text.split('\n')
    expect(lines).toContain(' M a.txt')
    expect(lines.some((l) => l.endsWith('.env'))).toBe(false)
    expect(s.content[0]!.text).not.toMatch(/\.env$/m)
  })

  it('works when the project is a subfolder of the repo (F7)', { timeout: REAL }, async () => {
    dir = mkdtempSync(join(tmpdir(), 'gittools-'))
    const git = gitIn(dir)
    git('init', '-q')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'a.txt'), 'one\n')
    writeFileSync(join(dir, 'sub', '.env'), 'S=1\n')
    writeFileSync(join(dir, 'root.txt'), 'one\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    writeFileSync(join(dir, 'sub', 'a.txt'), 'two\n')
    writeFileSync(join(dir, 'sub', '.env'), 'S=2\n')
    writeFileSync(join(dir, 'root.txt'), 'two-root\n')
    writeFileSync(join(dir, 'sub', 'k.pem'), 'untracked\n')

    const h = createGitHandlers({ cwd: join(dir, 'sub'), isProtected })
    const d = (await h.git_diff({})).content[0]!.text
    expect(d).toContain('+two')
    expect(d).not.toContain('S=2')
    expect(d).not.toContain('root')
    expect(d).toContain('1 protected file omitted')
    const one = (await h.git_diff({ path: 'a.txt' })).content[0]!.text
    expect(one).toContain('+two')

    const s = (await h.git_status({})).content[0]!.text
    expect(s.split('\n')).toContain(' M a.txt')
    expect(s).not.toContain('sub/')
    expect(s).not.toContain('root.txt')
    expect(s).not.toMatch(/\.env$/m)
    expect(s).not.toMatch(/\.pem$/m)
    expect(s).toContain('2 protected files omitted')
  })

  describe('hostile config', () => {
    const marker = (name: string): string => join(extra, name)

    function setupFilter(): void {
      initRepo()
      extra = mkdtempSync(join(tmpdir(), 'gittools-m-'))
      const git = gitIn(dir)
      writeFileSync(join(dir, '.gitattributes'), '* filter=evil\n')
      git('config', 'filter.evil.clean', `echo x > "${fwd(marker('filter'))}"; cat`)
      git('config', 'filter.evil.smudge', `echo x > "${fwd(marker('filter'))}"; cat`)
      writeFileSync(join(dir, 'a.txt'), 'changed contents here\n')
    }

    it('does not run a filter driver in git_diff (S1)', { timeout: REAL }, async () => {
      setupFilter()
      const r = await createGitHandlers({ cwd: dir, isProtected }).git_diff({})
      expect(r.isError).toBeUndefined()
      expect(r.content[0]!.text).toContain('+changed contents here')
      expect(existsSync(marker('filter'))).toBe(false)
      const r2 = await createGitHandlers({ cwd: dir, isProtected }).git_diff({ path: 'a.txt' })
      expect(r2.isError).toBeUndefined()
      expect(existsSync(marker('filter'))).toBe(false)
    })

    it('does not run a filter driver in git_status (S1)', { timeout: REAL }, async () => {
      setupFilter()
      const r = await createGitHandlers({ cwd: dir, isProtected }).git_status({})
      expect(r.isError).toBeUndefined()
      expect(r.content[0]!.text).toContain('a.txt')
      expect(existsSync(marker('filter'))).toBe(false)
    })

    it('does not run a filter driver in git_log (S1)', { timeout: REAL }, async () => {
      setupFilter()
      const r = await createGitHandlers({ cwd: dir, isProtected }).git_log({})
      expect(r.isError).toBeUndefined()
      expect(existsSync(marker('filter'))).toBe(false)
    })

    it('does not run a filter set through core.attributesFile (S1)', { timeout: REAL }, async () => {
      initRepo()
      extra = mkdtempSync(join(tmpdir(), 'gittools-m-'))
      const git = gitIn(dir)
      writeFileSync(join(extra, 'attrs'), '* filter=evil\n')
      git('config', 'core.attributesFile', fwd(join(extra, 'attrs')))
      git('config', 'filter.evil.clean', `echo x > "${fwd(marker('filter'))}"; cat`)
      writeFileSync(join(dir, 'a.txt'), 'changed contents here\n')
      const h = createGitHandlers({ cwd: dir, isProtected })
      await h.git_diff({})
      await h.git_status({})
      expect(existsSync(marker('filter'))).toBe(false)
    })

    it('does not run fsmonitor, ext-diff or textconv (spike cases)', { timeout: REAL }, async () => {
      initRepo()
      extra = mkdtempSync(join(tmpdir(), 'gittools-m-'))
      const git = gitIn(dir)
      const touch = (n: string): string => `echo x > "${fwd(marker(n))}"`
      writeFileSync(join(dir, '.gitattributes'), '*.txt diff=x\n')
      git('config', 'core.fsmonitor', touch('fsmonitor'))
      git('config', 'diff.external', touch('ext'))
      git('config', 'diff.x.command', touch('drvcmd'))
      git('config', 'diff.x.textconv', touch('textconv'))
      writeFileSync(join(dir, 'a.txt'), 'changed contents here\n')
      const h = createGitHandlers({ cwd: dir, isProtected })
      await h.git_diff({})
      await h.git_status({})
      await h.git_log({})
      for (const n of ['fsmonitor', 'ext', 'drvcmd', 'textconv']) expect(existsSync(marker(n))).toBe(false)
    })

    it('does not run gpg.program for a forged gpgsig commit (S2)', { timeout: REAL }, async () => {
      initRepo()
      extra = mkdtempSync(join(tmpdir(), 'gittools-m-'))
      const git = gitIn(dir)
      const script = join(extra, 'gpg.sh')
      writeFileSync(script, `#!/bin/sh\necho x > "${fwd(marker('gpg'))}"\nexit 1\n`)
      chmodSync(script, 0o755)
      const tree = git('rev-parse', 'HEAD^{tree}').trim()
      const parent = git('rev-parse', 'HEAD').trim()
      const body =
        `tree ${tree}\nparent ${parent}\nauthor t <t@t> 1700000000 +0000\ncommitter t <t@t> 1700000000 +0000\n` +
        'gpgsig -----BEGIN PGP SIGNATURE-----\n \n abcdef\n -----END PGP SIGNATURE-----\n\nsigned\n'
      const sha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
        cwd: dir,
        encoding: 'utf8',
        input: body
      }).trim()
      git('update-ref', 'HEAD', sha)
      git('config', 'log.showSignature', 'true')
      git('config', 'gpg.program', fwd(script))
      git('config', 'gpg.ssh.program', fwd(script))
      git('config', 'gpg.x509.program', fwd(script))

      const r = await createGitHandlers({ cwd: dir, isProtected }).git_log({})
      expect(r.isError).toBeUndefined()
      expect(r.content[0]!.text).toContain('signed')
      expect(existsSync(marker('gpg'))).toBe(false)
    })

    it('does not run fsmonitor or filters of a submodule (status and diff)', { timeout: REAL }, async () => {
      dir = mkdtempSync(join(tmpdir(), 'gittools-'))
      extra = mkdtempSync(join(tmpdir(), 'gittools-m-'))
      const sub = join(extra, 'subsrc')
      mkdirSync(sub)
      const gs = gitIn(sub)
      gs('init', '-q')
      writeFileSync(join(sub, 's.txt'), 's\n')
      gs('add', '.')
      gs('commit', '-q', '-m', 's')
      const git = gitIn(dir)
      git('init', '-q')
      git('submodule', 'add', '-q', fwd(sub), 'mod')
      git('commit', '-q', '-m', 'add sub')
      const inner = join(dir, 'mod')
      gitIn(inner)('config', 'core.fsmonitor', `echo x > "${fwd(marker('subfsm'))}"`)
      writeFileSync(join(inner, 's.txt'), 'modified\n')
      writeFileSync(join(inner, 'new.txt'), 'untracked\n')
      // Control: the naive command does reach the submodule's own config.
      git('status', '--porcelain')
      expect(existsSync(marker('subfilter')) || existsSync(marker('subfsm'))).toBe(true)
      rmSync(marker('subfilter'), { force: true })
      rmSync(marker('subfsm'), { force: true })

      const h = createGitHandlers({ cwd: dir, isProtected })
      await h.git_status({})
      await h.git_diff({})
      expect(existsSync(marker('subfsm'))).toBe(false)
      expect(existsSync(marker('subfilter'))).toBe(false)
    })
  })
})
