import { describe, expect, it } from 'vitest'
import { DIFF_REPLY_CAP, createReviewTools, type ReviewExecFn, type ReviewExecOptions } from './reviewTools'

const SHA = 'a'.repeat(40)

interface Call {
  file: string
  args: string[]
  options: ReviewExecOptions
}

function setup(exec?: ReviewExecFn, startSha = SHA) {
  const calls: Call[] = []
  const fake: ReviewExecFn =
    exec ??
    (async () => ({ stdout: 'diff --git a/x b/x\n+line', stderr: '' }))
  const tools = createReviewTools({
    reviewer: 'reviewer',
    worktree: '/wt',
    startSha,
    env: { PATH: '/bin' },
    exec: async (file, args, options) => {
      calls.push({ file, args, options })
      return fake(file, args, options)
    }
  })
  return { tools, calls }
}

const text = (r: { content: { text: string }[] }): string => r.content[0]?.text ?? ''

describe('review_diff', () => {
  it('runs the hardened git diff for sha..HEAD', async () => {
    const { tools, calls } = setup()
    const r = await tools.handlers.review_diff({})
    expect(r.isError).toBeUndefined()
    expect(text(r)).toContain('+line')
    expect(text(r)).toContain('DATA')
    const call = calls[0]!
    expect(call.file).toBe('git')
    expect(call.args).toContain('--no-pager')
    expect(call.args).toContain('--no-ext-diff')
    expect(call.args).toContain('--no-textconv')
    expect(call.args).toContain(`${SHA}..HEAD`)
    expect(call.args.slice(-1)).toEqual(['--'])
    expect(call.options.cwd).toBe('/wt')
    expect(call.options.env['GIT_EXTERNAL_DIFF']).toBe('')
    expect(call.options.env['GIT_CONFIG_NOSYSTEM']).toBe('1')
  })

  it('caps the output and says it was truncated', async () => {
    const { tools } = setup(async () => ({ stdout: 'x'.repeat(DIFF_REPLY_CAP + 500), stderr: '' }))
    const r = await tools.handlers.review_diff({})
    expect(text(r)).toContain('truncated')
    expect(text(r).length).toBeLessThan(DIFF_REPLY_CAP + 500)
  })

  it.each(['', 'abc', '--output=x', 'g'.repeat(40), 'a'.repeat(41), `${SHA} --stat`])('rejects the sha %j without running git', async (sha) => {
    const { tools, calls } = setup(undefined, sha)
    const r = await tools.handlers.review_diff({})
    expect(r.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('maps a git failure to a short error', async () => {
    const { tools } = setup(async () => {
      throw Object.assign(new Error('boom'), { code: 128, stderr: 'fatal: bad revision' })
    })
    const r = await tools.handlers.review_diff({})
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('fatal: bad revision')
  })

  it('maps a timeout', async () => {
    const { tools } = setup(async () => {
      throw Object.assign(new Error('t'), { killed: true, signal: 'SIGTERM' })
    })
    expect(text(await tools.handlers.review_diff({}))).toContain('timed out')
  })
})

describe('report_findings', () => {
  const good = { severity: 'blocker', file: 'a.ts', line: 3, text: 'off by one' }

  it('stores valid findings with the app-set reviewer and drops extra keys', async () => {
    const { tools } = setup()
    const r = await tools.handlers.report_findings({
      findings: [{ ...good, reviewer: 'security-auditor', extra: 'x' }, { ...good, severity: 'nit', line: null }]
    })
    expect(r.isError).toBeUndefined()
    expect(tools.getFindings()).toEqual([
      { reviewer: 'reviewer', severity: 'blocker', file: 'a.ts', line: 3, text: 'off by one' },
      { reviewer: 'reviewer', severity: 'nit', file: 'a.ts', line: null, text: 'off by one' }
    ])
  })

  it('accepts an empty list as a report', async () => {
    const { tools } = setup()
    await tools.handlers.report_findings({ findings: [] })
    expect(tools.getFindings()).toEqual([])
  })

  it.each([
    ['bad severity', { findings: [{ ...good, severity: 'critical' }] }],
    ['text too long', { findings: [{ ...good, text: 'x'.repeat(501) }] }],
    ['file too long', { findings: [{ ...good, file: 'x'.repeat(201) }] }],
    ['non-integer line', { findings: [{ ...good, line: 1.5 }] }],
    ['more than 20', { findings: Array.from({ length: 21 }, () => good) }],
    ['not a list', { findings: 'none' }],
    ['no input', undefined]
  ])('rejects %s and keeps nothing', async (_name, input) => {
    const { tools } = setup()
    const r = await tools.handlers.report_findings(input)
    expect(r.isError).toBe(true)
    expect(tools.getFindings()).toBeNull()
  })

  it('rejects a second call and keeps the first result', async () => {
    const { tools } = setup()
    await tools.handlers.report_findings({ findings: [good] })
    const r = await tools.handlers.report_findings({ findings: [] })
    expect(r.isError).toBe(true)
    expect(tools.getFindings()).toHaveLength(1)
  })

  it('allows a valid call after an invalid one', async () => {
    const { tools } = setup()
    await tools.handlers.report_findings({ findings: [{ ...good, severity: 'x' }] })
    const r = await tools.handlers.report_findings({ findings: [good] })
    expect(r.isError).toBeUndefined()
    expect(tools.getFindings()).toHaveLength(1)
  })
})
