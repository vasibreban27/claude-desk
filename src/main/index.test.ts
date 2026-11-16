import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  // isPackaged: true keeps the module-level loadDevEnv from reading this machine's project .env during tests.
  app: { whenReady: () => new Promise(() => undefined), on: vi.fn(), quit: vi.fn(), isPackaged: true, getAppPath: () => '/app' },
  BrowserWindow: class {}
}))
const { loadEnvFile } = vi.hoisted(() => ({ loadEnvFile: vi.fn() }))
vi.mock('./config', () => ({ loadEnvFile }))
vi.mock('./ipc/register', () => ({ registerIpc: vi.fn(() => () => undefined) }))
const { openDatabase } = vi.hoisted(() => ({ openDatabase: vi.fn() }))
vi.mock('./db', () => ({ openDatabase, createRunStore: vi.fn(() => ({ recordRun: vi.fn(), summary: vi.fn() })) }))
vi.mock('./projects/store', () => ({ openJsonProjectStore: vi.fn() }))

import { getWindowOptions, loadDevEnv, openRunStore } from './index'

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
