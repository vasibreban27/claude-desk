import { describe, expect, it } from 'vitest'
import { DEFAULT_PROTECTED_PATHS } from '../../shared/settings'
import { createProtectedMatcher } from './protectedPaths'

const posix = (patterns: readonly string[], realRoot = '/proj') =>
  createProtectedMatcher(patterns, { realRoot, platform: 'linux' })
const win = (patterns: readonly string[], realRoot = 'C:\\proj') =>
  createProtectedMatcher(patterns, { realRoot, platform: 'win32' })

describe('matcher gaps: negation order', () => {
  it('the last matching pattern wins', () => {
    expect(posix(['x.txt', '!x.txt']).isProtected('/proj/x.txt')).toBe(false)
    expect(posix(['!x.txt', 'x.txt']).isProtected('/proj/x.txt')).toBe(true)
    expect(posix(['.env*', '!.env.example', '.env.example']).isProtected('/proj/.env.example')).toBe(true)
  })

  it('a negation placed before the broad pattern does not re-include', () => {
    const m = posix(['!.env.example', '.env.*'])
    expect(m.isProtected('/proj/.env.example')).toBe(true)
  })

  it('cannot re-include a file under an excluded directory', () => {
    const m = posix(['secrets/', '!secrets/ok.txt'])
    expect(m.isProtected('/proj/secrets/ok.txt')).toBe(true)
    expect(m.isProtected('/proj/secrets/other.txt')).toBe(true)
  })

  it('can re-include under a wildcard-contents pattern', () => {
    const m = posix(['secrets/*', '!secrets/ok.txt'])
    expect(m.isProtected('/proj/secrets/ok.txt')).toBe(false)
    expect(m.isProtected('/proj/secrets/other.txt')).toBe(true)
  })

  it('a list of only negations protects nothing', () => {
    expect(posix(['!a', '!b']).isProtected('/proj/a')).toBe(false)
  })

  it('comment lines and escaped hashes', () => {
    const m = posix(['#not-a-pattern', '\\#real'])
    expect(m.isProtected('/proj/#not-a-pattern')).toBe(false)
    expect(m.isProtected('/proj/#real')).toBe(true)
  })
})

describe('matcher gaps: trailing-slash directory patterns', () => {
  const m = posix(['build/', 'a/b/'])

  it('protects the directory itself and everything below it', () => {
    expect(m.isProtected('/proj/build')).toBe(true)
    expect(m.isProtected('/proj/build/out.js')).toBe(true)
    expect(m.isProtected('/proj/build/deep/er/x')).toBe(true)
    expect(m.isProtected('/proj/a/b')).toBe(true)
    expect(m.isProtected('/proj/a/b/c')).toBe(true)
  })

  it('matches nested directories of that name, not lookalikes', () => {
    expect(m.isProtected('/proj/src/build/x')).toBe(true)
    expect(m.isProtected('/proj/builds/x')).toBe(false)
    expect(m.isProtected('/proj/build.txt')).toBe(false)
    expect(m.isProtected('/proj/a')).toBe(false)
  })

  it('a rooted directory pattern only matches at the root', () => {
    const r = posix(['/build/'])
    expect(r.isProtected('/proj/build/x')).toBe(true)
    expect(r.isProtected('/proj/src/build/x')).toBe(false)
  })

  it('the project root is never protected, even by a catch-all pattern', () => {
    expect(posix(['*']).check('/proj')).toBe('allowed')
    expect(posix(['*']).isProtected('/proj/x')).toBe(true)
  })

  it('the default .git/ pattern protects the directory and its contents', () => {
    const d = posix(DEFAULT_PROTECTED_PATHS)
    expect(d.isProtected('/proj/.git')).toBe(true)
    expect(d.isProtected('/proj/sub/.git/HEAD')).toBe(true)
    expect(d.isProtected('/proj/.github/x.yml')).toBe(false)
  })
})

describe('matcher gaps: `..` and outside paths', () => {
  it('normalizes `..` that stays inside the project', () => {
    const m = posix(DEFAULT_PROTECTED_PATHS)
    expect(m.check('/proj/src/../.env')).toBe('protected')
    expect(m.check('/proj/a/./b/../c.txt')).toBe('allowed')
  })

  it('`..` that escapes the project is outside and counts as protected', () => {
    const m = posix(DEFAULT_PROTECTED_PATHS)
    expect(m.check('/proj/src/../../etc/x')).toBe('outside')
    expect(m.isProtected('/proj/src/../../etc/x')).toBe(true)
  })

  it('a sibling directory sharing the root prefix is outside', () => {
    expect(posix([]).check('/proj2/a.txt')).toBe('outside')
    expect(posix([]).check('/pro')).toBe('outside')
  })

  it('a name that merely starts with two dots is inside the project', () => {
    expect(posix([]).check('/proj/..hidden/x')).toBe('allowed')
    expect(posix(['..hidden']).check('/proj/..hidden')).toBe('protected')
  })

  it('outside is reported even when the pattern list is empty', () => {
    expect(posix([]).check('/etc/passwd')).toBe('outside')
  })

  it('a trailing separator on the root or target does not matter', () => {
    expect(posix([], '/proj/').check('/proj/a.txt')).toBe('allowed')
    expect(posix([]).check('/proj/')).toBe('allowed')
  })

  it('never throws for odd targets and never reports them allowed', () => {
    const m = posix(DEFAULT_PROTECTED_PATHS)
    for (const t of ['', 'relative/.env', '\0', '/proj/a\0b', null, undefined, 42]) {
      expect(() => m.check(t as unknown as string), String(t)).not.toThrow()
      expect(m.check(t as unknown as string), String(t)).not.toBe('allowed')
    }
  })

  it('handles a very long target path', () => {
    const m = posix(DEFAULT_PROTECTED_PATHS)
    const deep = '/proj/' + Array(2000).fill('d').join('/')
    expect(m.check(deep)).toBe('allowed')
    expect(m.check(deep + '/.env')).toBe('protected')
  })
})

describe('matcher gaps: windows separators and case', () => {
  it('accepts forward slashes and mixed separators in the target', () => {
    const m = win(DEFAULT_PROTECTED_PATHS)
    expect(m.isProtected('C:/proj/sub/.env')).toBe(true)
    expect(m.isProtected('C:\\proj/sub\\.git/config')).toBe(true)
    expect(m.isProtected('C:/proj/src/a.ts')).toBe(false)
  })

  it('compares the root case-insensitively', () => {
    const m = win(DEFAULT_PROTECTED_PATHS)
    expect(m.check('c:\\PROJ\\src\\a.ts')).toBe('allowed')
    expect(m.isProtected('c:\\PROJ\\SRC\\.Env')).toBe(true)
  })

  it('matches directory patterns with backslash targets and any case', () => {
    const m = win(['Secrets/'])
    expect(m.isProtected('C:\\proj\\secrets')).toBe(true)
    expect(m.isProtected('C:\\proj\\SECRETS\\a\\b.txt')).toBe(true)
    expect(m.isProtected('C:\\proj\\secrets2\\a.txt')).toBe(false)
  })

  it('a root with a trailing backslash and the root itself', () => {
    const m = win([], 'C:\\proj\\')
    expect(m.check('C:\\proj')).toBe('allowed')
    expect(m.check('C:\\proj\\')).toBe('allowed')
    expect(m.check('C:\\proj\\a')).toBe('allowed')
  })

  it('`..` that escapes, other drives, UNC paths and sibling prefixes are outside', () => {
    const m = win(DEFAULT_PROTECTED_PATHS)
    expect(m.check('C:\\proj\\..\\x')).toBe('outside')
    expect(m.check('C:\\proj\\src\\..\\..\\x')).toBe('outside')
    expect(m.check('C:\\proj2\\a')).toBe('outside')
    expect(m.check('\\\\server\\share\\proj\\.env')).toBe('outside')
    expect(m.check('D:\\proj\\a')).toBe('outside')
  })

  it('`..` that stays inside is normalized', () => {
    expect(win(DEFAULT_PROTECTED_PATHS).check('C:\\proj\\src\\..\\.env')).toBe('protected')
  })

  it('a UNC project root works', () => {
    const m = win(DEFAULT_PROTECTED_PATHS, '\\\\srv\\share\\proj')
    expect(m.isProtected('\\\\srv\\share\\proj\\.env')).toBe(true)
    expect(m.check('\\\\srv\\share\\proj\\a.txt')).toBe('allowed')
    expect(m.check('\\\\srv\\other\\proj\\a.txt')).toBe('outside')
  })

})

describe('matcher gaps: pattern list shapes', () => {
  it('fails closed on non-array input', () => {
    for (const bad of [null, undefined, 'abc', { length: 1 }]) {
      const m = createProtectedMatcher(bad as unknown as string[], { realRoot: '/proj', platform: 'linux' })
      expect(m.usable).toBe(false)
      expect(m.isProtected('/proj/a')).toBe(true)
      expect(m.check('/proj/a')).toBe('protected')
      expect(m.check('/other')).toBe('protected')
    }
  })

  it('accepts a pattern of exactly 200 characters and rejects 201', () => {
    expect(posix(['x'.repeat(200)]).usable).toBe(true)
    const over = posix(['x'.repeat(201)])
    expect(over.usable).toBe(false)
    expect(over.isProtected('/proj/anything')).toBe(true)
  })

  it('one bad entry among many invalidates the whole list', () => {
    const list = [...Array(99).fill('ok'), '']
    const m = posix(list)
    expect(m.usable).toBe(false)
    expect(m.isProtected('/proj/safe.txt')).toBe(true)
  })

  it('handles a long list of patterns', () => {
    const list = Array.from({ length: 5000 }, (_v, i) => `dir${i}/`)
    const m = posix(list)
    expect(m.usable).toBe(true)
    expect(m.isProtected('/proj/dir4999/x')).toBe(true)
    expect(m.isProtected('/proj/dir5000/x')).toBe(false)
  })

  it('degenerate gitignore syntax is handled without throwing', () => {
    for (const p of ['!', '\\', '/', '//', '**', '***', '[', '[]', 'a/**/b', ' ', '  trailing  ']) {
      const m = posix([p])
      expect(() => m.check('/proj/a/b'), p).not.toThrow()
      if (!m.usable) expect(m.isProtected('/proj/a/b'), p).toBe(true)
    }
  })

  it('trailing spaces are ignored and a pattern that is only whitespace protects nothing', () => {
    expect(posix(['a  ']).isProtected('/proj/a')).toBe(true)
    expect(posix(['   ']).isProtected('/proj/a')).toBe(false)
  })

  it('matches names with spaces, unicode and glob metacharacters literally in the target', () => {
    const m = posix(['*.pem'])
    expect(m.isProtected('/proj/my key.pem')).toBe(true)
    expect(m.isProtected('/proj/é/ü.pem')).toBe(true)
    expect(m.isProtected('/proj/[x]/a.pem')).toBe(true)
  })
})
