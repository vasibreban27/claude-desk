import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { whenReady: () => new Promise(() => undefined), on: vi.fn(), quit: vi.fn() },
  BrowserWindow: class {}
}))
vi.mock('./ipc/register', () => ({ registerIpc: vi.fn(() => () => undefined) }))
vi.mock('./projects/store', () => ({ openJsonProjectStore: vi.fn() }))

import { getWindowOptions } from './index'

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
