import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../shared/ipc'
import { createSettingsStore } from '../db/settingsStore'
import { defaultSettings } from '../../shared/settings'
import { createHandlers, type HandlerDeps } from './handlers'

const ID = '3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b'
const OTHER = '9f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b'
const project: Project = {
  id: ID,
  path: '/repo',
  name: 'repo',
  branch: 'main',
  dirty: false,
  addedAt: '2026-01-01T00:00:00.000Z'
}

function setup(over: Partial<HandlerDeps> = {}) {
  const deps: HandlerDeps = {
    store: {
      list: vi.fn(async () => [project]),
      get: vi.fn(async (id: string) => (id === ID ? project : undefined)),
      add: vi.fn(async () => ({ ok: true as const, project })),
      update: vi.fn(async (_id, s) => ({ ...project, ...s })),
      remove: vi.fn(async (id: string) => id === ID)
    },
    readGitStatus: vi.fn(async () => ({ ok: true as const, branch: 'main', dirty: true })),
    pickFolder: vi.fn(async () => '/repo'),
    chat: {
      getHistory: vi.fn(() => []),
      activityHistory: vi.fn(() => []),
      send: vi.fn(() => ({ ok: true as const, turnId: 't1' }))
    },
    settingsStore: createSettingsStore(null),
    readToolkitInfo: () => ({ status: 'unset', path: null, version: null }),
    ...over
  }
  return { deps, h: createHandlers(deps) }
}

afterEach(() => vi.restoreAllMocks())

describe('projects:pick-and-add', () => {
  it('returns cancelled when the picker is cancelled', async () => {
    const { h } = setup({ pickFolder: async () => undefined })
    expect(await h.pickAndAdd()).toEqual({ ok: false, error: 'cancelled' })
  })

  it('adds a git repo with branch and dirty', async () => {
    const { h, deps } = setup()
    expect(await h.pickAndAdd()).toEqual({ ok: true, project })
    expect(deps.store.add).toHaveBeenCalledWith({ path: '/repo', branch: 'main', dirty: true })
  })

  it('returns not-a-git-repo for a non-repo without storing it', async () => {
    const { h, deps } = setup({ readGitStatus: async () => ({ ok: false, error: 'not-a-git-repo' }) })
    expect(await h.pickAndAdd()).toEqual({ ok: false, error: 'not-a-git-repo' })
    expect(deps.store.add).not.toHaveBeenCalled()
  })

  it('returns duplicate', async () => {
    const { deps } = setup()
    deps.store.add = vi.fn(async () => ({ ok: false as const, error: 'duplicate' as const }))
    expect(await createHandlers(deps).pickAndAdd()).toEqual({ ok: false, error: 'duplicate' })
  })

  it('maps thrown errors to unreadable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { h } = setup({
      pickFolder: async () => {
        throw new Error('boom')
      }
    })
    expect(await h.pickAndAdd()).toEqual({ ok: false, error: 'unreadable' })
  })
})

describe('projects:list and projects:refresh', () => {
  it('lists projects', async () => {
    const { h } = setup()
    expect(await h.listProjects()).toEqual([project])
  })

  it('refresh returns not-found for an unknown id', async () => {
    const { h } = setup()
    expect(await h.refresh({ id: OTHER })).toEqual({ ok: false, error: 'not-found' })
  })

  it('refresh returns not-found for an invalid payload', async () => {
    const { h } = setup()
    expect(await h.refresh({ id: 'nope' })).toEqual({ ok: false, error: 'not-found' })
    expect(await h.refresh(undefined)).toEqual({ ok: false, error: 'not-found' })
  })

  it('refresh updates status', async () => {
    const { h } = setup()
    expect(await h.refresh({ id: ID })).toEqual({
      ok: true,
      project: { ...project, branch: 'main', dirty: true }
    })
  })

  it('refresh returns unreadable when git fails', async () => {
    const { h } = setup({ readGitStatus: async () => ({ ok: false, error: 'unreadable' }) })
    expect(await h.refresh({ id: ID })).toEqual({ ok: false, error: 'unreadable' })
  })
})

describe('chat', () => {
  it('history validates the payload and returns messages', async () => {
    const { h, deps } = setup()
    expect(await h.chatHistory({ projectId: 'bad' })).toEqual([])
    expect(await h.chatHistory({ projectId: ID })).toEqual([])
    expect(deps.chat.getHistory).toHaveBeenCalledWith(ID)
  })

  it('send rejects invalid payloads with invalid', async () => {
    const { h, deps } = setup()
    expect(await h.chatSend({ projectId: ID, text: '' })).toEqual({ ok: false, error: 'invalid' })
    expect(await h.chatSend({ projectId: ID, text: 'x'.repeat(20001) })).toEqual({
      ok: false,
      error: 'invalid'
    })
    expect(await h.chatSend(null)).toEqual({ ok: false, error: 'invalid' })
    expect(deps.chat.send).not.toHaveBeenCalled()
  })

  it('send routes events before sending and keeps the route when accepted', async () => {
    const { h } = setup()
    const undo = vi.fn()
    const route = vi.fn(() => undo)
    expect(await h.chatSend({ projectId: ID, text: 'hi' }, route)).toEqual({ ok: true, turnId: 't1' })
    expect(route).toHaveBeenCalledWith(ID)
    expect(undo).not.toHaveBeenCalled()
  })

  it('send undoes the route when rejected (busy)', async () => {
    const { h } = setup({ chat: { getHistory: () => [], activityHistory: () => [], send: () => ({ ok: false, error: 'busy' }) } })
    const undo = vi.fn()
    expect(await h.chatSend({ projectId: ID, text: 'hi' }, () => undo)).toEqual({ ok: false, error: 'busy' })
    expect(undo).toHaveBeenCalled()
  })

  it('send never throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { h } = setup({
      chat: {
        getHistory: () => [],
        activityHistory: () => [],
        send: () => {
          throw new Error('x')
        }
      }
    })
    expect(await h.chatSend({ projectId: ID, text: 'hi' })).toEqual({ ok: false, error: 'invalid' })
  })
})

describe('activity:history', () => {
  it('returns [] for a malformed payload without calling the service', async () => {
    const { h, deps } = setup()
    expect(await h.activityHistory({ projectId: 'nope' })).toEqual([])
    expect(await h.activityHistory(undefined)).toEqual([])
    expect(deps.chat.activityHistory).not.toHaveBeenCalled()
  })

  it('passes the parsed project id to the service', async () => {
    const events = [
      { projectId: ID, runId: 'r', seq: 0, at: '2026-01-01T00:00:00.000+00:00', agent: 'main', agentId: null, type: 'run-started' as const }
    ]
    const { h, deps } = setup()
    vi.mocked(deps.chat.activityHistory).mockReturnValue(events)
    expect(await h.activityHistory({ projectId: ID })).toEqual(events)
    expect(deps.chat.activityHistory).toHaveBeenCalledWith(ID)
  })
})

describe('usage:summary', () => {
  const empty = (days: number) => ({
    days,
    estimated: true as const,
    totals: { runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    byDay: [],
    byAgent: [],
    byProject: []
  })

  it('returns an empty summary for invalid payloads and never reaches the store', async () => {
    const summary = vi.fn()
    const { h } = setup({ runStore: { summary } })
    const bad = [null, {}, { projectId: null, days: 0 }, { projectId: null, days: 1000 }, { projectId: null, days: Number.NaN }, { projectId: 'x', days: 7 }]
    for (const payload of bad) {
      const res = await h.usageSummary(payload)
      expect(res.totals.runs).toBe(0)
      expect(res.estimated).toBe(true)
    }
    expect(summary).not.toHaveBeenCalled()
  })

  it('passes parsed values to the store', async () => {
    const summary = vi.fn(() => empty(7))
    const { h } = setup({ runStore: { summary } })
    await h.usageSummary({ projectId: ID, days: 7 })
    expect(summary).toHaveBeenCalledWith({ projectId: ID, days: 7 })
  })

  it('returns an empty summary when the database is unavailable', async () => {
    const { h } = setup()
    expect(await h.usageSummary({ projectId: null, days: 90 })).toEqual(empty(90))
  })

  it('returns an empty summary when the store throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { h } = setup({
      runStore: {
        summary: () => {
          throw new TypeError('boom /home/user/data')
        }
      }
    })
    expect(await h.usageSummary({ projectId: null, days: 30 })).toEqual(empty(30))
    expect(console.error).toHaveBeenCalledWith('usage:summary failed:', 'TypeError')
  })
})

describe('settings and app info', () => {
  const stored = () => {
    const get = vi.fn(() => ({ settings: defaultSettings(), notice: null as null | 'defaults-applied' }))
    const set = vi.fn((_id: string, s: unknown) => ({ ok: true as const, settings: s as ReturnType<typeof defaultSettings> }))
    return { get, set }
  }

  it('settings:get rejects invalid payloads and unknown projects without touching the store', async () => {
    const settingsStore = stored()
    const { h } = setup({ settingsStore })
    expect(await h.settingsGet({ projectId: 'nope' })).toEqual({ ok: false, error: 'not-found' })
    expect(await h.settingsGet({ projectId: OTHER })).toEqual({ ok: false, error: 'not-found' })
    expect(settingsStore.get).not.toHaveBeenCalled()
  })

  it('settings:get returns the stored settings and notice', async () => {
    const settingsStore = stored()
    settingsStore.get.mockReturnValue({ settings: defaultSettings(), notice: 'defaults-applied' })
    const { h } = setup({ settingsStore })
    expect(await h.settingsGet({ projectId: ID })).toEqual({
      ok: true,
      settings: defaultSettings(),
      notice: 'defaults-applied'
    })
  })

  it('settings:get reports storage-unavailable when the database is missing', async () => {
    const { h } = setup()
    expect(await h.settingsGet({ projectId: ID })).toEqual({
      ok: true,
      settings: defaultSettings(),
      notice: 'storage-unavailable'
    })
  })

  it('settings:set validates, checks the project and never touches the store otherwise', async () => {
    const settingsStore = stored()
    const { h } = setup({ settingsStore })
    expect(await h.settingsSet({ projectId: ID, settings: { version: 2 } })).toEqual({ ok: false, error: 'invalid' })
    expect(await h.settingsSet(null)).toEqual({ ok: false, error: 'invalid' })
    expect(await h.settingsSet({ projectId: OTHER, settings: defaultSettings() })).toEqual({
      ok: false,
      error: 'not-found'
    })
    expect(settingsStore.set).not.toHaveBeenCalled()
  })

  it('settings:set round-trips and computes sessionReset from the settings read before the save', async () => {
    const settingsStore = stored()
    const { h } = setup({ settingsStore })
    const next = { ...defaultSettings(), protectedPaths: ['secrets/**'] }
    const res = await h.settingsSet({ projectId: ID, settings: next })
    expect(res).toEqual({ ok: true, settings: next, sessionReset: false })
    expect(settingsStore.get.mock.invocationCallOrder[0]!).toBeLessThan(settingsStore.set.mock.invocationCallOrder[0]!)
  })

  it('settings:set maps store errors', async () => {
    const { h } = setup()
    expect(await h.settingsSet({ projectId: ID, settings: defaultSettings() })).toEqual({
      ok: false,
      error: 'storage-unavailable'
    })
  })

  it('projects:create validates the payload, uses the stored root and never takes a path', async () => {
    const appSettings = { getProjectsRoot: async () => null, setProjectsRoot: async () => undefined }
    const h = setup({ appSettings }).h
    expect(await h.createProject({ name: '../x' })).toEqual({ ok: false, error: 'invalid-name' })
    expect(await h.createProject({ name: 'ok-name', path: '/etc' })).toEqual({ ok: false, error: 'invalid-name' })
    expect(await h.createProject({ name: 'ok-name' })).toEqual({ ok: false, error: 'no-root' })
  })

  it('projects:create with enableCommands turns on allow-listed commands for that project', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'hcreate-'))
    try {
      const project = { id: '11111111-1111-4111-8111-111111111111', name: 'demo-app', path: join(root, 'demo-app'), branch: 'main', dirty: false, addedAt: 'x' }
      const store = { list: async () => [], get: async () => undefined, update: async () => undefined, remove: async () => false, add: async () => ({ ok: true as const, project }) }
      const set = vi.fn(() => ({ ok: true as const, settings: {} as never }))
      const h = setup({
        store,
        appSettings: { getProjectsRoot: async () => root, setProjectsRoot: async () => undefined },
        gitRun: async () => undefined,
        settingsStore: { get: () => ({ settings: {} as never, notice: null }), set } as never
      }).h
      const r = await h.createProject({ name: 'demo-app', enableCommands: true })
      expect(r).toMatchObject({ ok: true })
      expect(set).toHaveBeenCalledWith(project.id, expect.objectContaining({ allowCommands: true }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('projects:list marks projects whose folder is gone', async () => {
    const h = setup({ folderExists: async () => false }).h
    expect(await h.listProjects()).toEqual([{ ...project, missing: true }])
  })

  it('projects:remove validates the payload and never deletes a folder without a trash function', async () => {
    const h = setup().h
    expect(await h.removeProject({ id: 'nope', deleteFolder: false })).toEqual({ ok: false, error: 'not-found' })
    expect(await h.removeProject({ id: ID })).toEqual({ ok: false, error: 'not-found' })
    expect(await h.removeProject({ id: ID, deleteFolder: true })).toMatchObject({ ok: false, error: 'trash-failed' })
    expect(await h.removeProject({ id: ID, deleteFolder: false })).toEqual({ ok: true, folderDeleted: false })
  })

  it('app:open-url opens only https URLs', async () => {
    const openExternal = vi.fn(async () => undefined)
    const h = setup({ openExternal }).h
    expect(await h.openUrl({ url: 'https://github.com/o/r/pull/1' })).toBe(true)
    for (const url of ['http://x.com', 'file:///C:/x', 'javascript:alert(1)', 'not a url', 5]) {
      expect(await h.openUrl({ url })).toBe(false)
    }
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('projects:root-pick stores the picked folder', async () => {
    let root: string | null = null
    const appSettings = { getProjectsRoot: async () => root, setProjectsRoot: async (r: string) => { root = r } }
    const h = setup({ appSettings, pickFolder: async () => '/projects' }).h
    expect(await h.projectsRootPick()).toEqual({ root: '/projects' })
    expect(await h.projectsRootGet()).toEqual({ root: '/projects' })
  })

  it('toolkit:list validates the scan result and maps failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const info = { status: 'valid' as const, path: '/t', version: null }
    const listing = { plugin: null, agents: [], skills: [], hooks: [], problems: [] }
    expect(await setup({ readToolkitInfo: () => info, scanToolkit: async () => listing }).h.toolkitList()).toEqual({ ok: true, listing })
    expect(await setup({ readToolkitInfo: () => info, scanToolkit: async () => ({ bad: 1 }) }).h.toolkitList()).toEqual({ ok: false, error: 'unreadable' })
    expect(await setup({ readToolkitInfo: () => info, scanToolkit: async () => { throw new Error('x') } }).h.toolkitList()).toEqual({ ok: false, error: 'unreadable' })
    expect(await setup({}).h.toolkitList()).toEqual({ ok: false, error: 'unset' })
  })

  it('app:info returns the toolkit info and never throws', async () => {
    const info = { status: 'valid' as const, path: '/t', version: '1.0.0' }
    expect(await setup({ readToolkitInfo: () => info }).h.appInfo()).toEqual({ toolkit: info })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { h } = setup({
      readToolkitInfo: () => {
        throw new Error('x')
      }
    })
    expect(await h.appInfo()).toEqual({ toolkit: { status: 'invalid', path: null, version: null } })
  })
})

describe('mcp handlers', () => {
  const conn = {
    id: ID,
    name: 'linear',
    transport: 'http' as const,
    command: null,
    args: [],
    url: 'https://mcp.linear.app/mcp',
    secretKeys: ['Authorization'],
    enabled: true,
    knownTools: [],
    allowedTools: []
  }
  const store = () => ({
    list: vi.fn(async () => [conn]),
    get: vi.fn(async (id: string) => (id === ID ? conn : undefined)),
    save: vi.fn(async () => ({ ok: true as const, connection: conn })),
    remove: vi.fn(async () => ({ ok: true as const })),
    setKnownTools: vi.fn(async (_id: string, tools: { name: string; description: string | null; readOnly: boolean | null }[]) => ({ ...conn, knownTools: tools })),
    secretsFor: vi.fn(async () => ({ Authorization: 'Bearer secret-token' })),
    secretsAvailable: vi.fn(() => true)
  })
  const saveReq = { id: null, name: 'linear', transport: 'http', command: null, args: [], url: 'https://mcp.linear.app/mcp', enabled: true, allowedTools: [], secrets: { Authorization: 'Bearer x' } }

  it('lists, saves and deletes through the store with validated payloads', async () => {
    const s = store()
    const { h } = setup({ mcp: { store: s, discover: vi.fn() } })
    expect(await h.mcpList()).toEqual({ ok: true, connections: [conn], secretsAvailable: true })
    expect(await h.mcpSave(saveReq)).toEqual({ ok: true, connection: conn })
    expect(s.save).toHaveBeenCalledWith(saveReq)
    expect(await h.mcpDelete({ id: ID })).toEqual({ ok: true })
    for (const bad of [null, {}, { ...saveReq, name: 'git' }, { ...saveReq, url: 'http://evil.example' }, { ...saveReq, extra: 1 }, { ...saveReq, secrets: { 'bad key': 'x' } }]) {
      expect(await h.mcpSave(bad)).toMatchObject({ ok: false, error: 'invalid' })
    }
    expect(await h.mcpDelete({ id: 'x' })).toEqual({ ok: false, error: 'not-found' })
    expect(s.save).toHaveBeenCalledTimes(1)
    expect(s.remove).toHaveBeenCalledTimes(1)
  })

  it('tests a connection with its secrets, stores the tools when connected, and never echoes thrown errors', async () => {
    const s = store()
    const tools = [{ name: 'list_issues', description: null, readOnly: true }]
    const discover = vi.fn(async () => ({ status: 'connected' as const, tools, error: null }))
    const { h } = setup({ mcp: { store: s, discover } })
    const r = await h.mcpTest({ id: ID })
    expect(r).toMatchObject({ ok: true, status: 'connected', tools, connection: { knownTools: tools } })
    expect(discover).toHaveBeenCalledWith('linear', { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer secret-token' } })
    expect(await h.mcpTest({ id: OTHER })).toEqual({ ok: false, error: 'not-found' })

    discover.mockResolvedValueOnce({ status: 'needs-auth', tools: [], error: 'the server needs a sign-in or token' } as never)
    expect(await h.mcpTest({ id: ID })).toMatchObject({ ok: true, status: 'needs-auth', connection: conn })
    expect(s.setKnownTools).toHaveBeenCalledTimes(1)

    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    discover.mockRejectedValueOnce(new Error('Bearer secret-token rejected'))
    expect(await h.mcpTest({ id: ID })).toEqual({ ok: false, error: 'test-failed' })
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('secret-token')
  })

  it('reports errors without an MCP store', async () => {
    const { h } = setup()
    expect(await h.mcpList()).toEqual({ ok: false, error: 'unreadable' })
    expect(await h.mcpSave(saveReq)).toEqual({ ok: false, error: 'storage-error' })
    expect(await h.mcpTest({ id: ID })).toEqual({ ok: false, error: 'test-failed' })
  })
})

describe('pipeline handlers', () => {
  const service = () => ({
    listPlans: vi.fn(async () => ({ ok: true as const, plans: [] })),
    start: vi.fn(async () => ({ ok: true as const, runId: 'r1' })),
    status: vi.fn(async () => ({ ok: true as const, run: null })),
    cancel: vi.fn(async () => ({ ok: true as const })),
    resume: vi.fn(async () => ({ ok: true as const, runId: 'r1' })),
    discard: vi.fn(async () => ({ ok: true as const })),
    merge: vi.fn(async () => ({ ok: true as const, baseBranch: 'main', head: 'abc1234', planCommitted: true, cleanedUp: true })),
    openPr: vi.fn(async () => ({ ok: true as const, url: 'https://github.com/o/r/pull/1', branch: 'desk/x-1', host: 'github' as const }))
  })

  it('passes valid payloads to the service and returns its result unchanged', async () => {
    const pipeline = service()
    const { h } = setup({ pipeline })
    expect(await h.pipelinePlans({ projectId: ID })).toEqual({ ok: true, plans: [] })
    expect(await h.pipelineStart({ projectId: ID, planFile: 'a.md' })).toEqual({ ok: true, runId: 'r1' })
    expect(await h.pipelineStatus({ projectId: ID })).toEqual({ ok: true, run: null })
    expect(await h.pipelineCancel({ projectId: ID, runId: 'r1' })).toEqual({ ok: true })
    expect(await h.pipelineResume({ projectId: ID, runId: 'r1' })).toEqual({ ok: true, runId: 'r1' })
    expect(pipeline.resume).toHaveBeenCalledWith(ID, 'r1')
    expect(await h.pipelineDiscard({ projectId: ID, runId: 'r1' })).toEqual({ ok: true })
    expect(await h.pipelineMerge({ projectId: ID, runId: 'r1' })).toMatchObject({ ok: true, head: 'abc1234' })
    expect(pipeline.merge).toHaveBeenCalledWith(ID, 'r1')
    expect(await h.pipelinePr({ projectId: ID, runId: 'r1' })).toMatchObject({ ok: true, url: 'https://github.com/o/r/pull/1' })
    expect(pipeline.openPr).toHaveBeenCalledWith(ID, 'r1')
    expect(pipeline.start).toHaveBeenCalledWith(ID, 'a.md')
    expect(pipeline.cancel).toHaveBeenCalledWith(ID, 'r1')
  })

  it('rejects invalid payloads with the contract error without calling the service', async () => {
    const pipeline = service()
    const { h } = setup({ pipeline })
    for (const bad of [null, 'x', 5, [], {}, { projectId: 'nope' }, { projectId: ID, extra: 1 }]) {
      expect(await h.pipelinePlans(bad)).toEqual({ ok: false, error: 'not-found' })
      expect(await h.pipelineStatus(bad)).toEqual({ ok: false, error: 'not-found' })
      expect(await h.pipelineCancel(bad)).toEqual({ ok: false, error: 'not-found' })
      expect(await h.pipelineResume(bad)).toEqual({ ok: false, error: 'not-found' })
      expect(await h.pipelineDiscard(bad)).toEqual({ ok: false, error: 'not-found' })
      expect(await h.pipelineMerge(bad)).toEqual({ ok: false, error: 'not-found' })
      expect(await h.pipelinePr(bad)).toEqual({ ok: false, error: 'not-found' })
    }
    for (const bad of [null, 'x', 5, [], {}, { projectId: 'nope', planFile: 'a.md' }]) {
      expect(await h.pipelineStart(bad)).toEqual({ ok: false, error: 'not-found' })
    }
    for (const planFile of ['../x.md', 'a/b.md', 'a.txt', '', 5, '.md']) {
      expect(await h.pipelineStart({ projectId: ID, planFile })).toEqual({ ok: false, error: 'invalid-plan' })
    }
    expect(await h.pipelineStart({ projectId: ID, planFile: 'a.md', extra: 1 })).toEqual({ ok: false, error: 'invalid-plan' })
    expect(await h.pipelineCancel({ projectId: ID })).toEqual({ ok: false, error: 'not-found' })
    expect(await h.pipelineCancel({ projectId: ID, runId: 'r', x: 1 })).toEqual({ ok: false, error: 'not-found' })
    for (const fn of Object.values(pipeline)) expect(fn).not.toHaveBeenCalled()
  })

  it('maps a throwing service to a generic error and logs only the error name', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const boom = vi.fn(async () => {
      throw new RangeError('secret /home/someone')
    })
    const { h } = setup({
      pipeline: { listPlans: boom, start: boom, status: boom, cancel: boom, resume: boom, discard: boom, merge: boom, openPr: boom }
    })
    expect(await h.pipelinePlans({ projectId: ID })).toEqual({ ok: false, error: 'unreadable' })
    expect(await h.pipelineStart({ projectId: ID, planFile: 'a.md' })).toEqual({ ok: false, error: 'start-failed' })
    expect(await h.pipelineStatus({ projectId: ID })).toEqual({ ok: false, error: 'storage-unavailable' })
    expect(await h.pipelineCancel({ projectId: ID, runId: 'r' })).toEqual({ ok: false, error: 'not-found' })
    expect(await h.pipelineDiscard({ projectId: ID, runId: 'r' })).toEqual({ ok: false, error: 'cleanup-failed' })
    expect(await h.pipelineResume({ projectId: ID, runId: 'r' })).toEqual({ ok: false, error: 'resume-failed' })
    expect(JSON.stringify(spy.mock.calls)).not.toContain('someone')
    expect(spy.mock.calls[0]).toEqual(['pipeline:plans failed:', 'RangeError'])
  })

  it('reports storage-unavailable when no pipeline service exists', async () => {
    const { h } = setup()
    expect(await h.pipelineStart({ projectId: ID, planFile: 'a.md' })).toEqual({ ok: false, error: 'storage-unavailable' })
    expect(await h.pipelineStatus({ projectId: ID })).toEqual({ ok: false, error: 'storage-unavailable' })
  })
})
