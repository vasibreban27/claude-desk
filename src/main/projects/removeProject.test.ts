import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../shared/ipc'
import { removeProject, unsafeToDelete } from './removeProject'

let dir: string
let projectDir: string
const project = (): Project => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'demo',
  path: projectDir,
  branch: 'main',
  dirty: false,
  addedAt: '2026-01-01T00:00:00.000Z'
})

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'remove-')))
  projectDir = path.join(dir, 'demo')
  mkdirSync(projectDir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function deps(over: Partial<Parameters<typeof removeProject>[2]> = {}) {
  const p = project()
  return {
    store: { get: vi.fn(async (id: string) => (id === p.id ? p : undefined)), remove: vi.fn(async () => true) },
    trash: vi.fn(async () => undefined),
    ...over
  }
}

describe('removeProject', () => {
  it('only unregisters when the folder is kept', async () => {
    const d = deps()
    expect(await removeProject(project().id, false, d)).toEqual({ ok: true, folderDeleted: false })
    expect(d.trash).not.toHaveBeenCalled()
    expect(d.store.remove).toHaveBeenCalledWith(project().id)
  })

  it('moves the folder to the Recycle Bin, cleans up runs first, then unregisters', async () => {
    const order: string[] = []
    const d = deps({
      trash: vi.fn(async () => void order.push('trash')),
      cleanupRuns: vi.fn(async () => void order.push('cleanup'))
    })
    expect(await removeProject(project().id, true, d)).toEqual({ ok: true, folderDeleted: true })
    expect(d.trash).toHaveBeenCalledWith(projectDir)
    expect(order).toEqual(['cleanup', 'trash'])
  })

  it('refuses while a pipeline run is active and keeps the project', async () => {
    const d = deps({ isBusy: async () => true })
    expect(await removeProject(project().id, true, d)).toMatchObject({ ok: false, error: 'busy' })
    expect(d.trash).not.toHaveBeenCalled()
    expect(d.store.remove).not.toHaveBeenCalled()
  })

  it('keeps the project registered when the Recycle Bin move fails', async () => {
    const d = deps({ trash: vi.fn(async () => Promise.reject(new Error('locked'))) })
    expect(await removeProject(project().id, true, d)).toMatchObject({ ok: false, error: 'trash-failed' })
    expect(d.store.remove).not.toHaveBeenCalled()
  })

  it('removes a project whose folder is already gone without trashing anything', async () => {
    rmSync(projectDir, { recursive: true })
    const d = deps()
    expect(await removeProject(project().id, true, d)).toEqual({ ok: true, folderDeleted: false })
    expect(d.trash).not.toHaveBeenCalled()
  })

  it('refuses a protected folder', async () => {
    const d = deps({ protectedFolders: [path.join(projectDir, 'data')] })
    expect(await removeProject(project().id, true, d)).toMatchObject({ ok: false, error: 'unsafe-path' })
    expect(d.trash).not.toHaveBeenCalled()
  })

  it('returns not-found for an unknown id', async () => {
    expect(await removeProject('22222222-2222-4222-8222-222222222222', false, deps())).toEqual({ ok: false, error: 'not-found' })
  })
})

describe('unsafeToDelete', () => {
  it('refuses roots, the home folder and its parents, and links', async () => {
    expect(await unsafeToDelete(path.parse(dir).root)).toMatch(/root/)
    expect(await unsafeToDelete(os.homedir())).toMatch(/home/)
    expect(await unsafeToDelete(path.dirname(os.homedir()))).toMatch(/home/)
    expect(await unsafeToDelete(projectDir)).toBeNull()
    const link = path.join(dir, 'link')
    try {
      symlinkSync(projectDir, link, 'junction')
    } catch {
      return
    }
    expect(await unsafeToDelete(link)).toMatch(/link/)
  })
})
