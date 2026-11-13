import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { whenReady: () => new Promise(() => undefined), on: vi.fn(), quit: vi.fn() },
  BrowserWindow: class {}
}))

import { getWindowOptions } from './index'

describe('getWindowOptions', () => {
  it('enables context isolation and disables node integration', () => {
    const opts = getWindowOptions('/preload.js')
    expect(opts.webPreferences?.contextIsolation).toBe(true)
    expect(opts.webPreferences?.nodeIntegration).toBe(false)
    expect(opts.webPreferences?.preload).toBe('/preload.js')
  })
})
