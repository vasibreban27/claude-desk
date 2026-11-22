import { describe, expect, it, vi } from 'vitest'

/** Start-up calls, kept in a plain list: the module runs them once at import, before mock histories are cleared. */
const { appMock, appCalls } = vi.hoisted(() => {
  const appCalls: unknown[][] = []
  return { appCalls, appMock: {
    whenReady: () => new Promise(() => undefined),
    on: vi.fn(),
    quit: vi.fn(),
    // isPackaged: true keeps the module-level loadDevEnv from reading this machine's project .env during tests.
    isPackaged: true,
    getAppPath: () => '/app',
    getPath: (name: string) => (name === 'appData' ? '/appdata' : '/userdata'),
    setName: (...a: unknown[]) => void appCalls.push(['setName', ...a]),
    setPath: (...a: unknown[]) => void appCalls.push(['setPath', ...a])
  } }
})
vi.mock('electron', () => ({ app: appMock, BrowserWindow: class {} }))
const { loadEnvFile } = vi.hoisted(() => ({ loadEnvFile: vi.fn() }))
vi.mock('./config', () => ({ loadEnvFile }))
vi.mock('./ipc/register', () => ({ registerIpc: vi.fn(() => () => undefined) }))
const { openDatabase } = vi.hoisted(() => ({ openDatabase: vi.fn() }))
vi.mock('./db', async () => {
  const actual = await vi.importActual<typeof import('./db/settingsStore')>('./db/settingsStore')
  return {
    openDatabase,
    createRunStore: vi.fn(() => ({ recordRun: vi.fn(), summary: vi.fn() })),
    createSettingsStore: actual.createSettingsStore,
    createPipelineStore: vi.fn((db: unknown) => ({ marker: 'pipeline', db }))
  }
})
vi.mock('./projects/store', () => ({ openJsonProjectStore: vi.fn() }))

import { bootstrapStores, getWindowOptions, loadDevEnv, openRunStore } from './index'

describe('loadDevEnv', () => {
  it('does nothing in a packaged app', () => {
    loadEnvFile.mockClear()
    loadDevEnv(true, '/app')
    expect(loadEnvFile).not.toHaveBeenCalled()
  })

  it('loads <appPath>/.env in development', () => {
    loadEnvFile.mockClear()
    loadEnvFile.mockReturnValue('loaded')
    loadDevEnv(false, '/proj')
    expect(loadEnvFile).toHaveBeenCalledWith('/proj')
  })

  it('stays quiet when the file is missing and logs a fixed message when reading fails', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    loadEnvFile.mockReturnValue('missing')
    loadDevEnv(false, '/proj')
    expect(spy).not.toHaveBeenCalled()
    loadEnvFile.mockReturnValue('failed')
    loadDevEnv(false, '/proj')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]).toEqual(['reading .env failed'])
    spy.mockRestore()
  })
})

describe('getWindowOptions', () => {
  it('enables context isolation and disables node integration', () => {
    const opts = getWindowOptions('/preload.js')
    expect(opts.webPreferences?.contextIsolation).toBe(true)
    expect(opts.webPreferences?.nodeIntegration).toBe(false)
    expect(opts.webPreferences?.preload).toBe('/preload.js')
  })
})

describe('preload build output', () => {
  it('is emitted as CJS under the file name the main process loads', async () => {
    const { PRELOAD_FILE_NAME } = await import('../shared/build-output')
    const cfg = (await import('../../electron.vite.config')).default
    const output = cfg.preload?.build?.rollupOptions?.output
    const out = Array.isArray(output) ? output[0] : output
    expect(out?.format).toBe('cjs')
    expect(out?.entryFileNames).toBe(PRELOAD_FILE_NAME)
    expect(PRELOAD_FILE_NAME).toMatch(/\.c?js$/)
  })
})

describe('bootstrapStores', () => {
  it('falls back to the unavailable settings store when the database cannot be opened', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    openDatabase.mockImplementation(() => {
      throw new RangeError('cannot open')
    })
    const stores = bootstrapStores('/data')
    expect(stores.db).toBeUndefined()
    expect(stores.runStore).toBeUndefined()
    expect(stores.settingsStore.get('p1')).toMatchObject({ notice: 'storage-unavailable' })
    spy.mockRestore()
  })

  it('falls back to the unavailable settings store when preparing statements throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const db = {
      prepare: vi.fn(() => {
        throw new TypeError('no such table: /home/someone/x')
      })
    }
    openDatabase.mockReset()
    openDatabase.mockReturnValue(db)
    const stores = bootstrapStores('/data')
    expect(stores.db).toBe(db)
    expect(stores.runStore).toBeDefined()
    expect(stores.settingsStore.get('p1')).toMatchObject({ notice: 'storage-unavailable' })
    expect(stores.settingsStore.set('p1', {} as never)).toEqual({ ok: false, error: 'storage-unavailable' })
    expect(JSON.stringify(spy.mock.calls)).not.toContain('someone')
    expect(spy.mock.calls[0]![1]).toBe('TypeError')
    spy.mockRestore()
  })
})

describe('bootstrapStores pipeline store', () => {
  it('returns a pipeline store over the same database, and an unavailable one without a database', () => {
    const db = { prepare: vi.fn() }
    openDatabase.mockReset()
    openDatabase.mockReturnValue(db)
    expect(bootstrapStores('/data').pipelineStore).toMatchObject({ marker: 'pipeline', db })
    openDatabase.mockImplementation(() => {
      throw new RangeError('x')
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(bootstrapStores('/data').pipelineStore).toMatchObject({ marker: 'pipeline', db: null })
    spy.mockRestore()
  })
})

describe('openRunStore', () => {
  it('opens claude-desk.db in the data dir', () => {
    const db = { close: vi.fn() }
    openDatabase.mockReturnValue(db)
    const opened = openRunStore('/data')
    expect(openDatabase).toHaveBeenCalledWith(expect.stringMatching(/claude-desk\.db$/))
    expect(opened?.db).toBe(db)
  })

  it('returns undefined and logs only the error name when opening fails', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    openDatabase.mockImplementation(() => {
      throw new RangeError('cannot open /home/someone/data')
    })
    expect(openRunStore('/data')).toBeUndefined()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(spy.mock.calls)).not.toContain('someone')
    expect(spy.mock.calls[0]![1]).toBe('RangeError')
    spy.mockRestore()
  })
})

describe('app name', () => {
  it('shows Odyssey but keeps the original data folder', async () => {
    const path = await import('node:path')
    expect(appMock).toBeDefined()
    expect(appCalls).toContainEqual(['setName', 'Odyssey'])
    expect(appCalls).toContainEqual(['setPath', 'userData', path.join('/appdata', 'claude-desk')])
  })
})
