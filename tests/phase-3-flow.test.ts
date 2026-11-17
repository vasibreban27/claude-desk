import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface QueryParams {
  prompt: string
  options: Record<string, unknown>
}
const sdk = vi.hoisted(() => ({
  calls: [] as QueryParams[],
  /** Runs inside query(): lets a test fire hooks or wait while the turn is "running". */
  script: (async () => {}) as (params: QueryParams) => Promise<void>
}))

// Only `query` is replaced; createSdkMcpServer and the rest stay real.
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return {
    ...actual,
    query: (params: QueryParams) => {
      sdk.calls.push(params)
      return (async function* () {
        await sdk.script(params)
        yield { type: 'system', session_id: `sess-${sdk.calls.length}` }
      })()
    }
  }
})

const electron = vi.hoisted(() => ({
  exposed: {} as Record<string, unknown>,
  invoked: [] as Array<{ channel: string; args: unknown[] }>
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => (electron.exposed[name] = api) },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      electron.invoked.push({ channel, args })
      return Promise.resolve(null)
    },
    on: () => undefined,
    removeListener: () => undefined
  }
}))

import { sdkRunner } from '../src/main/chat/runner'
import { ChatService } from '../src/main/chat/service'
import { GIT_ALLOWED_TOOLS, GIT_SERVER_NAME } from '../src/main/chat/gitTools'
import { isDenied, type GuardOutput } from '../src/main/chat/tools'
import { readToolkitInfo } from '../src/main/config'
import { createSettingsStore, openDatabase, type SettingsStore } from '../src/main/db'
import { createHandlers, type Handlers } from '../src/main/ipc/handlers'
import type { ProjectStore } from '../src/main/projects/store'
import { IPC, type ChatEvent } from '../src/shared/ipc'
import { defaultSettings, type ProjectSettings } from '../src/shared/settings'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const OTHER = '99999999-9999-4999-8999-999999999999'

type HookFn = (input: unknown, id: string | undefined, opts: { signal: AbortSignal }) => Promise<GuardOutput>
type HookMap = Record<string, Array<{ hooks: unknown[] }>>

/** Fires the PreToolUse guard exactly as the SDK would, from the options the runner built. */
async function preToolUse(options: Record<string, unknown>, cwd: string, tool: string, input: Record<string, unknown>) {
  const hooks = options['hooks'] as HookMap
  const cb = hooks['PreToolUse']?.[0]?.hooks[0] as HookFn
  return cb(
    { hook_event_name: 'PreToolUse', session_id: 's', transcript_path: '', cwd, tool_name: tool, tool_use_id: 't', tool_input: input },
    undefined,
    { signal: new AbortController().signal }
  )
}

const withSettings = (patch: Partial<ProjectSettings>): ProjectSettings => ({ ...defaultSettings(), ...patch })

describe('phase 3 flow (real handlers, service, runner and settings store; SDK query mocked)', () => {
  let root: string
  let project: string
  let db: Database.Database
  let toolkit: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'desk-p3-')))
    project = join(root, 'project')
    toolkit = join(root, 'toolkit')
    mkdirSync(project)
    mkdirSync(join(project, 'secrets'))
    // Files are created here, not by shell commands.
    writeFileSync(join(project, '.env'), 'TOKEN=not-a-real-secret\n')
    writeFileSync(join(project, '.env.example'), 'TOKEN=\n')
    writeFileSync(join(project, 'readme.txt'), 'hello\n')
    writeFileSync(join(project, 'secrets', 'a.txt'), 'x\n')
    db = openDatabase(':memory:')
    sdk.calls = []
    sdk.script = async () => {}
    electron.exposed = {}
    electron.invoked = []
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  function setup(settingsStore: SettingsStore, toolkitInfo = () => readToolkitInfo({}) as ReturnType<typeof readToolkitInfo>) {
    const waiters: Array<(e: ChatEvent) => void> = []
    const chat = new ChatService({
      resolveProjectPath: (id) => (id === PROJECT ? project : undefined),
      runner: sdkRunner,
      emit: (e) => waiters.forEach((w) => w(e)),
      settings: settingsStore,
      loadConfig: () => ({ ok: true, config: { toolkitPath: toolkit } })
    })
    const store = {
      get: async (id: string) => (id === PROJECT ? { id, path: project } : undefined)
    } as unknown as ProjectStore
    const h: Handlers = createHandlers({
      store,
      readGitStatus: async () => {
        throw new Error('unused')
      },
      pickFolder: async () => undefined,
      chat,
      settingsStore,
      readToolkitInfo: toolkitInfo
    })
    /** Sends a turn and resolves when it is done or failed. */
    const turn = async (text = 'go'): Promise<ChatEvent> => {
      const finished = new Promise<ChatEvent>((resolve) =>
        waiters.push((e) => {
          if (e.type === 'done' || e.type === 'error') resolve(e)
        })
      )
      expect(await h.chatSend({ projectId: PROJECT, text })).toMatchObject({ ok: true })
      return finished
    }
    return { h, turn }
  }

  const lastOptions = (): Record<string, unknown> => {
    const call = sdk.calls.at(-1)
    if (!call) throw new Error('no query call')
    return call.options
  }

  it('saved model and git capability reach the SDK options; both off sends neither', async () => {
    const { h, turn } = setup(createSettingsStore(db))

    const saved = await h.settingsSet({ projectId: PROJECT, settings: withSettings({ model: 'haiku', allowGitRead: true }) })
    expect(saved).toMatchObject({ ok: true, sessionReset: false })
    expect((await turn()).type).toBe('done')
    let o = lastOptions()
    expect(o['model']).toBe('haiku')
    expect(o['allowedTools']).toEqual(expect.arrayContaining([...GIT_ALLOWED_TOOLS]))
    expect(Object.keys(o['mcpServers'] as object)).toEqual([GIT_SERVER_NAME])
    expect(o['allowedTools']).not.toContain('Write')

    await h.settingsSet({ projectId: PROJECT, settings: withSettings({}) })
    expect((await turn()).type).toBe('done')
    o = lastOptions()
    expect(o).not.toHaveProperty('model')
    expect(o).not.toHaveProperty('mcpServers')
    for (const t of GIT_ALLOWED_TOOLS) expect(o['allowedTools']).not.toContain(t)
    expect(o['allowedTools']).not.toContain('Write')
    expect(o['settingSources']).toEqual([])
  })

  it('allowPlanWrites adds exactly Write to the allowed tools', async () => {
    const { h, turn } = setup(createSettingsStore(db))
    await h.settingsSet({ projectId: PROJECT, settings: withSettings({ allowPlanWrites: true }) })
    await turn()
    const o = lastOptions()
    expect(o['allowedTools']).toContain('Write')
    expect(o).not.toHaveProperty('mcpServers')
    const slugPlan = await preToolUse(o, project, 'Write', { file_path: join(project, 'docs', 'plans', 'a-plan.md'), content: '# p' })
    expect(isDenied(slugPlan)).toBe(false)
    const other = await preToolUse(o, project, 'Write', { file_path: join(project, 'readme.txt'), content: 'x' })
    expect(isDenied(other)).toBe(true)

    await h.settingsSet({ projectId: PROJECT, settings: withSettings({}) })
    await turn()
    const off = await preToolUse(lastOptions(), project, 'Write', { file_path: join(project, 'docs', 'plans', 'a-plan.md'), content: '# p' })
    expect(isDenied(off)).toBe(true)
  })

  it('a saved protected-paths list is enforced by the guard of that same turn', async () => {
    const { h, turn } = setup(createSettingsStore(db))
    await h.settingsSet({
      projectId: PROJECT,
      settings: withSettings({ protectedPaths: ['.env', '.env.*', '!.env.example', 'secrets/'] })
    })
    const verdicts: Record<string, boolean> = {}
    sdk.script = async ({ options }) => {
      for (const name of ['.env', '.env.example', 'readme.txt', join('secrets', 'a.txt')]) {
        verdicts[name] = isDenied(await preToolUse(options, project, 'Read', { file_path: join(project, name) }))
      }
    }
    expect((await turn()).type).toBe('done')
    expect(verdicts).toEqual({ '.env': true, '.env.example': false, 'readme.txt': false, [join('secrets', 'a.txt')]: true })

    // Emptying the list lifts the protection on the next turn.
    await h.settingsSet({ projectId: PROJECT, settings: withSettings({ protectedPaths: [] }) })
    await turn()
    expect(isDenied(await preToolUse(lastOptions(), project, 'Read', { file_path: join(project, '.env') }))).toBe(false)
  })

  it('a corrupt project_settings row runs with the safe defaults and is reported', async () => {
    const { h, turn } = setup(createSettingsStore(db))
    db.prepare('INSERT INTO project_settings (project_id, settings, updated_at) VALUES (?, ?, ?)').run(PROJECT, '{not json', 1)

    expect(await h.settingsGet({ projectId: PROJECT })).toEqual({
      ok: true,
      settings: defaultSettings(),
      notice: 'defaults-applied'
    })
    expect((await turn()).type).toBe('done')
    const o = lastOptions()
    expect(o).not.toHaveProperty('model')
    expect(o).not.toHaveProperty('mcpServers')
    expect(o['allowedTools']).not.toContain('Write')
    expect(isDenied(await preToolUse(o, project, 'Read', { file_path: join(project, '.env') }))).toBe(true)
    expect(isDenied(await preToolUse(o, project, 'Read', { file_path: join(project, '.env.example') }))).toBe(false)

    // A schema-invalid row (unknown model) is treated the same way.
    db.prepare('UPDATE project_settings SET settings = ?').run(JSON.stringify({ ...defaultSettings(), model: 'gpt' }))
    expect(await h.settingsGet({ projectId: PROJECT })).toMatchObject({ notice: 'defaults-applied' })

    // The corrupt row is not overwritten until the user saves.
    const raw = db.prepare('SELECT settings FROM project_settings').get() as { settings: string }
    expect(raw.settings).toContain('gpt')
    expect(await h.settingsSet({ projectId: PROJECT, settings: withSettings({ model: 'sonnet' }) })).toMatchObject({ ok: true })
    expect(await h.settingsGet({ projectId: PROJECT })).toMatchObject({ notice: null, settings: { model: 'sonnet' } })
  })

  it('a missing row gives the defaults without a notice', async () => {
    const { h } = setup(createSettingsStore(db))
    expect(await h.settingsGet({ projectId: PROJECT })).toEqual({ ok: true, settings: defaultSettings(), notice: null })
    expect(await h.settingsGet({ projectId: OTHER })).toEqual({ ok: false, error: 'not-found' })
    expect(await h.settingsGet({ projectId: 'nope' })).toEqual({ ok: false, error: 'not-found' })
    expect(await h.settingsSet({ projectId: PROJECT, settings: { version: 1 } })).toEqual({ ok: false, error: 'invalid' })
  })

  it('without a database the app still chats with the defaults and reports storage-unavailable', async () => {
    const { h, turn } = setup(createSettingsStore(null))
    expect(await h.settingsGet({ projectId: PROJECT })).toEqual({
      ok: true,
      settings: defaultSettings(),
      notice: 'storage-unavailable'
    })
    expect(await h.settingsSet({ projectId: PROJECT, settings: withSettings({ allowGitRead: true }) })).toEqual({
      ok: false,
      error: 'storage-unavailable'
    })
    expect((await turn()).type).toBe('done')
    const o = lastOptions()
    expect(o).not.toHaveProperty('mcpServers')
    expect(o).not.toHaveProperty('model')
    expect(isDenied(await preToolUse(o, project, 'Read', { file_path: join(project, '.env') }))).toBe(true)
  })

  it('a store whose reads throw falls back to the defaults and the turn still runs', async () => {
    const broken: SettingsStore = {
      get: () => {
        throw new Error('boom')
      },
      set: () => ({ ok: false, error: 'storage-unavailable' })
    }
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { turn } = setup(broken)
    expect((await turn()).type).toBe('done')
    expect(lastOptions()).not.toHaveProperty('mcpServers')
    vi.restoreAllMocks()
  })

  it('settings changed between turns apply to the next turn, not to a run in progress', async () => {
    const { h, turn } = setup(createSettingsStore(db))
    await h.settingsSet({ projectId: PROJECT, settings: withSettings({ model: 'haiku' }) })

    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let started: () => void = () => {}
    const running = new Promise<void>((r) => (started = r))
    sdk.script = async () => {
      started()
      await gate
    }
    const first = turn()
    await running
    // The run is in progress: change everything.
    expect(
      await h.settingsSet({
        projectId: PROJECT,
        settings: withSettings({ model: 'opus', allowGitRead: true, protectedPaths: [] })
      })
    ).toMatchObject({ ok: true })
    release()
    expect((await first).type).toBe('done')

    const firstOptions = lastOptions()
    expect(firstOptions['model']).toBe('haiku')
    expect(firstOptions).not.toHaveProperty('mcpServers')
    // The running turn's guard still protects .env.
    expect(isDenied(await preToolUse(firstOptions, project, 'Read', { file_path: join(project, '.env') }))).toBe(true)

    sdk.script = async () => {}
    expect((await turn()).type).toBe('done')
    const second = lastOptions()
    expect(second['model']).toBe('opus')
    expect(Object.keys(second['mcpServers'] as object)).toEqual([GIT_SERVER_NAME])
    expect(isDenied(await preToolUse(second, project, 'Read', { file_path: join(project, '.env') }))).toBe(false)
    // Model and tool changes keep the session (the spike showed resume honours them).
    expect(second['resume']).toBe('sess-1')
  })

  it('app:info round trip: valid, invalid and unset toolkit', async () => {
    const manifestDir = join(toolkit, '.claude-plugin')
    mkdirSync(manifestDir, { recursive: true })
    const store = createSettingsStore(db)

    writeFileSync(join(manifestDir, 'plugin.json'), JSON.stringify({ name: 'flow', version: '1.2.3' }))
    const valid = setup(store, () => readToolkitInfo({ CLAUDE_TOOLKIT_PATH: toolkit }))
    expect(await valid.h.appInfo()).toEqual({ toolkit: { status: 'valid', path: toolkit, version: '1.2.3' } })

    writeFileSync(join(manifestDir, 'plugin.json'), '{ broken')
    const broken = setup(store, () => readToolkitInfo({ CLAUDE_TOOLKIT_PATH: toolkit }))
    expect(await broken.h.appInfo()).toEqual({ toolkit: { status: 'invalid', path: toolkit, version: null } })

    const missing = setup(store, () => readToolkitInfo({ CLAUDE_TOOLKIT_PATH: join(root, 'nope') }))
    expect(await missing.h.appInfo()).toMatchObject({ toolkit: { status: 'invalid', version: null } })

    const unset = setup(store, () => readToolkitInfo({}))
    expect(await unset.h.appInfo()).toEqual({ toolkit: { status: 'unset', path: null, version: null } })
  })

  it('the preload bridge exposes settingsGet, settingsSet and appInfo on their channels', async () => {
    await import('../src/preload/index')
    const api = electron.exposed['api'] as Record<string, (...a: unknown[]) => Promise<unknown>>
    expect(Object.keys(api)).toEqual(expect.arrayContaining(['settingsGet', 'settingsSet', 'appInfo']))
    await api['settingsGet']?.({ projectId: PROJECT })
    await api['settingsSet']?.({ projectId: PROJECT, settings: defaultSettings() })
    await api['appInfo']?.()
    expect(electron.invoked.map((i) => i.channel)).toEqual([IPC.settingsGet, IPC.settingsSet, IPC.appInfo])
  })
})
