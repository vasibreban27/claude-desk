import { describe, expect, it, vi } from 'vitest'
import { createWorkerTools, WORK_ALLOWED_TOOLS, type ExecFn } from './workerTools'

function setup(allowCommands: boolean | undefined, exec?: ExecFn) {
  const fn = vi.fn<ExecFn>(exec ?? (async () => ({ stdout: 'added 1 package', stderr: '' })))
  const tools = createWorkerTools({
    taskId: 'T1',
    worktree: '/wt',
    branch: 'task/x-t1',
    owns: ['src/'],
    checks: [],
    onBlocked: vi.fn(),
    exec: fn,
    env: { PATH: '' },
    platform: 'linux',
    ...(allowCommands !== undefined ? { allowCommands } : {})
  })
  return { fn, h: tools.handlers }
}
const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join('')

describe('run_command', () => {
  it('is listed as a work tool', () => {
    expect(WORK_ALLOWED_TOOLS).toContain('mcp__work__run_command')
  })

  it('is disabled unless the project allows commands', async () => {
    for (const flag of [undefined, false]) {
      const { fn, h } = setup(flag)
      const r = await h.run_command({ command: 'npm', args: ['install'] })
      expect(r.isError).toBe(true)
      expect(fn).not.toHaveBeenCalled()
    }
  })

  it('runs an allowed command with argv, cwd, timeout and --ignore-scripts', async () => {
    const { fn, h } = setup(true)
    const r = await h.run_command({ command: 'npm', args: ['install', 'express'] })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toContain('added 1 package')
    expect(fn).toHaveBeenCalledWith('npm', ['install', 'express', '--ignore-scripts'], expect.objectContaining({ cwd: '/wt', timeout: expect.any(Number) }))
  })

  it('denies commands outside the allow list without running anything', async () => {
    const { fn, h } = setup(true)
    expect((await h.run_command({ command: 'bash', args: ['-c', 'rm -rf /'] })).isError).toBe(true)
    expect((await h.run_command({ command: 'npx', args: ['rimraf', '.'] })).isError).toBe(true)
    expect(fn).not.toHaveBeenCalled()
  })

  it('logs one outcome line per work-tool call, never the full output', async () => {
    const lines: { text: string; tone: string }[] = []
    const fn = vi.fn<ExecFn>(async () => ({ stdout: 'line1\nline2 secret', stderr: '' }))
    const tools = createWorkerTools({
      taskId: 'T1',
      worktree: '/wt',
      branch: 'b',
      owns: ['src/'],
      checks: [],
      onBlocked: vi.fn(),
      exec: fn,
      env: { PATH: '' },
      platform: 'linux',
      allowCommands: true,
      onLog: (l) => lines.push(l)
    })
    await tools.handlers.run_command({ command: 'npm', args: ['install', 'x'] })
    await tools.handlers.run_command({ command: 'bash', args: [] })
    expect(lines[0]).toEqual({ text: 'run_command npm install x: npm finished', tone: 'ok' })
    expect(lines[1]?.tone).toBe('error')
    expect(lines.some((l) => l.text.includes('secret'))).toBe(false)
  })

  it('reports a failing command with its exit code', async () => {
    const { h } = setup(true, async () => {
      throw Object.assign(new Error('x'), { code: 1, stdout: '', stderr: 'ERR! 404' })
    })
    const r = await h.run_command({ command: 'npm', args: ['install', 'nope-pkg'] })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('exit code 1')
  })
})
