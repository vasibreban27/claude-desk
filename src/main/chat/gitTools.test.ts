import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  'core.quotepath=false'
]

const isProtected = (p: string): boolean => p === '.env' || p.endsWith('.pem')

function mockExec(stdout = ''): ReturnType<typeof vi.fn<GitExec>> {
  return vi.fn<GitExec>(async () => ({ stdout }))
}

describe('argv', () => {
  it('git_status uses the exact argv, cwd, timeout and env', async () => {
    const exec = mockExec(' M a.txt\n')
    const h = createGitHandlers({ cwd: '/proj', isProtected, exec, env: { PATH: 'x' } })
    const r = await h.git_status({})
    expect(r.content[0]?.text).toBe(' M a.txt')
    expect(exec).toHaveBeenCalledTimes(1)
    const [file, args, opts] = exec.mock.calls[0]!
    expect(file).toBe('git')
    expect(args).toEqual([
      ...PREFIX,
      'status',
      '--short',
      '--porcelain=v1',
      '--untracked-files=normal',
      '--no-renames'
    ])
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
  })

  it('git_status omits protected files and reports the count', async () => {
    const h = createGitHandlers({ cwd: '/p', isProtected, exec: mockExec(' M a.txt\n M .env\n?? k.pem\n') })
    const r = await h.git_status({})
    expect(r.content[0]?.text).toBe(' M a.txt\n2 protected files omitted')
  })

  it('git_log uses the exact argv with a pathspec after --', async () => {
    const exec = mockExec('abc1234 2026-01-01 Me msg\n')
    const h = createGitHandlers({ cwd: '/p', isProtected, exec })
    await h.git_log({ maxCount: 5, path: 'src/a.ts' })
    expect(exec.mock.calls[0]![1]).toEqual([
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
    const exec = vi
      .fn<GitExec>()
      .mockResolvedValueOnce({ stdout: 'a.txt\0.env\0' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/a.txt b/a.txt\n' })
    const h = createGitHandlers({ cwd: '/p', isProtected, exec })
    const r = await h.git_diff({ staged: true })
    expect(exec.mock.calls[0]![1]).toEqual([
      ...PREFIX,
      'diff',
      '--name-only',
      '-z',
      '--no-ext-diff',
      '--no-textconv',
      '--cached'
    ])
    expect(exec.mock.calls[1]![1]).toEqual([
      ...PREFIX,
      'diff',
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
    expect(exec).toHaveBeenCalledTimes(1)
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
    const args = exec.mock.calls[0]![1]
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
    const exec = vi.fn<GitExec>().mockRejectedValue(
      Object.assign(new Error('x'), { code: 128, stderr: 'fatal: not a git repository (or any parent)' })
    )
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_status({})
    expect(r).toMatchObject({ isError: true, content: [{ text: 'not a git repo' }] })
  })

  it('reports a timeout', async () => {
    const exec = vi.fn<GitExec>().mockRejectedValue(Object.assign(new Error('t'), { killed: true, signal: 'SIGTERM' }))
    const r = await createGitHandlers({ cwd: '/p', isProtected, exec }).git_log({})
    expect(r).toMatchObject({ isError: true, content: [{ text: 'git timed out' }] })
  })

  it('marks truncation when the buffer overflows', async () => {
    const exec = vi.fn<GitExec>().mockRejectedValue(
      Object.assign(new Error('b'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: 'partial' })
    )
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
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('diffs only the unprotected modified file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gittools-'))
    const git = (...a: string[]): string =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' })
    git('init', '-q')
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    writeFileSync(join(dir, '.env'), 'S=1\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
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
    expect(s.content[0]!.text).toContain('a.txt')
    expect(s.content[0]!.text).not.toContain('.env ')
  })
})
