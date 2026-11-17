import path from 'node:path'
import ignore from 'ignore'

export type ProtectedCheck = 'protected' | 'allowed' | 'outside'

export interface ProtectedMatcherOptions {
  /** Real (symlink-resolved) project root. */
  realRoot: string
  platform?: NodeJS.Platform
}

export interface ProtectedMatcher {
  /** False when the pattern list was unusable; the caller must fall back to the defaults. */
  readonly usable: boolean
  /** Classifies a real (resolved) absolute target path. Unusable matchers report everything as protected. */
  check(realTarget: string): ProtectedCheck
  /** True unless the target is allowed (outside and unusable both count as protected: fail closed). */
  isProtected(realTarget: string): boolean
}

function validPatterns(patterns: readonly unknown[]): patterns is string[] {
  return patterns.every(
    (p) => typeof p === 'string' && p.length > 0 && p.length <= 200 && !p.includes('\0'),
  )
}

export function createProtectedMatcher(
  patterns: readonly string[],
  options: ProtectedMatcherOptions,
): ProtectedMatcher {
  const platform = options.platform ?? process.platform
  const p = platform === 'win32' ? path.win32 : path.posix

  let ig: ReturnType<typeof ignore> | null = null
  let usable = false
  try {
    if (Array.isArray(patterns) && validPatterns(patterns)) {
      ig = ignore({ ignorecase: platform === 'win32' }).add(patterns)
      usable = true
    }
  } catch {
    ig = null
    usable = false
  }

  const check = (realTarget: string): ProtectedCheck => {
    if (!usable || ig === null || typeof realTarget !== 'string' || realTarget.includes('\0')) {
      return 'protected'
    }
    const rel = p.relative(options.realRoot, realTarget)
    if (rel === '') return 'allowed' // the root itself
    const posixRel = rel.split(p.sep).join('/')
    const segments = posixRel.split('/')
    if (p.isAbsolute(rel) || segments[0] === '..') return 'outside'
    try {
      // Test as a file and as a directory so `dir/` patterns match the directory itself.
      return ig.ignores(posixRel) || ig.ignores(posixRel + '/') ? 'protected' : 'allowed'
    } catch {
      return 'protected'
    }
  }

  return {
    usable,
    check,
    isProtected: (realTarget) => check(realTarget) !== 'allowed',
  }
}
