import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APP_SETTINGS_FILE, openAppSettings } from './appSettings'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'appset-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('appSettings', () => {
  it('is unset by default and round-trips the root', async () => {
    const s = openAppSettings(dir)
    expect(await s.getProjectsRoot()).toBeNull()
    await s.setProjectsRoot(dir)
    expect(await s.getProjectsRoot()).toBe(path.resolve(dir))
  })
  it('treats a corrupt file as unset', async () => {
    writeFileSync(path.join(dir, APP_SETTINGS_FILE), '{nope')
    expect(await openAppSettings(dir).getProjectsRoot()).toBeNull()
  })
})
