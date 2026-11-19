import { describe, expect, it, vi } from 'vitest'
import type { CheckConfig } from '../../shared/settings'
import {
  WORK_ALLOWED_TOOLS,
  WORK_TOOL_NAMES,
  createWorkerTools,
  findSystemNode,
  resolveCheckCommand,
  type ExecFn,
  type WorkerToolsDeps
} from './workerTools'

const WT = process.platform === 'win32' ? 'C:\\work\\wt' : '/work/wt'
const BRANCH = 'task/abcd1234-t1'
const test: CheckConfig = { name: 'test', executable: 'node', args: ['--test'], timeoutMs: 5000, acceptsTestPath: true }
const lint: CheckConfig = { name: 'lint', executable: 'eslint', args: ['.'], timeoutMs: 5000 }

function setup(overrides: Partial<WorkerToolsDeps> = {}, exec?: ExecFn) {
  const fn = vi.fn<ExecFn>(exec ?? (async () => ({ stdout: '', stderr: '' })))
  const onBlocked = vi.fn()
  const tools = createWorkerTools({
    taskId: 'T1',
    worktree: WT,
    branch: BRANCH,
    owns: ['src/a.ts', 'src/dir/'],
    checks: [test, lint],
    onBlocked,
    exec: fn,
    env: { PATH: '' },
    platform: process.platform,
    ...overrides
  })
  return { fn, onBlocked, tools, h: tools.handlers }
}

const text = (r: { content: { text: string }[] }): string => r.content[0]?.text ?? ''

describe('tool list', () => {
  it('exposes exactly the three work tools and no push, merge or checkout', () => {
    const { h } = setup()
    expect(Object.keys(h).sort()).toEqual([...WORK_TOOL_NAMES].sort())
    expect(WORK_TOOL_NAMES).toEqual(['run_check', 'git_commit', 'report_blocked', 'run_command'])
    expect(WORK_ALLOWED_TOOLS.some((n) => /push|merge|checkout|branch|reset/.test(n))).toBe(false)
  })
})

describe('run_check', () => {
  it('runs the check by name with executable, args, cwd, timeout and a buffer cap, no shell', async () => {
    const { fn, h, tools } = setup({ platform: 'linux' }, async () => ({ stdout: 'ok', stderr: '' }))
    const r = await h.run_check({ name: 'test' })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toContain('passed')
    const [file, args, opts] = fn.mock.calls[0] as Parameters<ExecFn>
    expect(file).toBe('node')
    expect(args).toEqual(['--test'])
    expect(opts).toMatchObject({ cwd: WT, timeout: 5000 })
    expect(opts.maxBuffer).toBeGreaterThan(0)
    expect(opts).not.toHaveProperty('shell')
    expect(tools.getCheckResult()).toBe('passed')
  })

  it('rejects an unknown name before exec', async () => {
    const { fn, h, tools } = setup()
    const r = await h.run_check({ name: 'rm -rf' })
    expect(r.isError).toBe(true)
    expect(fn).not.toHaveBeenCalled()
    expect(tools.getCheckResult()).toBe('none')
  })

  it('replies "no checks configured" for empty checks', async () => {
    const { fn, h } = setup({ checks: [] })
    expect(text(await h.run_check({ name: 'test' }))).toBe('no checks configured')
    expect(fn).not.toHaveBeenCalled()
  })

  it('validates testPath: outside, option-like, absolute and on a check that does not accept one', async () => {
    const { fn, h } = setup({ platform: 'linux' })
    for (const testPath of ['../x.test.ts', '-rf', '/etc/passwd', 'C:\\x', 'a/../../b']) {
      expect((await h.run_check({ name: 'test', testPath })).isError).toBe(true)
    }
    expect((await h.run_check({ name: 'lint', testPath: 'src/a.test.ts' })).isError).toBe(true)
    expect(fn).not.toHaveBeenCalled()
    const ok = await h.run_check({ name: 'test', testPath: 'src\\a.test.ts' })
    expect(ok.isError).toBeUndefined()
    expect(fn.mock.calls[0]?.[1]).toEqual(['--test', './src/a.test.ts'])
  })

  it('rejects testPath whose normalized form has a segment starting with "-"', async () => {
    const { fn, h } = setup({ platform: 'linux' })
    for (const testPath of ['./--config=src/foo/evil.config.ts', '.\\--x', 'a/--x', 'a\\--x/b', './a/./--y']) {
      expect((await h.run_check({ name: 'test', testPath })).isError).toBe(true)
    }
    expect(fn).not.toHaveBeenCalled()
  })

  it('passes an allow-listed env to the check, without secrets', async () => {
    const env = {
      PATH: 'p',
      SystemRoot: 'C:\\Windows',
      HOME: '/h',
      ANTHROPIC_API_KEY: 'sk-secret',
      GIT_DIR: 'x',
      NODE_OPTIONS: '--require evil',
      GITHUB_TOKEN: 'tok'
    }
    const { fn, h } = setup({ env, platform: 'linux' })
    await h.run_check({ name: 'test' })
    const passed = (fn.mock.calls[0] as Parameters<ExecFn>)[2].env
    expect(passed).toEqual({ PATH: 'p', SystemRoot: 'C:\\Windows', HOME: '/h', CI: '1' })
  })

  it('reports failed, timeout and cannot-start without throwing', async () => {
    const failed = setup({}, async () => Promise.reject(Object.assign(new Error('x'), { code: 2, stdout: 'out', stderr: 'bad' })))
    expect(text(await failed.h.run_check({ name: 'test' }))).toMatch(/failed \(exit code 2\)[\s\S]*bad/)
    expect(failed.tools.getCheckResult()).toBe('failed')

    const timedOut = setup({}, async () => Promise.reject(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' })))
    expect(text(await timedOut.h.run_check({ name: 'test' }))).toMatch(/timed out/)
    expect(timedOut.tools.getCheckResult()).toBe('failed')

    const noStart = setup({}, async () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })))
    expect(text(await noStart.h.run_check({ name: 'test' }))).toMatch(/could not start/)

    const weird = setup({}, async () => Promise.reject('string'))
    expect((await weird.h.run_check({ name: 'test' })).isError).toBe(true)
  })

  it('last result follows the latest run', async () => {
    let fail = true
    const { h, tools } = setup({}, async () => (fail ? Promise.reject(Object.assign(new Error('x'), { code: 1 })) : { stdout: '', stderr: '' }))
    await h.run_check({ name: 'test' })
    expect(tools.getCheckResult()).toBe('failed')
    fail = false
    await h.run_check({ name: 'test' })
    expect(tools.getCheckResult()).toBe('passed')
  })

  it('caps the output in the reply', async () => {
    const { h } = setup({}, async () => ({ stdout: 'x'.repeat(50_000), stderr: '' }))
    expect(text(await h.run_check({ name: 'test' })).length).toBeLessThan(5000)
  })
})

describe('npm on Windows', () => {
  const npm: CheckConfig = { name: 'unit', executable: 'npm', args: ['test'], timeoutMs: 5000 }
  const nodePath = 'C:\\Program Files\\nodejs\\node.exe'
  const entry = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
  const env = { PATH: 'C:\\Windows;C:\\Program Files\\nodejs' }

  it('finds the system node on PATH', () => {
    expect(findSystemNode({ platform: 'win32', env, fileExists: (p) => p === nodePath })).toBe(nodePath)
    expect(findSystemNode({ platform: 'win32', env, fileExists: () => false })).toBeNull()
  })

  it('runs node on npm-cli.js, never process.execPath or cmd.exe', () => {
    const r = resolveCheckCommand(npm, ['x'], { platform: 'win32', env, fileExists: (p) => p === nodePath || p === entry })
    expect(r).toEqual({ file: nodePath, args: [entry, 'test', 'x'] })
    expect(JSON.stringify(r).toLowerCase()).not.toContain('cmd.exe')
  })

  it('uses npx-cli.js for npx', () => {
    const r = resolveCheckCommand({ ...npm, executable: 'npx' }, [], {
      platform: 'win32',
      env,
      fileExists: (p) => p === nodePath || p.endsWith('npx-cli.js')
    })
    expect('args' in r && r.args[0]).toBe('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js')
  })

  it('returns a clear error when node or npm-cli.js cannot be found', () => {
    const noNode = resolveCheckCommand(npm, [], { platform: 'win32', env, fileExists: () => false })
    expect(noNode).toEqual({ error: expect.stringContaining('cannot run npm') })
    const noEntry = resolveCheckCommand(npm, [], { platform: 'win32', env, fileExists: (p) => p === nodePath })
    expect(noEntry).toEqual({ error: expect.stringContaining('cannot run npm') })
  })

  it('refuses .cmd and .bat, passes other executables through, and leaves non-win32 alone', () => {
    const cmd = resolveCheckCommand({ ...npm, executable: 'npm.cmd' }, [], { platform: 'win32', env })
    expect(cmd).toEqual({ error: expect.stringContaining('.cmd/.bat') })
    expect('error' in resolveCheckCommand({ ...npm, executable: 'x.BAT' }, [], { platform: 'win32', env })).toBe(true)
    expect(resolveCheckCommand(test, [], { platform: 'win32', env })).toEqual({ file: 'node', args: ['--test'] })
    expect(resolveCheckCommand(npm, [], { platform: 'linux', env })).toEqual({ file: 'npm', args: ['test'] })
  })

  it('run_check reports the npm error without exec', async () => {
    const { fn, h } = setup({ checks: [npm], platform: 'win32', env, fileExists: () => false })
    const r = await h.run_check({ name: 'unit' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('cannot run npm')
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('git_commit', () => {
  function gitExec(opts: { branch?: string; status?: string; filters?: string | number } = {}): ExecFn {
    return async (_file, args) => {
      const sub = args.filter((a) => !a.startsWith('-') && !a.includes('=')).slice(0, 1)[0]
      const joined = args.join(' ')
      if (joined.includes('rev-parse --abbrev-ref')) return { stdout: `${opts.branch ?? BRANCH}\n`, stderr: '' }
      if (joined.includes('config --get-regexp')) {
        if (typeof opts.filters === 'string') return { stdout: opts.filters, stderr: '' }
        return Promise.reject(Object.assign(new Error('none'), { code: 1 }))
      }
      if (args.includes('status')) return { stdout: opts.status ?? ' M src/a.ts\0', stderr: '' }
      if (args.includes('rev-parse')) return { stdout: 'abc1234\n', stderr: '' }
      void sub
      return { stdout: '', stderr: '' }
    }
  }
  const calls = (fn: ReturnType<typeof setup>['fn']): string[][] => fn.mock.calls.map((c) => c[1])
  const has = (list: string[], ...seq: string[]): boolean => list.join('\u0001').includes(seq.join('\u0001'))

  it('commits only the given paths with hooks disabled, the app identity and the task id', async () => {
    const { fn, h } = setup({}, gitExec())
    const r = await h.git_commit({ paths: ['src/a.ts'], message: 'fix a' })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toContain('abc1234')
    const commit = calls(fn).find((a) => a.includes('commit')) as string[]
    expect(has(commit, '-c', 'core.hooksPath=')).toBe(true)
    expect(has(commit, '-c', 'user.name=claude-desk')).toBe(true)
    expect(commit.slice(commit.indexOf('commit'))).toEqual([
      'commit',
      '--no-verify',
      '-m',
      'fix a\n\nTask: T1',
      '--only',
      '--',
      'src/a.ts'
    ])
    const add = calls(fn).find((a) => a.includes('add')) as string[]
    expect(add.slice(add.indexOf('add'))).toEqual(['add', '--', 'src/a.ts'])
    for (const call of fn.mock.calls) {
      expect(call[0]).toBe('git')
      expect(call[2]).toMatchObject({ cwd: WT })
      expect(call[2].timeout).toBeGreaterThan(0)
      expect(call[2].maxBuffer).toBeGreaterThan(0)
      expect(call[2].env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' })
      expect(call[2]).not.toHaveProperty('shell')
    }
  })

  it('blanks configured filter drivers', async () => {
    const { fn, h } = setup({}, gitExec({ filters: 'filter.evil.clean\nrm\0' }))
    await h.git_commit({ paths: ['src/a.ts'], message: 'm' })
    const commit = calls(fn).find((a) => a.includes('commit')) as string[]
    expect(has(commit, '-c', 'filter.evil.clean=', '-c', 'filter.evil.smudge=')).toBe(true)
  })

  it('fails closed on an unsafe filter name', async () => {
    const { fn, h } = setup({}, gitExec({ filters: 'filter.a b.clean\nx\0' }))
    const r = await h.git_commit({ paths: ['src/a.ts'], message: 'm' })
    expect(r.isError).toBe(true)
    expect(calls(fn).some((a) => a.includes('commit'))).toBe(false)
  })

  it('rejects bad paths, bad messages and paths outside Owns before any git call', async () => {
    const { fn, h } = setup({}, gitExec())
    const bad: unknown[] = [
      { paths: ['other.ts'], message: 'm' },
      { paths: ['../src/a.ts'], message: 'm' },
      { paths: ['/etc/passwd'], message: 'm' },
      { paths: ['C:\\x\\a.ts'], message: 'm' },
      { paths: ['-a'], message: 'm' },
      { paths: ['src/dir/'], message: 'm' },
      { paths: [], message: 'm' },
      { paths: ['src/a.ts'], message: '   ' },
      { paths: ['src/a.ts'], message: 'x'.repeat(5000) },
      { paths: 'src/a.ts', message: 'm' },
      null
    ]
    for (const input of bad) expect((await h.git_commit(input)).isError).toBe(true)
    expect(fn).not.toHaveBeenCalled()
  })

  it('rejects when HEAD is on another branch and commits nothing', async () => {
    const { fn, h } = setup({}, gitExec({ branch: 'main' }))
    const r = await h.git_commit({ paths: ['src/a.ts'], message: 'm' })
    expect(r.isError).toBe(true)
    expect(calls(fn).some((a) => a.includes('add') || a.includes('commit'))).toBe(false)
  })

  it('rejects an unchanged path', async () => {
    const { fn, h } = setup({}, gitExec({ status: '' }))
    const r = await h.git_commit({ paths: ['src/a.ts'], message: 'm' })
    expect(text(r)).toContain('no change')
    expect(calls(fn).some((a) => a.includes('commit'))).toBe(false)
  })

  it('F6: resets exactly the paths after a failed commit and reports the commit error', async () => {
    const base = gitExec({ status: ' M src/a.ts  M src/dir/b.ts ' })
    const exec: ExecFn = async (file, args, o) => {
      if (args.includes('commit')) throw Object.assign(new Error('x'), { stderr: 'fatal: commit failed' })
      if (args.includes('reset')) throw Object.assign(new Error('y'), { stderr: 'fatal: reset failed' })
      return base(file, args, o)
    }
    const { fn, h } = setup({}, exec)
    const r = await h.git_commit({ paths: ['src/a.ts', 'src/dir/b.ts'], message: 'm' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('git failed: fatal: commit failed')
    const reset = calls(fn).find((a) => a.includes('reset')) as string[]
    expect(has(reset, '-c', 'core.hooksPath=')).toBe(true)
    expect(reset.slice(reset.indexOf('reset'))).toEqual(['reset', '-q', '--', 'src/a.ts', 'src/dir/b.ts'])
  })

  it('maps git errors without throwing', async () => {
    const { h } = setup({}, async () => Promise.reject(Object.assign(new Error('x'), { stderr: 'fatal: nope' })))
    const r = await h.git_commit({ paths: ['src/a.ts'], message: 'm' })
    expect(text(r)).toContain('git failed: fatal: nope')
    const t = setup({}, async () => Promise.reject(Object.assign(new Error('x'), { killed: true })))
    expect(text(await t.h.git_commit({ paths: ['src/a.ts'], message: 'm' }))).toContain('timed out')
  })
})

describe('report_blocked', () => {
  it('records the reason capped at 500 chars and calls back', async () => {
    const { h, onBlocked } = setup()
    const r = await h.report_blocked({ reason: 'x'.repeat(900) })
    expect(r.isError).toBeUndefined()
    expect(onBlocked).toHaveBeenCalledWith('x'.repeat(500))
  })

  it('rejects an empty or malformed reason', async () => {
    const { h, onBlocked } = setup()
    expect((await h.report_blocked({ reason: '  ' })).isError).toBe(true)
    expect((await h.report_blocked({})).isError).toBe(true)
    expect(onBlocked).not.toHaveBeenCalled()
  })
})
