import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectStore } from './store'
import { createProject, validProjectName } from './createProject'

let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'projroot-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const store = (ok = true): ProjectStore =>
  ({
    add: vi.fn(async (i: { path: string }) =>
      ok ? { ok: true as const, project: { id: 'p1', name: path.basename(i.path), path: i.path, branch: null, dirty: false } } : { ok: false as const, error: 'duplicate' as const }
    )
  }) as unknown as ProjectStore

describe('validProjectName', () => {
  it.each([
    ['demo-app', true],
    ['', false],
    ['a', false],
    ['..', false],
    ['a/b', false],
    ['a\\b', false],
    ['Demo', false],
    ['con', false],
    ['nul', false],
    ['-abc', false],
    ['x'.repeat(50), false],
    ['x'.repeat(49), true]
  ])('%s -> %s', (n, expected) => expect(validProjectName(n)).toBe(expected))
})

describe('createProject', () => {
  it('creates a git repo and registers it', async () => {
    const git = vi.fn(async () => undefined)
    const s = store()
    const r = await createProject(root, 'demo-app', { store: s, git })
    expect(r.ok).toBe(true)
    expect(existsSync(path.join(root, 'demo-app'))).toBe(true)
    expect(git).toHaveBeenCalledTimes(2)
    expect(s.add).toHaveBeenCalledOnce()
  })

  it('rejects invalid names, missing root and existing folders', async () => {
    const git = vi.fn(async () => undefined)
    expect(await createProject(root, '../x', { store: store(), git })).toEqual({ ok: false, error: 'invalid-name' })
    expect(await createProject(null, 'okname', { store: store(), git })).toEqual({ ok: false, error: 'no-root' })
    mkdirSync(path.join(root, 'taken'))
    expect(await createProject(root, 'taken', { store: store(), git })).toEqual({ ok: false, error: 'exists' })
    expect(git).not.toHaveBeenCalled()
  })

  it('removes the folder when registration fails', async () => {
    const r = await createProject(root, 'demo-app', { store: store(false), git: async () => undefined })
    expect(r).toEqual({ ok: false, error: 'register-failed' })
    expect(existsSync(path.join(root, 'demo-app'))).toBe(false)
  })

  it('removes the folder when git fails', async () => {
    const r = await createProject(root, 'demo-app', { store: store(), git: async () => { throw new Error('x') } })
    expect(r).toEqual({ ok: false, error: 'git-failed' })
    expect(existsSync(path.join(root, 'demo-app'))).toBe(false)
  })

  it('rejects a root that is unusable', async () => {
    expect(await createProject(path.join(root, 'nope'), 'okname', { store: store(), git: async () => undefined })).toEqual({ ok: false, error: 'no-root' })
  })

  it('works through a symlinked root (resolved root, project stays inside)', async () => {
    const link = path.join(tmpdir(), `link-${path.basename(root)}`)
    try {
      symlinkSync(root, link, 'junction')
    } catch {
      return
    }
    try {
      const r = await createProject(link, 'demo-app', { store: store(), git: async () => undefined })
      expect(r.ok).toBe(true)
    } finally {
      rmSync(link, { force: true })
    }
  })
})
