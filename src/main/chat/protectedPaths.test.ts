import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROTECTED_PATHS } from '../../shared/settings'
import { createProtectedMatcher } from './protectedPaths'

describe('createProtectedMatcher (posix)', () => {
  const root = '/proj'
  const m = createProtectedMatcher(DEFAULT_PROTECTED_PATHS, { realRoot: root, platform: 'linux' })

  it('protects the default secret shapes', () => {
    for (const f of ['.env', '.env.local', 'a/b/.env', 'x.pem', 'k.key', '.git', '.git/config']) {
      expect(m.isProtected(`${root}/${f}`), f).toBe(true)
    }
  })

  it('allows .env.example and ordinary files', () => {
    expect(m.isProtected(`${root}/.env.example`)).toBe(false)
    expect(m.isProtected(`${root}/src/env.ts`)).toBe(false)
    expect(m.check(root)).toBe('allowed')
  })

  it('is case-sensitive on posix', () => {
    expect(m.isProtected(`${root}/A/.ENV`)).toBe(false)
  })

  it('reports outside targets without throwing', () => {
    expect(m.check('/other/.env')).toBe('outside')
    expect(m.check('/proj/../x')).toBe('outside')
    expect(m.check('/')).toBe('outside')
    expect(m.isProtected('/other/file.txt')).toBe(true)
  })

  it('protects nothing for an empty list', () => {
    const e = createProtectedMatcher([], { realRoot: root, platform: 'linux' })
    expect(e.usable).toBe(true)
    expect(e.isProtected(`${root}/.env`)).toBe(false)
  })

  it('fails closed on an invalid entry', () => {
    const bad = createProtectedMatcher(['ok', 42 as unknown as string], {
      realRoot: root,
      platform: 'linux',
    })
    expect(bad.usable).toBe(false)
    expect(bad.isProtected(`${root}/src/a.ts`)).toBe(true)
    const nul = createProtectedMatcher(['a\0b'], { realRoot: root, platform: 'linux' })
    expect(nul.usable).toBe(false)
    const empty = createProtectedMatcher([''], { realRoot: root, platform: 'linux' })
    expect(empty.usable).toBe(false)
  })
})

describe('createProtectedMatcher (win32)', () => {
  const root = 'C:\\proj'
  const m = createProtectedMatcher(DEFAULT_PROTECTED_PATHS, { realRoot: root, platform: 'win32' })

  it('matches case-insensitively with backslashes', () => {
    expect(m.isProtected('C:\\proj\\A\\.ENV')).toBe(true)
    expect(m.isProtected('C:\\proj\\sub\\KEY.PEM')).toBe(true)
    expect(m.isProtected('C:\\proj\\.env.example')).toBe(false)
  })

  it('reports other drives and parents as outside', () => {
    expect(m.check('D:\\proj\\.env')).toBe('outside')
    expect(m.check('C:\\other\\.env')).toBe('outside')
  })
})

describe('links', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-')))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('protects a link target once the caller passes the real path', (ctx) => {
    fs.writeFileSync(path.join(dir, '.env'), 'S=1')
    const link = path.join(dir, 'link.txt')
    try {
      fs.symlinkSync(path.join(dir, '.env'), link, 'file')
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return ctx.skip()
      throw e
    }
    const m = createProtectedMatcher(DEFAULT_PROTECTED_PATHS, { realRoot: dir })
    expect(m.isProtected(link)).toBe(false) // lexical path is not protected
    expect(m.isProtected(fs.realpathSync(link))).toBe(true)
  })
})
