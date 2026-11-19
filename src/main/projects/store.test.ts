import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openJsonProjectStore, pathKey, STORE_FILE } from './store'

const root = mkdtempSync(join(tmpdir(), 'desk-store-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const newDir = (): string => join(root, `s${n++}`)
const repo = (name: string): string => join(root, 'repos', name)

describe('ProjectStore', () => {
  it('round-trips across re-open', async () => {
    const dir = newDir()
    const a = await openJsonProjectStore(dir)
    const res = await a.add({ path: repo('alpha'), branch: 'main', dirty: true })
    expect(res.ok).toBe(true)
    const b = await openJsonProjectStore(dir)
    const list = await b.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'alpha', branch: 'main', dirty: true })
  })

  it('rejects duplicates, including different slashes and case on win32', async () => {
    const s = await openJsonProjectStore(newDir())
    await s.add({ path: repo('dup'), branch: null, dirty: false })
    const again = await s.add({ path: repo('dup') + '/', branch: null, dirty: false })
    expect(again).toEqual({ ok: false, error: 'duplicate' })
    if (process.platform === 'win32') {
      const upper = await s.add({ path: repo('dup').toUpperCase(), branch: null, dirty: false })
      expect(upper).toEqual({ ok: false, error: 'duplicate' })
    }
  })

  it('removes a project persistently and reports unknown ids', async () => {
    const dir = newDir()
    const a = await openJsonProjectStore(dir)
    const res = await a.add({ path: repo('gone'), branch: 'main', dirty: false })
    if (!res.ok) throw new Error('add failed')
    expect(await a.remove(res.project.id)).toBe(true)
    expect(await a.remove(res.project.id)).toBe(false)
    expect(await (await openJsonProjectStore(dir)).list()).toEqual([])
  })

  it('pathKey is case-insensitive only on win32', () => {
    expect(pathKey('/A/b', 'win32')).toBe(pathKey('/a/B', 'win32'))
    expect(pathKey('/A/b', 'linux')).not.toBe(pathKey('/a/B', 'linux'))
  })

  it('starts empty and keeps a .bak for a corrupt file', async () => {
    const dir = newDir()
    const first = await openJsonProjectStore(dir)
    await first.add({ path: repo('x'), branch: 'main', dirty: false })
    writeFileSync(join(dir, STORE_FILE), '{not json', 'utf8')
    const s = await openJsonProjectStore(dir)
    expect(await s.list()).toEqual([])
    expect(readdirSync(dir)).toContain(`${STORE_FILE}.bak`)
    expect(readFileSync(join(dir, `${STORE_FILE}.bak`), 'utf8')).toBe('{not json')
  })

  it('treats schema-invalid content as corrupt', async () => {
    const dir = newDir()
    await openJsonProjectStore(dir)
    writeFileSync(join(dir, STORE_FILE), JSON.stringify([{ id: 'nope' }]), 'utf8')
    const s = await openJsonProjectStore(dir)
    expect(await s.list()).toEqual([])
    expect(readdirSync(dir)).toContain(`${STORE_FILE}.bak`)
  })

  it('updates and gets a project', async () => {
    const dir = newDir()
    const s = await openJsonProjectStore(dir)
    const res = await s.add({ path: repo('u'), branch: 'main', dirty: false })
    if (!res.ok) throw new Error('add failed')
    const up = await s.update(res.project.id, { branch: null, dirty: true })
    expect(up).toMatchObject({ branch: null, dirty: true })
    expect(await s.get(res.project.id)).toMatchObject({ dirty: true })
    const missing = '00000000-0000-4000-8000-000000000000'
    expect(await s.update(missing, { branch: 'x', dirty: false })).toBeUndefined()
    expect(await (await openJsonProjectStore(dir)).get(res.project.id)).toMatchObject({ dirty: true })
  })
})
