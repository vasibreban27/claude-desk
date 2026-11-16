import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'electron-vite'
import { describe, expect, it } from 'vitest'
import { PRELOAD_FILE_NAME } from '../src/shared/build-output'

const root = resolve(import.meta.dirname, '..')

/**
 * Regression: the sandboxed preload threw on `require("zod")` (externalized by electron-vite),
 * so contextBridge never ran and window.api was undefined in the renderer.
 */
describe('built preload bundle (window.api undefined regression)', () => {
  it('exists where the main process loads it and requires nothing but electron', async () => {
    await build({ root, configFile: join(root, 'electron.vite.config.ts') })

    // main loads join(<out/main>, '../preload', PRELOAD_FILE_NAME)
    const preloadPath = join(root, 'out', 'preload', PRELOAD_FILE_NAME)
    expect(existsSync(preloadPath)).toBe(true)

    const code = readFileSync(preloadPath, 'utf8')
    const required = [...code.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])
    expect(required).toContain('electron')
    expect(required.filter((name) => name !== 'electron')).toEqual([])
    expect(/^\s*import\s.+from\s/m.test(code)).toBe(false)
  }, 60_000)
})
