import { describe, expect, it } from 'vitest'
import type { McpConnection } from '../../shared/mcp'
import { loadChatMcp, serverConfig } from './servers'

const conn = (over: Partial<McpConnection> = {}): McpConnection => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'linear',
  transport: 'http',
  command: null,
  args: [],
  url: 'https://mcp.linear.app/mcp',
  secretKeys: [],
  enabled: true,
  knownTools: [],
  allowedTools: ['list_issues'],
  ...over
})

describe('serverConfig', () => {
  it('gives a remote server its secrets as headers', () => {
    expect(serverConfig(conn(), { Authorization: 'Bearer x' })).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer x' }
    })
    expect(serverConfig(conn({ transport: 'sse' }), {})).toMatchObject({ type: 'sse' })
  })

  it('gives a local server a small base environment plus its secrets, not the whole app environment', () => {
    const c = serverConfig(conn({ transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], url: null }), { API_KEY: 'k' }, {
      PATH: '/bin',
      SystemRoot: 'C:\\Windows',
      ANTHROPIC_API_KEY: 'must-not-leak',
      SECRET: 'nope'
    })
    expect(c).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { PATH: '/bin', SystemRoot: 'C:\\Windows', API_KEY: 'k' } })
  })
})

describe('loadChatMcp', () => {
  it('includes enabled connections with allowed tools, as full tool names', async () => {
    const store = {
      list: async () => [
        conn(),
        conn({ id: '00000000-0000-4000-8000-000000000002', name: 'off', enabled: false }),
        conn({ id: '00000000-0000-4000-8000-000000000003', name: 'none', allowedTools: [] })
      ],
      secretsFor: async () => ({ Authorization: 'Bearer x' })
    }
    const r = await loadChatMcp(store)
    expect(Object.keys(r.servers)).toEqual(['linear'])
    expect(r.allowedTools).toEqual(['mcp__linear__list_issues'])
  })

  it('returns nothing when the store fails', async () => {
    const store = {
      list: async () => {
        throw new Error('x')
      },
      secretsFor: async () => ({})
    }
    expect(await loadChatMcp(store)).toEqual({ servers: {}, allowedTools: [] })
  })
})
