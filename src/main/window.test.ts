import { basename } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Gap coverage for T1 / F1: the real createWindow path must hand a sandbox-safe CJS preload to Electron.
const created: { opts: Record<string, unknown> }[] = []
const loadFile = vi.fn(() => Promise.resolve())
const loadURL = vi.fn(() => Promise.resolve())

vi.mock('electron', () => ({
  // isPackaged: true keeps loadDevEnv from reading this machine's project .env during tests.
  app: { whenReady: () => Promise.resolve(), on: vi.fn(), quit: vi.fn(), getPath: () => '/userdata', setName: vi.fn(), setPath: vi.fn(), isPackaged: true, getAppPath: () => '/app' },
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return []
    }
    constructor(opts: Record<string, unknown>) {
      created.push({ opts })
    }
    once = vi.fn()
    loadFile = loadFile
    loadURL = loadURL
  }
}))

vi.mock('./ipc/register', () => ({ registerIpc: vi.fn(() => () => undefined) }))
vi.mock('./projects/store', () => ({ openJsonProjectStore: vi.fn(async () => ({})) }))

/** Startup reads the app settings before it creates the window: wait until the window exists. */
const tick = (): Promise<void> => vi.waitFor(() => expect(created.length).toBeGreaterThan(0))

describe('createWindow (F1 regression)', () => {
  beforeEach(() => {
    created.length = 0
    loadFile.mockClear()
    loadURL.mockClear()
    vi.resetModules()
    delete process.env['ELECTRON_RENDERER_URL']
  })

  it('F1: passes a .cjs preload path from the preload output dir, with a secure sandbox', async () => {
    await import('./index')
    await tick()
    expect(created).toHaveLength(1)
    const prefs = created[0]!.opts['webPreferences'] as Record<string, unknown>
    const preload = String(prefs['preload'])
    const { PRELOAD_FILE_NAME } = await import('../shared/build-output')
    expect(basename(preload)).toBe(PRELOAD_FILE_NAME)
    expect(preload).toMatch(/\.cjs$/)
    expect(preload.replace(/\\/g, '/')).toContain('/preload/')
    expect(prefs['sandbox']).toBe(true)
    expect(prefs['contextIsolation']).toBe(true)
    expect(prefs['nodeIntegration']).toBe(false)
  })

  it('loads the built file by default', async () => {
    await import('./index')
    await tick()
    expect(loadFile).toHaveBeenCalledTimes(1)
    expect(loadURL).not.toHaveBeenCalled()
  })

  it('loads the dev server URL when ELECTRON_RENDERER_URL is set', async () => {
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173'
    await import('./index')
    await tick()
    expect(loadURL).toHaveBeenCalledWith('http://localhost:5173')
    expect(loadFile).not.toHaveBeenCalled()
  })
})
