import { describe, expect, it, vi } from 'vitest'
import { discoverTools, toToolInfos, type StatusQuery } from './discover'

function fake(statuses: unknown[][], opts: { throwOn?: number } = {}) {
  let i = 0
  const close = vi.fn()
  const q: StatusQuery = {
    close,
    mcpServerStatus: vi.fn(async () => {
      if (opts.throwOn === i) throw new Error('control request failed')
      const s = statuses[Math.min(i, statuses.length - 1)] ?? []
      i += 1
      return s
    }),
    async *[Symbol.asyncIterator]() {
      // no messages
    }
  }
  return { q, close }
}

const deps = (q: StatusQuery) => ({ cwd: '/d', queryFn: vi.fn(() => q), sleep: async () => undefined })

describe('discoverTools', () => {
  it('waits while pending and returns the tools with read-only hints, without a prompt and with only this server', async () => {
    const { q, close } = fake([
      [{ name: 'tiny', status: 'pending' }],
      [
        { name: 'other', status: 'connected', tools: [{ name: 'x' }] },
        {
          name: 'tiny',
          status: 'connected',
          tools: [
            { name: 'list_issues', annotations: { readOnly: true } },
            { name: 'mcp__tiny__create_issue', description: 'Create', annotations: {} },
            { name: 'bad name!' }
          ]
        }
      ]
    ])
    const d = deps(q)
    const r = await discoverTools('tiny', { type: 'stdio', command: 'node', args: ['s.js'] }, d)
    expect(r).toEqual({
      status: 'connected',
      error: null,
      tools: [
        { name: 'list_issues', description: null, readOnly: true },
        { name: 'create_issue', description: 'Create', readOnly: null }
      ]
    })
    const call = d.queryFn.mock.calls[0] as unknown as [{ prompt: unknown; options: Record<string, unknown> }]
    expect(typeof call[0].prompt).toBe('object')
    expect(call[0].options).toMatchObject({ cwd: '/d', settingSources: [], tools: [], allowedTools: [] })
    expect(Object.keys(call[0].options['mcpServers'] as object)).toEqual(['tiny'])
    expect(close).toHaveBeenCalled()
  })

  it.each([
    [[{ name: 'tiny', status: 'failed', error: 'spawn ENOENT' }], { status: 'failed', error: 'spawn ENOENT' }],
    [[{ name: 'tiny', status: 'needs-auth' }], { status: 'needs-auth', error: 'the server needs a sign-in or token' }],
    [[{ name: 'nope', status: 'connected' }], { status: 'failed', error: 'the server did not report a status' }]
  ])('maps %j', async (status, expected) => {
    const { q } = fake([status])
    expect(await discoverTools('tiny', { type: 'http', url: 'https://x' }, { ...deps(q), timeoutMs: 5 })).toMatchObject({ ...expected, tools: [] })
  })

  it('gives up when the server stays pending, and reports a thrown error', async () => {
    const pending = fake([[{ name: 'tiny', status: 'pending' }]])
    expect(await discoverTools('tiny', { type: 'http', url: 'https://x' }, { ...deps(pending.q), timeoutMs: 0 })).toMatchObject({ status: 'failed' })
    const slow = fake([[{ name: 'tiny', status: 'pending' }]])
    expect(
      await discoverTools('tiny', { type: 'http', url: 'https://x' }, {
        cwd: '/d',
        queryFn: () => slow.q,
        timeoutMs: 30,
        sleep: () => new Promise((r) => setTimeout(r, 10))
      })
    ).toMatchObject({ status: 'pending', error: 'the server did not connect in time' })
    const boom = fake([[]], { throwOn: 0 })
    expect(await discoverTools('tiny', { type: 'http', url: 'https://x' }, deps(boom.q))).toEqual({ status: 'failed', tools: [], error: 'control request failed' })
    expect(boom.close).toHaveBeenCalled()
  })
})

describe('toToolInfos', () => {
  it('dedupes, accepts readOnlyHint too and caps descriptions', () => {
    expect(
      toToolInfos('s', [
        { name: 'a', annotations: { readOnlyHint: false } },
        { name: 'mcp__s__a' },
        { name: 'b', description: 'x'.repeat(2000) }
      ])
    ).toEqual([
      { name: 'a', description: null, readOnly: false },
      { name: 'b', description: 'x'.repeat(1000), readOnly: null }
    ])
  })
})
