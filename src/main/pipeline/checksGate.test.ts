import { describe, expect, it, vi } from 'vitest'
import type { CheckConfig } from '../../shared/settings'
import { runChecksGate } from './checksGate'
import type { ExecFn } from './workerTools'

const check = (name: string, extra: Partial<CheckConfig> = {}): CheckConfig =>
  ({ name, executable: name, args: ['run'], timeoutMs: 5000, ...extra }) as CheckConfig

const base = { platform: 'linux' as const, env: { PATH: '/bin', OPENAI_API_KEY: 'secret', NODE_OPTIONS: 'x' } }

describe('runChecksGate', () => {
  it('returns none without checks', async () => {
    const exec = vi.fn()
    expect(await runChecksGate({ worktree: '/w', checks: [] }, { ...base, exec })).toEqual({ status: 'none' })
    expect(exec).not.toHaveBeenCalled()
  })

  it('runs every check in the worktree with the allowlisted env and own timeout', async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue({ stdout: '', stderr: '' })
    const checks = [check('lint', { timeoutMs: 1000 }), check('test', { timeoutMs: 9000 })]
    expect(await runChecksGate({ worktree: '/w', checks }, { ...base, exec })).toEqual({ status: 'passed' })
    expect(exec).toHaveBeenCalledTimes(2)
    const [file, args, opts] = exec.mock.calls[1]!
    expect([file, args]).toEqual(['test', ['run']])
    expect(opts).toMatchObject({ cwd: '/w', timeout: 9000 })
    expect(opts.env).toMatchObject({ PATH: '/bin', CI: '1' })
    expect(opts.env).not.toHaveProperty('OPENAI_API_KEY')
    expect(opts.env).not.toHaveProperty('NODE_OPTIONS')
    expect(exec.mock.calls[0]![2].timeout).toBe(1000)
  })

  it('stops at the first failing check and caps its output', async () => {
    const exec = vi
      .fn<ExecFn>()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('x'), { code: 1, stdout: 'a'.repeat(9000), stderr: 'boom' }))
    const r = await runChecksGate({ worktree: '/w', checks: [check('lint'), check('test'), check('never')] }, { ...base, exec })
    expect(exec).toHaveBeenCalledTimes(2)
    expect(r.status).toBe('failed')
    if (r.status !== 'failed') return
    expect(r.check).toBe('test')
    expect(r.output.length).toBeLessThanOrEqual(4000 + '[truncated] ...'.length)
    expect(r.output).toContain('boom')
  })

  it.each([
    ['timeout', { killed: true, signal: 'SIGTERM' }, 'timed out'],
    ['start error', { code: 'ENOENT' }, 'could not start (ENOENT)'],
    ['big output', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'output too large']
  ])('reports %s as failed without throwing', async (_n, props, text) => {
    const exec = vi.fn<ExecFn>().mockRejectedValue(Object.assign(new Error('x'), props))
    const r = await runChecksGate({ worktree: '/w', checks: [check('test')] }, { ...base, exec })
    expect(r).toMatchObject({ status: 'failed', check: 'test' })
    expect(JSON.stringify(r)).toContain(text)
  })

  it('fails when the command cannot be resolved (.cmd on win32)', async () => {
    const exec = vi.fn<ExecFn>()
    const r = await runChecksGate({ worktree: 'C:\\w', checks: [check('t', { executable: 'C:\\x\\run.cmd' })] }, { platform: 'win32', env: {}, exec })
    expect(r).toMatchObject({ status: 'failed', check: 't' })
    expect(exec).not.toHaveBeenCalled()
  })

  it('does not throw when exec throws a non-error', async () => {
    const exec = vi.fn<ExecFn>().mockRejectedValue(undefined)
    expect((await runChecksGate({ worktree: '/w', checks: [check('t')] }, { ...base, exec })).status).toBe('failed')
  })
})
