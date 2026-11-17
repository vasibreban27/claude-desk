import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GIT_OUTPUT_CAP, createGitHandlers, validatePathspec, type GitExec } from './gitTools'

const REAL = 30_000
const isProtected = (p: string): boolean => p === '.env' || p.endsWith('.pem')
const isHelper = (args: string[]): boolean => args.includes('config') || args.includes('rev-parse')

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
const mainCalls = (exec: ReturnType<typeof vi.fn<GitExec>>): string[][] =>
  exec.mock.calls.map((c) => c[1]).filter((a) => !isHelper(a))
const text = (r: { content: { text: string }[] }): string => r.content[0]!.text

describe('git tools gaps: handler input validation', () => {
  it.each([[null], [undefined], [{}], [{ unknown: 1 }]])('git_log accepts %j as "no arguments"', async (input) => {
    const exec = mockExec('abc msg')
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log(input)
    expect(r.isError).toBeUndefined()
    expect(mainCalls(exec)[0]!.slice(-2)).toEqual(['-n', '20'])
  })

  it.each([['str'], [5], [[]], [true]])('git_log rejects the non-object input %j without running git', async (input) => {
    const exec = mockExec()
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log(input)
    expect(r.isError).toBe(true)
    expect(exec).not.toHaveBeenCalled()
  })

  it.each([[1], [100]])('git_log accepts the maxCount boundary %s', async (maxCount) => {
    const exec = mockExec('x')
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log({ maxCount })
    expect(r.isError).toBeUndefined()
    expect(mainCalls(exec)[0]!.slice(-2)).toEqual(['-n', String(maxCount)])
  })

  it.each([[-1], [101], [Number.NaN], [Number.POSITIVE_INFINITY], [null], ['10'], [1e21]])(
    'git_log rejects maxCount %s',
    async (maxCount) => {
      const exec = mockExec()
      const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log({ maxCount })
      expect(r.isError).toBe(true)
      expect(exec).not.toHaveBeenCalled()
    }
  )

  it.each([[5], [null], [['a']], [{}], [true]])('git_log and git_diff reject a non-string path %j', async (path) => {
    for (const tool of ['git_log', 'git_diff'] as const) {
      const exec = mockExec()
      const r = await createGitHandlers({ cwd: '/p', isProtected, exec })[tool]({ path })
      expect(r.isError, tool).toBe(true)
      expect(exec).not.toHaveBeenCalled()
    }
  })

  it.each([['yes'], [1], [null], ['true']])('git_diff rejects a non-boolean staged %j', async (staged) => {
    const exec = mockExec()
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_diff({ staged })
    expect(r.isError).toBe(true)
    expect(exec).not.toHaveBeenCalled()
  })

  it.each([[null], [undefined], [{}]])('git_diff accepts %j and diffs the working tree', async (input) => {
    const exec = mockExec(['a.txt\0', 'patch'])
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_diff(input)
    expect(r.isError).toBeUndefined()
    expect(mainCalls(exec)[0]).not.toContain('--cached')
  })

  it('git_diff staged:false does not pass --cached', async () => {
    const exec = mockExec(['a.txt\0', 'patch'])
    await createGitHandlers({ cwd: '/p', isProtected, exec }).git_diff({ staged: false })
    for (const call of mainCalls(exec)) expect(call).not.toContain('--cached')
  })

  it('path length boundary: 500 accepted, 501 rejected', async () => {
    expect(validatePathspec('a'.repeat(500))).toBeNull()
    expect(validatePathspec('a'.repeat(501))).not.toBeNull()
    const exec = mockExec()
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log({ path: 'a'.repeat(501) })
    expect(r.isError).toBe(true)
    expect(exec).not.toHaveBeenCalled()
  })

  it.each([
    ['\\server\\share'],
    ['\\\\?\\C:\\x'],
    ['//server/share'],
    ['a/b/..'],
    ['..'],
    ['a/..\\b'],
    ['--output=x'],
    [':!x'],
    ['D:/x'],
    ['d:x'],
    ['C:.env'],
    ['a:b']
  ])('validatePathspec rejects %j', (p) => {
    expect(validatePathspec(p)).not.toBeNull()
  })

  it.each([['.'], ['a b/c d.txt'], ['..hidden'], ['a/..b/c'], ['é/ü.ts'], ['src/*.ts'], ['ab:c'], ['a/b:c']])(
    'validatePathspec accepts %j',
    (p) => {
      expect(validatePathspec(p)).toBeNull()
    }
  )

  it('hands isProtected a forward-slash path even when the caller used backslashes', async () => {
    const seen: string[] = []
    const exec = mockExec()
    const h = createGitHandlers({
      cwd: '/p',
      isProtected: (p) => {
        seen.push(p)
        return false
      },
      exec
    })
    await h.git_log({ path: 'sub\\dir\\f.txt' })
    expect(seen).toEqual(['sub/dir/f.txt'])
  })

  it('rejects a backslash spelling of a protected nested path', async () => {
    const exec = mockExec()
    const r = await createGitHandlers({
      cwd: '/p',
      isProtected: (p) => p === 'secrets/k.txt',
      exec
    }).git_log({ path: 'secrets\\k.txt' })
    expect(r).toMatchObject({ isError: true, content: [{ text: 'path is protected' }] })
    expect(exec).not.toHaveBeenCalled()
  })

  it('a throwing isProtected callback surfaces as a rejection, not a leaked git call', async () => {
    const exec = mockExec()
    const h = createGitHandlers({
      cwd: '/p',
      isProtected: () => {
        throw new Error('matcher broke')
      },
      exec
    })
    await expect(h.git_log({ path: 'a.txt' })).rejects.toThrow('matcher broke')
    expect(mainCalls(exec)).toHaveLength(0)
  })
})

describe('git tools gaps: output cap boundary', () => {
  it('exactly GIT_OUTPUT_CAP characters is returned whole without a marker', async () => {
    const out = 'x'.repeat(GIT_OUTPUT_CAP)
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec: mockExec(out) }).git_log({})
    expect(text(r)).toBe(out)
  })

  it('one character over the cap is cut to the cap and marked', async () => {
    const r = await createGitHandlers({
      cwd: '/p',
      isProtected,
      exec: mockExec('y'.repeat(GIT_OUTPUT_CAP + 1))
    }).git_log({})
    expect(text(r)).toBe('y'.repeat(GIT_OUTPUT_CAP) + '\n[output truncated]')
  })

  it('whitespace-only output reports the empty message', async () => {
    expect(text(await createGitHandlers({ cwd: '/p', isProtected, exec: mockExec('  \n\n ') }).git_log({}))).toBe(
      'No commits.'
    )
    expect(text(await createGitHandlers({ cwd: '/p', isProtected, exec: mockExec('\0') }).git_status({}))).toBe(
      'Working tree clean.'
    )
  })

  it('an over-cap diff still lists the omitted-files note after the truncation marker', async () => {
    const exec = mockExec(['a.txt\0.env\0', 'z'.repeat(GIT_OUTPUT_CAP + 5)])
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_diff({})
    expect(text(r).endsWith('\n[output truncated]\n1 protected file omitted')).toBe(true)
  })

  it('overflow on the main diff call is marked as truncated, keeping the partial output', async () => {
    const exec = vi.fn<GitExec>(async (_f, args) => {
      if (args.includes('config')) return { stdout: '' }
      if (args.includes('--name-only')) return { stdout: 'a.txt\0' }
      throw Object.assign(new Error('b'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: 'part' })
    })
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_diff({})
    expect(text(r)).toBe('part\n[output truncated]')
  })

  it('overflow while listing names fails instead of diffing a partial list', async () => {
    const exec = vi.fn<GitExec>(async (_f, args) => {
      if (args.includes('config')) return { stdout: '' }
      throw Object.assign(new Error('b'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: 'a.txt\0.en' })
    })
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_diff({})
    expect(r).toMatchObject({ isError: true, content: [{ text: 'too many files' }] })
    expect(exec.mock.calls.filter((c) => !isHelper(c[1]))).toHaveLength(1)
  })

  it('overflow with a non-string stdout still yields a truncation marker', async () => {
    const exec = vi.fn<GitExec>(async (_f, args) => {
      if (args.includes('config')) return { stdout: '' }
      throw Object.assign(new Error('b'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: undefined })
    })
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log({})
    expect(r.isError).toBeUndefined()
    expect(text(r)).toBe('No commits.\n[output truncated]')
  })

  it('git_status marks truncation and keeps the omitted-files note on overflow', async () => {
    const exec = vi.fn<GitExec>(async (_f, args) => {
      if (args.includes('config')) return { stdout: '' }
      if (args.includes('rev-parse')) return { stdout: '' }
      throw Object.assign(new Error('b'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: ' M a.txt\0 M .env\0' })
    })
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_status({})
    expect(text(r)).toBe(' M a.txt\n[output truncated]\n1 protected file omitted')
  })
})

describe('git tools gaps: diff file-list limits and failures', () => {
  const names = (n: number): string => Array.from({ length: n }, (_v, i) => `f${i}.txt`).join('\0') + '\0'

  it('500 changed files are diffed, 501 are refused without a second call', async () => {
    const ok = mockExec([names(500), 'patch'])
    const r500 = await createGitHandlers({ cwd: '/p', isProtected, exec: ok }).git_diff({})
    expect(r500.isError).toBeUndefined()
    expect(mainCalls(ok)).toHaveLength(2)

    const many = mockExec(names(501))
    const r501 = await createGitHandlers({ cwd: '/p', isProtected, exec: many }).git_diff({})
    expect(r501).toMatchObject({ isError: true, content: [{ text: 'too many files' }] })
    expect(mainCalls(many)).toHaveLength(1)
  })

  it('protected files do not count towards the 500 limit', async () => {
    const list = names(500) + 'a.pem\0b.pem\0'
    const exec = mockExec([list, 'patch'])
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_diff({})
    expect(r.isError).toBeUndefined()
    expect(text(r)).toBe('patch\n2 protected files omitted')
  })

  it('passes file names with spaces, dashes and newlines verbatim after --', async () => {
    const exec = mockExec(['-rf\0a b.txt\0line\nbreak.txt\0', 'patch'])
    await createGitHandlers({ cwd: '/p', isProtected, exec }).git_diff({})
    const second = mainCalls(exec)[1]!
    const sep = second.indexOf('--')
    expect(sep).toBeGreaterThan(-1)
    expect(second.slice(sep)).toEqual(['--', '-rf', 'a b.txt', 'line\nbreak.txt'])
  })

  it('an error on the second diff call is reported, not swallowed', async () => {
    const exec = vi.fn<GitExec>(async (_f, args) => {
      if (args.includes('config')) return { stdout: '' }
      if (args.includes('--name-only')) return { stdout: 'a.txt\0' }
      throw Object.assign(new Error('x'), { code: 128, stderr: 'fatal: bad object' })
    })
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_diff({})
    expect(r).toMatchObject({ isError: true, content: [{ text: 'git failed: fatal: bad object' }] })
  })

  it('a changed-file list with no entries reports no changes and no omitted note', async () => {
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec: mockExec('') }).git_diff({})
    expect(text(r)).toBe('No changes.')
  })

  it('the stderr in an error message is trimmed and limited to 200 characters', async () => {
    const exec = vi.fn<GitExec>(async (_f, args) => {
      if (args.includes('config') || args.includes('rev-parse')) return { stdout: '' }
      throw Object.assign(new Error('x'), { code: 2, stderr: `  ${'e'.repeat(500)}\n` })
    })
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_status({})
    expect(text(r)).toBe(`git failed: ${'e'.repeat(200)}`)
  })

  it.each([[null], [undefined], [0], ['boom'], [{}]])('a rejection of %j never throws out of a handler', async (rejection) => {
    const exec = vi.fn<GitExec>().mockRejectedValue(rejection)
    const h = createGitHandlers({ cwd: '/p', isProtected, exec })
    for (const tool of ['git_status', 'git_log', 'git_diff'] as const) {
      const r = await h[tool]({})
      expect(r.isError, tool).toBe(true)
    }
  })

  it('ENOENT is reported as git not installed, also from the rev-parse call', async () => {
    const exec = vi.fn<GitExec>().mockRejectedValue(Object.assign(new Error('spawn git'), { code: 'ENOENT' }))
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_status({})
    expect(text(r)).toBe('git is not installed')
  })

  it('a timeout while listing filters is reported as a timeout and runs nothing else', async () => {
    const exec = vi.fn<GitExec>(async (_f, args) => {
      if (args.includes('config')) throw Object.assign(new Error('t'), { killed: true, signal: 'SIGTERM' })
      return { stdout: '' }
    })
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log({})
    expect(text(r)).toBe('git timed out')
    expect(mainCalls(exec)).toHaveLength(0)
  })

  it('git_status in a non-repo reports it from the rev-parse call', async () => {
    const exec = vi.fn<GitExec>().mockRejectedValue(
      Object.assign(new Error('x'), { code: 128, stderr: 'fatal: not a git repository' })
    )
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_status({})
    expect(text(r)).toBe('not a git repo')
    expect(exec).toHaveBeenCalledTimes(1)
  })
})

describe('git tools gaps: git_status shapes', () => {
  it('only protected entries: clean message plus the omitted note', async () => {
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec: mockExec(' M .env\0?? k.pem\0') }).git_status({})
    expect(text(r)).toBe('Working tree clean.\n2 protected files omitted')
  })

  it('handles a CRLF-terminated prefix', async () => {
    const exec = mockExec(' M sub/a.txt\0', { prefix: 'sub/\r\n' })
    const r = await createGitHandlers({ cwd: '/p/sub', isProtected, exec }).git_status({})
    expect(text(r)).toBe(' M a.txt')
  })

  it('a sibling directory sharing the prefix text is not shown', async () => {
    const exec = mockExec(' M sub2/a.txt\0 M sub/a.txt\0', { prefix: 'sub/\n' })
    const r = await createGitHandlers({ cwd: '/p/sub', isProtected, exec }).git_status({})
    expect(text(r)).toBe(' M a.txt')
  })

  it('a protected name nested under the prefix is matched on the project-relative path', async () => {
    const seen: string[] = []
    const exec = mockExec(' M sub/deep/x.txt\0', { prefix: 'sub/\n' })
    await createGitHandlers({
      cwd: '/p/sub',
      isProtected: (p) => (seen.push(p), false),
      exec
    }).git_status({})
    expect(seen).toEqual(['deep/x.txt'])
  })
})

describe('git tools gaps: filter names', () => {
  const cfg = (...keys: string[]): string => keys.map((k) => `${k}\nvalue`).join('\0') + '\0'
  const overrideFor = (n: string): string[] => [
    '-c',
    `filter.${n}.clean=`,
    '-c',
    `filter.${n}.smudge=`,
    '-c',
    `filter.${n}.process=`,
    '-c',
    `filter.${n}.required=false`
  ]

  it.each([['my-lfs'], ['a.b'], ['a_b'], ['A1'], ['-dash'], ['.dot'], ['x.y.z-1_2']])(
    'blanks a driver named %j',
    async (name) => {
      const exec = mockExec('', { config: cfg(`filter.${name}.clean`) })
      await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log({})
      const main = mainCalls(exec)[0]!
      const first = main.indexOf('-c', main.indexOf('gpg.x509.program=') + 1)
      expect(main.slice(first, first + 8)).toEqual(overrideFor(name))
    }
  )

  it('blanks each name once even when it has several keys, and dedupes across calls', async () => {
    const exec = mockExec('', {
      config: cfg('filter.lfs.clean', 'filter.lfs.smudge', 'filter.lfs.process', 'filter.lfs.clean')
    })
    await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log({})
    const main = mainCalls(exec)[0]!
    expect(main.filter((a) => a === 'filter.lfs.clean=')).toHaveLength(1)
    expect(main.filter((a) => a === 'filter.lfs.required=false')).toHaveLength(1)
  })

  it('matches the key case-insensitively (git lowercases section and variable names)', async () => {
    const exec = mockExec('', { config: cfg('FILTER.Evil.CLEAN') })
    await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log({})
    expect(mainCalls(exec)[0]).toContain('filter.Evil.clean=')
  })

  it.each([
    ['empty name', 'filter..clean'],
    ['dollar', 'filter.$(x).clean'],
    ['backslash', 'filter.a\\b.clean'],
    ['quote', 'filter.a"b.clean'],
    ['semicolon', 'filter.a;b.clean'],
    ['wrong variable', 'filter.x.required'],
    ['wrong section', 'diff.x.clean'],
    ['no variable', 'filter.x'],
    ['tab', 'filter.a\tb.clean'],
    ['NUL-free CR', 'filter.a\rb.clean']
  ])('fails closed on %s', async (_n, key) => {
    const exec = mockExec('', { config: `${key}\nv\0` })
    for (const tool of ['git_status', 'git_log', 'git_diff'] as const) {
      const r = await createGitHandlers({ cwd: '/p', isProtected, exec })[tool]({})
      expect(r, tool).toMatchObject({ isError: true, content: [{ text: 'unsupported git filter config' }] })
    }
    expect(mainCalls(exec)).toHaveLength(0)
  })

  it('a single unsafe name poisons the whole listing even after safe ones', async () => {
    const exec = mockExec('', { config: cfg('filter.ok.clean', 'filter.b d.clean') })
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log({})
    expect(r.isError).toBe(true)
    expect(mainCalls(exec)).toHaveLength(0)
  })

  it('a listing with only empty entries means no filters', async () => {
    const exec = mockExec('', { config: '\0\0' })
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log({})
    expect(r.isError).toBeUndefined()
    expect(mainCalls(exec)[0]).not.toContain('filter.')
  })

  it('the filter listing runs before every tool call, so a filter added between calls is caught', async () => {
    let config = ''
    const exec = vi.fn<GitExec>(async (_f, args) => {
      if (args.includes('config')) return { stdout: config }
      return { stdout: '' }
    })
    const h = createGitHandlers({ cwd: '/p', isProtected, exec })
    await h.git_log({})
    config = 'filter.late.clean\nx\0'
    await h.git_log({})
    const mains = mainCalls(exec)
    expect(mains[0]).not.toContain('filter.late.clean=')
    expect(mains[1]).toContain('filter.late.clean=')
  })
})

describe('git tools gaps: environment', () => {
  it('forces the safety variables over a hostile caller environment', async () => {
    const exec = mockExec('')
    await createGitHandlers({
      cwd: '/p',
      isProtected,
      exec,
      env: {
        GIT_PAGER: 'evil',
        GIT_EXTERNAL_DIFF: 'evil',
        GIT_OPTIONAL_LOCKS: '1',
        GIT_TERMINAL_PROMPT: '1',
        GIT_CONFIG_NOSYSTEM: '0',
        GIT_LITERAL_PATHSPECS: '0',
        KEEP: 'me'
      }
    }).git_log({})
    for (const call of exec.mock.calls) {
      expect(call[2].env).toMatchObject({
        GIT_PAGER: 'cat',
        GIT_EXTERNAL_DIFF: '',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_LITERAL_PATHSPECS: '1',
        KEEP: 'me'
      })
    }
  })

  it('does not mutate the caller env object', async () => {
    const env = { GIT_PAGER: 'less' }
    await createGitHandlers({ cwd: '/p', isProtected, exec: mockExec(''), env }).git_log({})
    expect(env).toEqual({ GIT_PAGER: 'less' })
  })

  it('passes the same cwd to the filter listing, rev-parse and main calls', async () => {
    const exec = mockExec('')
    await createGitHandlers({ cwd: '/the/proj', isProtected, exec }).git_status({})
    expect(exec.mock.calls.length).toBeGreaterThanOrEqual(3)
    for (const call of exec.mock.calls) expect(call[2].cwd).toBe('/the/proj')
  })
})

describe('git tools gaps: real git', () => {
  let dirs: string[] = []
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs = []
  })
  const mk = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(d)
    return d
  }
  const git = (cwd: string, ...a: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', input: '' })

  it('reports a plain directory as not a git repo', { timeout: REAL }, async (ctx) => {
    const dir = mk('gt-nogit-')
    try {
      git(dir, 'rev-parse', '--git-dir')
      return ctx.skip() // the temp dir sits inside a repository on this machine
    } catch {
      // expected: not a repository
    }
    const h = createGitHandlers({ cwd: dir, isProtected })
    for (const tool of ['git_status', 'git_log', 'git_diff'] as const) {
      const r = await h[tool]({})
      expect(r.isError, tool).toBe(true)
      expect(text(r), tool).toBe('not a git repo')
    }
  })

  it('a filter with dots, dashes and uppercase in its name is blanked (S1 edge)', { timeout: REAL }, async () => {
    const dir = mk('gt-filter-')
    const out = mk('gt-filter-m-')
    const marker = join(out, 'ran').replace(/\\/g, '/')
    git(dir, 'init', '-q')
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'init')
    writeFileSync(join(dir, '.gitattributes'), '* filter=My.Evil-x_1\n')
    git(dir, 'config', 'filter.My.Evil-x_1.clean', `echo x > "${marker}"; cat`)
    git(dir, 'config', 'filter.My.Evil-x_1.smudge', `echo x > "${marker}"; cat`)
    writeFileSync(join(dir, 'a.txt'), 'changed and longer\n')
    const h = createGitHandlers({ cwd: dir, isProtected })
    const d = await h.git_diff({})
    const s = await h.git_status({})
    const l = await h.git_log({})
    expect(d.isError).toBeUndefined()
    expect(s.isError).toBeUndefined()
    expect(l.isError).toBeUndefined()
    expect(existsSync(marker)).toBe(false)
  })

  it('shows files with spaces and non-ASCII names and hides protected ones', { timeout: REAL }, async () => {
    const dir = mk('gt-names-')
    git(dir, 'init', '-q')
    writeFileSync(join(dir, 'a b.txt'), 'one\n')
    writeFileSync(join(dir, 'é.txt'), 'one\n')
    writeFileSync(join(dir, 'sp ace.pem'), 'k\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'init')
    writeFileSync(join(dir, 'a b.txt'), 'two\n')
    writeFileSync(join(dir, 'é.txt'), 'two\n')
    writeFileSync(join(dir, 'sp ace.pem'), 'SECRET\n')
    const h = createGitHandlers({ cwd: dir, isProtected })
    const d = text(await h.git_diff({}))
    expect(d).toContain('+two')
    expect(d).toContain('a b.txt')
    expect(d).toContain('é.txt')
    expect(d).not.toContain('SECRET')
    expect(d).toContain('1 protected file omitted')
    const s = text(await h.git_status({}))
    expect(s.split('\n')).toEqual(expect.arrayContaining([' M a b.txt', ' M é.txt']))
    expect(s).not.toContain('.pem')
  })

  it('git_log with a path limits history to that path', { timeout: REAL }, async () => {
    const dir = mk('gt-logpath-')
    git(dir, 'init', '-q')
    writeFileSync(join(dir, 'a.txt'), '1\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'first-a')
    writeFileSync(join(dir, 'b.txt'), '1\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'only-b')
    const h = createGitHandlers({ cwd: dir, isProtected })
    const r = text(await h.git_log({ path: 'a.txt' }))
    expect(r).toContain('first-a')
    expect(r).not.toContain('only-b')
    // GIT_LITERAL_PATHSPECS: a glob is a literal name and matches nothing
    expect(text(await h.git_log({ path: '*.txt' }))).toBe('No commits.')
  })
})
