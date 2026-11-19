import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpSaveRequest } from '../../shared/mcp'
import { MCP_CONNECTIONS_FILE, MCP_SECRETS_FILE, createMcpStore, type SecretBox } from './store'

/** Reversible stand-in for safeStorage: the stored bytes never contain the plain value. */
const box = (available = true): SecretBox => ({
  available: () => available,
  encrypt: (s) => Buffer.from(`enc:${[...s].reverse().join('')}`),
  decrypt: (b) => {
    const s = b.toString()
    if (!s.startsWith('enc:')) throw new Error('bad')
    return [...s.slice(4)].reverse().join('')
  }
})

const req = (over: Partial<McpSaveRequest> = {}): McpSaveRequest => ({
  id: null,
  name: 'linear',
  transport: 'http',
  command: null,
  args: [],
  url: 'https://mcp.linear.app/mcp',
  enabled: true,
  allowedTools: [],
  secrets: { Authorization: 'Bearer lin_api_secret' },
  ...over
})

describe('mcp store', () => {
  let dir: string
  let n = 0
  const ids = () => `00000000-0000-4000-8000-00000000000${++n}`
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-store-'))
    n = 0
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('saves a connection with its secret encrypted and only the key name in the list', async () => {
    const store = createMcpStore(dir, box(), ids)
    const r = await store.save(req())
    expect(r).toMatchObject({ ok: true, connection: { name: 'linear', secretKeys: ['Authorization'], allowedTools: [], knownTools: [] } })
    expect(JSON.stringify(await store.list())).not.toContain('lin_api_secret')
    expect(readFileSync(path.join(dir, MCP_SECRETS_FILE), 'utf8')).not.toContain('lin_api_secret')
    expect(readFileSync(path.join(dir, MCP_CONNECTIONS_FILE), 'utf8')).not.toContain('lin_api_secret')
    if (!r.ok) throw new Error('save failed')
    expect(await store.secretsFor(r.connection.id)).toEqual({ Authorization: 'Bearer lin_api_secret' })
  })

  it('keeps unlisted secrets on update, replaces given ones and removes null ones', async () => {
    const store = createMcpStore(dir, box(), ids)
    const first = await store.save(req({ secrets: { A: 'one', B: 'two' } }))
    if (!first.ok) throw new Error('save failed')
    const id = first.connection.id
    const second = await store.save(req({ id, secrets: { B: 'three', A: null } }))
    expect(second).toMatchObject({ ok: true, connection: { secretKeys: ['B'] } })
    expect(await store.secretsFor(id)).toEqual({ B: 'three' })
    await store.save(req({ id, secrets: {} }))
    expect(await store.secretsFor(id)).toEqual({ B: 'three' })
  })

  it('refuses duplicate names, unknown ids, secrets without a keychain and invalid targets', async () => {
    const store = createMcpStore(dir, box(), ids)
    await store.save(req())
    expect(await store.save(req())).toEqual({ ok: false, error: 'duplicate-name' })
    expect(await store.save(req({ id: '00000000-0000-4000-8000-0000000000ff', name: 'other' }))).toEqual({ ok: false, error: 'not-found' })
    expect(await store.save(req({ name: 'local', transport: 'stdio', command: null }))).toMatchObject({ ok: false, error: 'invalid' })
    const noKeychain = createMcpStore(dir, box(false), ids)
    expect(await noKeychain.save(req({ name: 'other' }))).toEqual({ ok: false, error: 'secrets-unavailable' })
    expect(await noKeychain.save(req({ name: 'other', secrets: {} }))).toMatchObject({ ok: true })
    expect(await noKeychain.secretsFor((await noKeychain.list())[0]!.id)).toEqual({})
  })

  it('only allows tools seen in a test, and drops allowed tools the server no longer offers', async () => {
    const store = createMcpStore(dir, box(), ids)
    const saved = await store.save(req({ allowedTools: ['list_issues'] }))
    if (!saved.ok) throw new Error('save failed')
    expect(saved.connection.allowedTools).toEqual([])
    const id = saved.connection.id
    await store.setKnownTools(id, [
      { name: 'list_issues', description: null, readOnly: true },
      { name: 'create_issue', description: null, readOnly: false }
    ])
    const allowed = await store.save(req({ id, allowedTools: ['list_issues', 'create_issue', 'list_issues', 'nope'], secrets: {} }))
    expect(allowed).toMatchObject({ ok: true, connection: { allowedTools: ['list_issues', 'create_issue'] } })
    const after = await store.setKnownTools(id, [{ name: 'list_issues', description: null, readOnly: true }])
    expect(after?.allowedTools).toEqual(['list_issues'])
  })

  it('removes a connection with its secrets', async () => {
    const store = createMcpStore(dir, box(), ids)
    const saved = await store.save(req())
    if (!saved.ok) throw new Error('save failed')
    expect(await store.remove(saved.connection.id)).toEqual({ ok: true })
    expect(await store.list()).toEqual([])
    expect(await store.secretsFor(saved.connection.id)).toEqual({})
    expect(await store.remove(saved.connection.id)).toEqual({ ok: false, error: 'not-found' })
  })

  it('treats corrupt files as empty, skips invalid entries and undecryptable secrets', async () => {
    writeFileSync(path.join(dir, MCP_CONNECTIONS_FILE), '{not json')
    const store = createMcpStore(() => dir, box(), ids)
    expect(await store.list()).toEqual([])
    const saved = await store.save(req())
    if (!saved.ok) throw new Error('save failed')
    const file = path.join(dir, MCP_CONNECTIONS_FILE)
    const list = JSON.parse(readFileSync(file, 'utf8')) as unknown[]
    writeFileSync(file, JSON.stringify([...list, { id: 'x', name: 'BAD' }]))
    expect((await store.list()).map((c) => c.name)).toEqual(['linear'])
    writeFileSync(path.join(dir, MCP_SECRETS_FILE), JSON.stringify({ [saved.connection.id]: { Authorization: Buffer.from('garbage').toString('base64') } }))
    expect(await store.secretsFor(saved.connection.id)).toEqual({})
  })
})
