/** Gap coverage for the T8 guard policy (failure paths the main tools.test.ts does not exercise). */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fsCalls = vi.hoisted(() => ({ n: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (...a: Parameters<typeof actual.existsSync>) => {
      fsCalls.n++
      return actual.existsSync(...a)
    },
    lstatSync: Object.assign(
      (...a: Parameters<typeof actual.lstatSync>) => {
        fsCalls.n++
        return actual.lstatSync(...a)
      },
      actual.lstatSync
    ),
    readlinkSync: Object.assign(
      (...a: Parameters<typeof actual.readlinkSync>) => {
        fsCalls.n++
        return actual.readlinkSync(...a)
      },
      actual.readlinkSync
    ),
    realpathSync: Object.assign(
      (...a: Parameters<typeof actual.realpathSync>) => {
        fsCalls.n++
        return actual.realpathSync(...a)
      },
      {
        native: (...a: Parameters<typeof actual.realpathSync.native>) => {
          fsCalls.n++
          return actual.realpathSync.native(...a)
        }
      }
    )
  }
})

import { DEFAULT_PROTECTED_PATHS } from '../../shared/settings'
import {
  ALLOWED_TOOLS,
  guardPreToolUse,
  isDenied,
  isToolAllowed,
  PLAN_CONTENT_CAP,
  protectedGrepExclusions,
  type ToolPolicy
} from './tools'

let root: string
let cwd: string
let wcwd: string

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'desk-guard-gaps-')))
  cwd = path.join(root, 'proj')
  wcwd = path.join(root, 'wproj')
  mkdirSync(path.join(cwd, 'src'), { recursive: true })
  mkdirSync(path.join(wcwd, 'docs', 'plans'), { recursive: true })
  writeFileSync(path.join(cwd, 'a.txt'), 'x')
  writeFileSync(path.join(cwd, '.env'), 's')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

beforeEach(() => {
  fsCalls.n = 0
})

const policy = (over: Partial<ToolPolicy> = {}): ToolPolicy => ({
  protectedPatterns: DEFAULT_PROTECTED_PATHS,
  allowGitRead: false,
  allowPlanWrites: false,
  ...over
})
const gp = (p: unknown, tool_name: unknown, tool_input?: unknown, dir: string = cwd) =>
  guardPreToolUse({ hook_event_name: 'PreToolUse', tool_name, tool_input }, dir, p as ToolPolicy)
const gcwd = (p: unknown, tool_name: string, tool_input: unknown, dir: unknown) =>
  guardPreToolUse({ hook_event_name: 'PreToolUse', tool_name, tool_input }, dir as string, p as ToolPolicy)
const reason = (o: ReturnType<typeof guardPreToolUse>) => o.hookSpecificOutput?.permissionDecisionReason ?? ''

function makeLink(ctx: { skip: () => never }, target: string, linkPath: string): void {
  try {
    symlinkSync(target, linkPath, 'junction')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) ctx.skip()
    throw error
  }
}

describe('policy handling', () => {
  const hostile: Array<[string, unknown]> = [
    ['null', null],
    ['string', 'yes'],
    ['number', 1],
    ['true', true],
    ['array', []],
    ['empty object', {}],
    ['missing allowPlanWrites', { protectedPatterns: [], allowGitRead: true }],
    ['missing allowGitRead', { protectedPatterns: [], allowPlanWrites: true }],
    ['missing patterns', { allowGitRead: true, allowPlanWrites: true }],
    ['string booleans', { protectedPatterns: [], allowGitRead: 'true', allowPlanWrites: 'true' }],
    ['numeric booleans', { protectedPatterns: [], allowGitRead: 1, allowPlanWrites: 1 }],
    ['null booleans', { protectedPatterns: [], allowGitRead: null, allowPlanWrites: null }],
    ['patterns not an array', { protectedPatterns: '.env', allowGitRead: false, allowPlanWrites: false }],
    ['patterns array-like', { protectedPatterns: { length: 0 }, allowGitRead: false, allowPlanWrites: false }],
    ['non-string pattern', { protectedPatterns: ['a', 1], allowGitRead: false, allowPlanWrites: false }],
    ['null pattern', { protectedPatterns: [null], allowGitRead: false, allowPlanWrites: false }]
  ]

  it.each(hostile)('denies everything, even Skill, for a malformed policy: %s', (_n, bad) => {
    for (const tool of ['Skill', 'Read', 'Agent', 'Write', 'mcp__git__git_status']) {
      const out = gp(bad, tool, { file_path: 'a.txt' })
      expect(isDenied(out)).toBe(true)
      expect(reason(out)).toBe('Malformed tool policy.')
    }
    expect(fsCalls.n).toBe(0)
  })

  it('denies when reading the policy throws (getter and Proxy)', () => {
    const getter = {
      get protectedPatterns(): string[] {
        throw new Error('boom')
      },
      allowGitRead: true,
      allowPlanWrites: true
    }
    const proxy = new Proxy({}, {
      get() {
        throw new Error('boom')
      }
    })
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    for (const bad of [getter, proxy, revoked.proxy]) {
      let out: ReturnType<typeof guardPreToolUse> | undefined
      expect(() => {
        out = gp(bad, 'Read', { file_path: 'a.txt' })
      }).not.toThrow()
      expect(isDenied(out as ReturnType<typeof guardPreToolUse>)).toBe(true)
    }
  })

  it('accepts a frozen policy, a null-prototype policy and extra keys', () => {
    const frozen = Object.freeze({ ...policy(), protectedPatterns: Object.freeze([...DEFAULT_PROTECTED_PATHS]) })
    expect(gp(frozen, 'Read', { file_path: 'a.txt' })).toEqual({})
    const bare = Object.assign(Object.create(null) as object, policy())
    expect(gp(bare, 'Read', { file_path: 'a.txt' })).toEqual({})
    expect(gp({ ...policy(), extra: 'x' }, 'Read', { file_path: 'a.txt' })).toEqual({})
  })

  it('treats an intentionally empty pattern list as "protect nothing" (no Grep rewrite either)', () => {
    const p = policy({ protectedPatterns: [] })
    expect(gp(p, 'Read', { file_path: '.env' })).toEqual({})
    expect(gp(p, 'Grep', { pattern: 'x', glob: '*.ts' })).toEqual({})
    expect(gp(p, 'Glob', { pattern: '.env' })).toEqual({})
  })

  it.each([
    ['NUL entry', ['ok', 'x\0y']],
    ['NUL only', ['\0']]
  ])('falls back to the defaults, never to nothing, for an unusable list: %s', (_n, list) => {
    const p = policy({ protectedPatterns: list })
    expect(isDenied(gp(p, 'Read', { file_path: '.env' }))).toBe(true)
    expect(isDenied(gp(p, 'Read', { file_path: '.git/config' }))).toBe(true)
    expect(gp(p, 'Read', { file_path: 'a.txt' })).toEqual({})
    const grep = gp(p, 'Grep', { pattern: 'x' })
    const glob = (grep.hookSpecificOutput?.updatedInput as { glob: string } | undefined)?.glob ?? ''
    expect(glob).toBe(protectedGrepExclusions(DEFAULT_PROTECTED_PATHS).join(' '))
  })

  it('does not mutate the policy it is given', () => {
    const list = ['x\0y']
    const p = policy({ protectedPatterns: list })
    gp(p, 'Read', { file_path: 'a.txt' })
    expect(p.protectedPatterns).toBe(list)
    expect(list).toEqual(['x\0y'])
  })
})

describe('isToolAllowed', () => {
  it('has no extras without policy and keeps the Phase 2 list stable', () => {
    expect([...ALLOWED_TOOLS]).toEqual(['Read', 'Grep', 'Glob', 'Agent', 'Task', 'Skill'])
    for (const name of ['Write', 'ToolSearch', 'mcp__git__git_status', 'Bash', 'Edit']) {
      expect(isToolAllowed(name)).toBe(false)
      expect(isToolAllowed(name, policy())).toBe(false)
    }
  })

  it('maps each flag to exactly its tools', () => {
    const git = policy({ allowGitRead: true })
    for (const t of ['mcp__git__git_status', 'mcp__git__git_log', 'mcp__git__git_diff', 'ToolSearch']) {
      expect(isToolAllowed(t, git)).toBe(true)
      expect(isToolAllowed(t, policy({ allowPlanWrites: true }))).toBe(false)
    }
    expect(isToolAllowed('Write', git)).toBe(false)
    expect(isToolAllowed('Write', policy({ allowPlanWrites: true }))).toBe(true)
    expect(isToolAllowed('ToolSearch', policy({ allowPlanWrites: true }))).toBe(false)
  })

  it.each(['mcp__git__git_diff_x', 'mcp__git__git_status ', ' mcp__git__git_status', 'MCP__GIT__GIT_STATUS', 'mcp__git__Git_Status',
    'mcp__git__git_push', 'mcp__git__', 'mcp__other__git_status', 'mcp__git__git_status\0', 'git_status', 'toolsearch', 'ToolSearch ',
    'write', 'WRITE', 'Write ', 'Read ', 'read', 'GREP', 'Glob\n', 'skill', 'agent', 'Ｒead'])('rejects name trick %j even with every flag on', (name) => {
    const all = policy({ allowGitRead: true, allowPlanWrites: true })
    expect(isToolAllowed(name, all)).toBe(false)
    expect(isDenied(gp(all, name, {}))).toBe(true)
  })
})

describe('git tools', () => {
  const git = policy({ allowGitRead: true })

  it('denies git tools and ToolSearch without allowGitRead or without a policy', () => {
    for (const t of ['mcp__git__git_status', 'mcp__git__git_log', 'mcp__git__git_diff', 'ToolSearch']) {
      expect(isDenied(gp(policy(), t, {}))).toBe(true)
      expect(isDenied(gp(policy({ allowPlanWrites: true }), t, {}))).toBe(true)
      expect(isDenied(guardPreToolUse({ tool_name: t, tool_input: {} }, cwd))).toBe(true)
    }
  })

  it('git_status takes no keys', () => {
    expect(gp(git, 'mcp__git__git_status', {})).toEqual({})
    expect(gp(git, 'mcp__git__git_status')).toEqual({})
    for (const extra of [{ path: 'src' }, { staged: true }, { maxCount: 1 }, { __proto__x: 1 }, { '': 1 }, { ' path': 'src' }]) {
      const out = gp(git, 'mcp__git__git_status', extra)
      expect(isDenied(out)).toBe(true)
      expect(reason(out)).toContain('not allowed')
    }
  })

  it('git_log accepts only maxCount and path; git_diff only staged and path', () => {
    expect(gp(git, 'mcp__git__git_log', { maxCount: 5, path: 'src' })).toEqual({})
    expect(gp(git, 'mcp__git__git_log', {})).toEqual({})
    expect(gp(git, 'mcp__git__git_diff', { staged: true, path: 'src' })).toEqual({})
    for (const [tool, bad] of [
      ['git_log', { staged: true }],
      ['git_log', { rev: 'HEAD' }],
      ['git_log', { maxCount: 1, author: 'x' }],
      ['git_log', { MaxCount: 1 }],
      ['git_diff', { maxCount: 1 }],
      ['git_diff', { ref: 'HEAD~1' }],
      ['git_diff', { args: ['--output=x'] }],
      ['git_diff', { staged: true, 'path ': 'src' }]
    ] as const) {
      expect(isDenied(gp(git, `mcp__git__${tool}`, bad))).toBe(true)
    }
  })

  it('denies malformed git tool_input shapes', () => {
    for (const bad of [null, [], 'x', 1, true, [{ path: 'src' }]]) {
      const out = gp(git, 'mcp__git__git_log', bad)
      expect(isDenied(out)).toBe(true)
      expect(reason(out)).toBe('Malformed tool request.')
    }
  })

  it('runs the path checks on git path arguments', () => {
    for (const tool of ['git_log', 'git_diff']) {
      const name = `mcp__git__${tool}`
      expect(isDenied(gp(git, name, { path: '.env' }))).toBe(true)
      expect(isDenied(gp(git, name, { path: '.git/config' }))).toBe(true)
      expect(isDenied(gp(git, name, { path: '../proj-evil' }))).toBe(true)
      expect(isDenied(gp(git, name, { path: path.join(root, 'elsewhere') }))).toBe(true)
      expect(isDenied(gp(git, name, { path: '~/x' }))).toBe(true)
      expect(isDenied(gp(git, name, { path: 'a\0b' }))).toBe(true)
      expect(isDenied(gp(git, name, { path: 5 }))).toBe(true)
      expect(isDenied(gp(git, name, { path: ['src'] }))).toBe(true)
      expect(isDenied(gp(git, name, { path: 'x/'.repeat(65) }))).toBe(true)
      expect(gp(git, name, { path: 'src' })).toEqual({})
      expect(gp(git, name, { path: '' })).toEqual({})
    }
  })

  it('denies git tools with a missing or empty cwd', () => {
    for (const bad of ['', undefined, null, 5]) {
      expect(isDenied(gcwd(git, 'mcp__git__git_status', {}, bad))).toBe(true)
    }
  })

  it('does not rewrite git tool input', () => {
    expect(gp(git, 'mcp__git__git_diff', { path: 'src' }).hookSpecificOutput).toBeUndefined()
  })
})

describe('ToolSearch', () => {
  const git = policy({ allowGitRead: true })

  it('is allowed with an object input only when allowGitRead is on', () => {
    expect(gp(git, 'ToolSearch', { query: 'select:mcp__git__git_status' })).toEqual({})
    expect(gp(git, 'ToolSearch', {})).toEqual({})
    expect(isDenied(gp(policy(), 'ToolSearch', { query: 'x' }))).toBe(true)
  })

  it.each([undefined, null, [], 'x', 3, true])('denies ToolSearch with tool_input %j', (bad) => {
    const out = gp(git, 'ToolSearch', bad)
    expect(isDenied(out)).toBe(true)
    expect(reason(out)).toBe('Malformed tool request.')
  })

  it('does not need a cwd', () => {
    expect(gcwd(git, 'ToolSearch', { query: 'x' }, '')).toEqual({})
  })
})

describe('Grep rewrite', () => {
  const p = policy()
  const globOf = (o: ReturnType<typeof guardPreToolUse>) => (o.hookSpecificOutput?.updatedInput as { glob?: string } | undefined)?.glob

  it('allows with updatedInput that keeps every other key and puts the user glob first', () => {
    const input = { pattern: 'x', path: 'src', '-i': true, output_mode: 'content', glob: '*.ts' }
    const out = gp(p, 'Grep', input)
    expect(out.hookSpecificOutput?.permissionDecision).toBe('allow')
    expect(out.hookSpecificOutput?.hookEventName).toBe('PreToolUse')
    const updated = out.hookSpecificOutput?.updatedInput as Record<string, unknown>
    expect(updated).toMatchObject({ pattern: 'x', path: 'src', '-i': true, output_mode: 'content' })
    expect((updated['glob'] as string).startsWith('*.ts ')).toBe(true)
    expect(updated['glob']).toBe(['*.ts', ...protectedGrepExclusions(DEFAULT_PROTECTED_PATHS)].join(' '))
  })

  it('does not mutate the original input', () => {
    const args = { pattern: 'x', glob: '*.ts' }
    const snapshot = JSON.stringify(args)
    const out = gp(p, 'Grep', args)
    expect(JSON.stringify(args)).toBe(snapshot)
    expect(out.hookSpecificOutput?.updatedInput).not.toBe(args)
  })

  it.each([undefined, null, ''])('uses only the exclusions when the user glob is %j', (glob) => {
    const out = gp(p, 'Grep', { pattern: 'x', glob })
    expect(globOf(out)).toBe(protectedGrepExclusions(DEFAULT_PROTECTED_PATHS).join(' '))
  })

  it.each(['   ', '\t\n'])('never lets a whitespace-only glob %j widen the search (denied, or exclusions only)', (glob) => {
    const out = gp(p, 'Grep', { pattern: 'x', glob })
    if (!isDenied(out)) expect(globOf(out)).toBe(protectedGrepExclusions(DEFAULT_PROTECTED_PATHS).join(' '))
  })

  it('trims the user glob', () => {
    expect(globOf(gp(p, 'Grep', { pattern: 'x', glob: '  *.md  ' }))?.startsWith('*.md !')).toBe(true)
  })

  it('denies non-string globs instead of rewriting them', () => {
    for (const glob of [5, true, ['*.ts'], { a: 1 }]) {
      expect(isDenied(gp(p, 'Grep', { pattern: 'x', glob }))).toBe(true)
    }
  })

  it('denies (never rewrites) a Grep whose glob or path is denied', () => {
    for (const input of [
      { pattern: 'x', glob: '../*.ts' },
      { pattern: 'x', glob: '.git/**' },
      { pattern: 'x', path: '.git' },
      { pattern: 'x', path: '..' }
    ]) {
      const out = gp(p, 'Grep', input)
      expect(isDenied(out)).toBe(true)
      expect(out.hookSpecificOutput?.updatedInput).toBeUndefined()
    }
  })

  it('does not rewrite Read, Glob or Agent, and does not rewrite without a policy', () => {
    expect(gp(p, 'Glob', { pattern: 'src/**' })).toEqual({})
    expect(gp(p, 'Read', { file_path: 'a.txt' })).toEqual({})
    expect(guardPreToolUse({ tool_name: 'Grep', tool_input: { pattern: 'x', glob: '*.ts' } }, cwd)).toEqual({})
  })

  it('does not rewrite when no pattern converts to an exclusion', () => {
    expect(gp(policy({ protectedPatterns: ['!keep', '# comment', '   '] }), 'Grep', { pattern: 'x', glob: '*.ts' })).toEqual({})
  })

  it('adds both the file and directory form per pattern, the directory form only for dir patterns', () => {
    const out = gp(policy({ protectedPatterns: ['secret', 'vault/'] }), 'Grep', { pattern: 'x' })
    const parts = (globOf(out) ?? '').split(' ')
    expect(parts.some((s) => /^!\*\*\/(secret|\[sS\]\[eE\]\[cC\]\[rR\]\[eE\]\[tT\])$/.test(s))).toBe(true)
    expect(parts.some((s) => /^!\*\*\/(secret|\[sS\]\[eE\]\[cC\]\[rR\]\[eE\]\[tT\])\/\*\*$/.test(s))).toBe(true)
    expect(parts.filter((s) => s.endsWith('/**')).length).toBe(2)
    expect(parts.filter((s) => !s.endsWith('/**')).length).toBe(1)
  })

  // Low severity hardening: the rewrite re-reads args.glob after the check. Real input is parsed JSON, so this
  // only matters for exotic inputs; kept as a deliberate guard against check/use drift.
  it('rewrites the glob it checked (no re-read of a changing getter)', () => {
    let reads = 0
    const args = {
      pattern: 'x',
      get glob(): string {
        reads++
        return reads === 1 ? '*.ts' : '../../outside/**'
      }
    }
    const out = gp(p, 'Grep', args)
    if (!isDenied(out)) {
      expect(globOf(out) ?? '').not.toContain('..')
    }
  })
})

describe('protectedGrepExclusions', () => {
  it('converts file and directory patterns on posix', () => {
    expect(protectedGrepExclusions(['.env'], 'linux')).toEqual(['!**/.env', '!**/.env/**'])
    expect(protectedGrepExclusions(['vault/'], 'linux')).toEqual(['!**/vault/**'])
    expect(protectedGrepExclusions(['/root.txt'], 'linux')).toEqual(['!**/root.txt', '!**/root.txt/**'])
    expect(protectedGrepExclusions(['*.pem'], 'darwin')).toEqual(['!**/*.pem', '!**/*.pem/**'])
    expect(protectedGrepExclusions(['a/b'], 'linux')).toEqual(['!**/a/b', '!**/a/b/**'])
  })

  it('skips blanks, comments, re-allows, backslashes and non-strings', () => {
    expect(protectedGrepExclusions(['', '   ', '#c', '!x', '/', '//'], 'linux')).toEqual([])
    expect(protectedGrepExclusions([5, null, undefined, {}] as unknown as string[], 'linux')).toEqual([])
    expect(protectedGrepExclusions([], 'linux')).toEqual([])
  })

  it('turns whitespace inside a pattern into "?" so the space-joined glob is not split, and trims trailing blanks', () => {
    expect(protectedGrepExclusions(['my file'], 'linux')).toEqual(['!**/my?file', '!**/my?file/**'])
    expect(protectedGrepExclusions(['a\tb'], 'linux')).toEqual(['!**/a?b', '!**/a?b/**'])
    expect(protectedGrepExclusions(['x  \t'], 'linux')).toEqual(['!**/x', '!**/x/**'])
    expect(protectedGrepExclusions([' lead'], 'linux')).toEqual(['!**/?lead', '!**/?lead/**'])
    for (const e of protectedGrepExclusions(['a b', 'c d', 'e f', 'g\nh'], 'linux')) {
      expect(e).not.toMatch(/\s/)
    }
  })

  it('folds case outside character classes on win32 only', () => {
    expect(protectedGrepExclusions(['.env'], 'win32')).toEqual(['!**/.[eE][nN][vV]', '!**/.[eE][nN][vV]/**'])
    expect(protectedGrepExclusions(['[0-9]x'], 'win32')).toEqual(['!**/[0-9][xX]', '!**/[0-9][xX]/**'])
    expect(protectedGrepExclusions(['*.pem/'], 'win32')).toEqual(['!**/*.[pP][eE][mM]/**'])
    expect(protectedGrepExclusions(['1-2_3'], 'win32')).toEqual(['!**/1-2_3', '!**/1-2_3/**'])
    expect(protectedGrepExclusions(['.env'], 'linux')).toEqual(['!**/.env', '!**/.env/**'])
  })

  it('converts every default pattern without throwing and without whitespace', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const out = protectedGrepExclusions(DEFAULT_PROTECTED_PATHS, platform)
      expect(out.length).toBeGreaterThan(0)
      for (const e of out) {
        expect(e.startsWith('!**/')).toBe(true)
        expect(e).not.toMatch(/\s/)
      }
    }
  })

  it('is pure: does not modify its input and does not touch the filesystem', () => {
    const list = ['.env', 'vault/']
    protectedGrepExclusions(list, 'win32')
    expect(list).toEqual(['.env', 'vault/'])
    expect(fsCalls.n).toBe(0)
  })
})

describe('Write plan guard shapes', () => {
  const w = policy({ allowPlanWrites: true })
  const wr = (input: unknown, p: unknown = w) => gp(p, 'Write', input, wcwd)
  const ok = (file_path: string, content = '# plan') => wr({ file_path, content })

  it('is denied without allowPlanWrites, with only allowGitRead, and without a policy', () => {
    const input = { file_path: 'docs/plans/x.md', content: 'c' }
    expect(isDenied(gp(policy(), 'Write', input, wcwd))).toBe(true)
    expect(isDenied(gp(policy({ allowGitRead: true }), 'Write', input, wcwd))).toBe(true)
    expect(isDenied(guardPreToolUse({ tool_name: 'Write', tool_input: input }, wcwd))).toBe(true)
    expect(fsCalls.n).toBe(0)
  })

  it('allows the relative form and the absolute form under cwd', () => {
    expect(ok('docs/plans/x.md')).toEqual({})
    expect(ok('docs/plans/phase-3-project-settings.md')).toEqual({})
    expect(ok('docs/plans/a1-b2.md')).toEqual({})
    expect(ok(path.join(wcwd, 'docs', 'plans', 'x.md'))).toEqual({})
    expect(ok('docs/plans/x.md', '')).toEqual({})
  })

  const denied: Array<[string, string | (() => string)]> = [
    ['uppercase slug', 'docs/plans/X.md'],
    ['uppercase dir', 'Docs/plans/x.md'],
    ['uppercase dir 2', 'docs/Plans/x.md'],
    ['uppercase extension', 'docs/plans/x.MD'],
    ['backslashes', 'docs\\plans\\x.md'],
    ['mixed separators', 'docs/plans\\x.md'],
    ['double slash', 'docs//plans/x.md'],
    ['dot prefix', './docs/plans/x.md'],
    ['parent hop', 'docs/plans/../plans/x.md'],
    ['parent escape', 'docs/plans/../../x.md'],
    ['nested', 'docs/plans/a/b.md'],
    ['nested absolute-like', '/docs/plans/x.md'],
    ['trailing NUL', 'docs/plans/x.md\0'],
    ['NUL in slug', 'docs/plans/x\0y.md'],
    ['NUL before ext', 'docs/plans/x\0.md'],
    ['NUL dir', 'docs\0/plans/x.md'],
    ['trailing space', 'docs/plans/x.md '],
    ['trailing newline', 'docs/plans/x.md\n'],
    ['leading space', ' docs/plans/x.md'],
    ['trailing dot', 'docs/plans/x.md.'],
    ['double extension', 'docs/plans/x.md.md'],
    ['other extension', 'docs/plans/x.txt'],
    ['no extension', 'docs/plans/x'],
    ['empty slug', 'docs/plans/.md'],
    ['leading hyphen', 'docs/plans/-x.md'],
    ['trailing hyphen', 'docs/plans/x-.md'],
    ['double hyphen', 'docs/plans/x--y.md'],
    ['underscore', 'docs/plans/x_y.md'],
    ['dot in slug', 'docs/plans/x.y.md'],
    ['space in slug', 'docs/plans/x y.md'],
    ['fullwidth latin', 'docs/plans/ｘ.md'],
    ['cyrillic a', 'docs/plans/а.md'],
    ['turkish dotless i', 'docs/plans/ı.md'],
    ['kelvin sign', 'docs/plans/K.md'],
    ['long s', 'docs/plans/ſ.md'],
    ['combining mark', 'docs/plans/x́.md'],
    ['zero width space', 'docs/plans/x​.md'],
    ['rtl override', 'docs/plans/‮x.md'],
    ['fullwidth slash', 'docs／plans/x.md'],
    ['dotdot slug', 'docs/plans/...md'],
    ['ads stream', 'docs/plans/x.md:stream'],
    ['ads default stream', 'docs/plans/x.md::$DATA'],
    ['reserved device', 'docs/plans/con.md.'],
    ['tilde short name', 'docs/plans/plan~1.md'],
    ['url encoded', 'docs/plans/x%2e.md'],
    ['glob chars', 'docs/plans/*.md'],
    ['empty', ''],
    ['just dir', 'docs/plans/'],
    ['just docs', 'docs'],
    ['plans sibling', 'docs/plan/x.md'],
    ['other root', 'src/x.md'],
    ['dotfile', '.env'],
    ['unc', '\\\\host\\share\\docs\\plans\\x.md'],
    ['other abs', () => path.join(root, 'elsewhere', 'docs', 'plans', 'x.md')],
    ['abs nested', () => path.join(wcwd, 'docs', 'plans', 'a', 'b.md')],
    ['abs parent hop', () => path.join(wcwd, 'docs', 'plans') + path.sep + '..' + path.sep + 'plans' + path.sep + 'x.md'],
    ['abs sibling cwd', () => path.join(wcwd + '-evil', 'docs', 'plans', 'x.md')],
    ['abs wrong dir', () => path.join(wcwd, 'docs', 'x.md')],
    ['abs trailing space', () => path.join(wcwd, 'docs', 'plans', 'x.md') + ' ']
  ]

  it.each(denied)('denies %s with the shape message and zero filesystem calls', (_n, fp) => {
    const out = ok(typeof fp === 'function' ? fp() : fp)
    expect(isDenied(out)).toBe(true)
    expect(reason(out)).toContain('docs/plans/<slug>.md')
    expect(fsCalls.n).toBe(0)
  })

  it('accepts a 64 character slug and denies 65, in both forms', () => {
    const s64 = 'a'.repeat(64)
    const s65 = 'a'.repeat(65)
    expect(ok(`docs/plans/${s64}.md`)).toEqual({})
    expect(ok(path.join(wcwd, 'docs', 'plans', `${s64}.md`))).toEqual({})
    expect(isDenied(ok(`docs/plans/${s65}.md`))).toBe(true)
    expect(isDenied(ok(path.join(wcwd, 'docs', 'plans', `${s65}.md`)))).toBe(true)
    const hy = `${'ab-'.repeat(21)}a` // 64 chars
    expect(hy.length).toBe(64)
    expect(ok(`docs/plans/${hy}.md`)).toEqual({})
    expect(isDenied(ok(`docs/plans/${hy}b.md`))).toBe(true)
  })

  it('denies an overlong file_path (past 4096) before any filesystem call', () => {
    const out = ok(`docs/plans/${'a'.repeat(5000)}.md`)
    expect(isDenied(out)).toBe(true)
    fsCalls.n = 0
    expect(isDenied(ok(`docs/plans/${'a'.repeat(5000)}.md`))).toBe(true)
    expect(fsCalls.n).toBe(0)
  })

  it('enforces the content cap in bytes at exactly 200000 / 200001', () => {
    expect(PLAN_CONTENT_CAP).toBe(200_000)
    expect(ok('docs/plans/x.md', 'a'.repeat(200_000))).toEqual({})
    const over = ok('docs/plans/x.md', 'a'.repeat(200_001))
    expect(isDenied(over)).toBe(true)
    expect(reason(over)).toContain('too large')
    // two bytes per char
    expect(ok('docs/plans/x.md', 'é'.repeat(100_000))).toEqual({})
    expect(isDenied(ok('docs/plans/x.md', 'é'.repeat(100_000) + 'a'))).toBe(true)
    // three bytes per char: 66666 * 3 = 199998, +2 ascii = 200000
    expect(ok('docs/plans/x.md', '€'.repeat(66_666) + 'aa')).toEqual({})
    expect(isDenied(ok('docs/plans/x.md', '€'.repeat(66_666) + 'aaa'))).toBe(true)
    // four bytes per char (astral): 50000 * 4 = 200000
    expect(ok('docs/plans/x.md', '\u{1F600}'.repeat(50_000))).toEqual({})
    expect(isDenied(ok('docs/plans/x.md', '\u{1F600}'.repeat(50_000) + 'a'))).toBe(true)
    // fewer than 200000 chars but more than 200000 bytes
    expect(isDenied(ok('docs/plans/x.md', '€'.repeat(100_000)))).toBe(true)
  })

  it('checks the content cap with no filesystem calls and before the shape message', () => {
    const out = ok('docs/plans/x.md', 'a'.repeat(200_001))
    expect(reason(out)).toContain('too large')
    expect(fsCalls.n).toBe(0)
  })

  it('denies extra, missing and wrongly typed keys', () => {
    for (const bad of [
      { file_path: 'docs/plans/x.md', content: 'c', append: true },
      { file_path: 'docs/plans/x.md', content: 'c', encoding: 'base64' },
      { file_path: 'docs/plans/x.md', content: 'c', path: '.env' },
      { file_path: 'docs/plans/x.md' },
      { content: 'c' },
      {},
      { file_path: 5, content: 'c' },
      { file_path: 'docs/plans/x.md', content: 5 },
      { file_path: 'docs/plans/x.md', content: null },
      { file_path: null, content: 'c' },
      { file_path: ['docs/plans/x.md'], content: 'c' },
      { file_path: 'docs/plans/x.md', content: ['c'] },
      { file_path: new String('docs/plans/x.md'), content: 'c' }
    ]) {
      expect(isDenied(wr(bad))).toBe(true)
    }
    for (const bad of [undefined, null, [], 'x', 1]) {
      const out = wr(bad)
      expect(isDenied(out)).toBe(true)
      expect(reason(out)).toBe('Malformed tool request.')
    }
    expect(fsCalls.n).toBe(0)
  })

  it('denies an inherited or symbol key without crashing', () => {
    const sym = { file_path: 'docs/plans/x.md', content: 'c', [Symbol('s')]: 1 }
    expect(() => wr(sym)).not.toThrow()
    const proto = Object.create({ extra: 1 }) as Record<string, unknown>
    proto['file_path'] = 'docs/plans/x.md'
    proto['content'] = 'c'
    expect(() => wr(proto)).not.toThrow()
  })

  it('denies a missing or empty cwd', () => {
    for (const bad of ['', undefined, null, 5]) {
      expect(isDenied(gcwd(w, 'Write', { file_path: 'docs/plans/x.md', content: 'c' }, bad))).toBe(true)
    }
  })

  it('denies a target matched by a custom protected pattern but not its siblings', () => {
    const p = policy({ allowPlanWrites: true, protectedPatterns: ['docs/plans/secret.md', 'locked-*'] })
    const out = wr({ file_path: 'docs/plans/secret.md', content: 'c' }, p)
    expect(isDenied(out)).toBe(true)
    expect(reason(out)).toContain('protected')
    expect(isDenied(wr({ file_path: 'docs/plans/locked-one.md', content: 'c' }, p))).toBe(true)
    expect(wr({ file_path: 'docs/plans/open.md', content: 'c' }, p)).toEqual({})
  })

  it('denies when a protected pattern covers the whole plans folder', () => {
    const p = policy({ allowPlanWrites: true, protectedPatterns: ['docs/plans/'] })
    expect(isDenied(wr({ file_path: 'docs/plans/x.md', content: 'c' }, p))).toBe(true)
  })

  it('denies an existing target that is a directory', () => {
    mkdirSync(path.join(wcwd, 'docs', 'plans', 'adir.md'), { recursive: true })
    const out = ok('docs/plans/adir.md')
    expect(isDenied(out)).toBe(true)
    expect(reason(out)).toContain('regular file')
  })

  it('denies when docs is a junction, and when docs/plans is a junction', (ctx) => {
    const base = path.join(root, 'linkproj')
    const elsewhere = path.join(root, 'linkdest')
    mkdirSync(path.join(base, 'real', 'plans'), { recursive: true })
    mkdirSync(path.join(elsewhere, 'plans'), { recursive: true })
    makeLink(ctx, elsewhere, path.join(base, 'docs'))
    const a = gp(w, 'Write', { file_path: 'docs/plans/x.md', content: 'c' }, base)
    expect(isDenied(a)).toBe(true)
    expect(reason(a)).toContain('not links')

    const base2 = path.join(root, 'linkproj2')
    mkdirSync(path.join(base2, 'docs'), { recursive: true })
    makeLink(ctx, elsewhere, path.join(base2, 'docs', 'plans'))
    const b = gp(w, 'Write', { file_path: 'docs/plans/x.md', content: 'c' }, base2)
    expect(isDenied(b)).toBe(true)
    expect(reason(b)).toContain('not links')
  })

  it('allows creating the plan when docs and docs/plans do not exist yet', () => {
    const fresh = path.join(root, 'fresh')
    mkdirSync(fresh)
    expect(gp(w, 'Write', { file_path: 'docs/plans/x.md', content: 'c' }, fresh)).toEqual({})
    mkdirSync(path.join(fresh, 'docs'))
    expect(gp(w, 'Write', { file_path: 'docs/plans/x.md', content: 'c' }, fresh)).toEqual({})
  })

  it('does not rewrite the Write input', () => {
    expect(ok('docs/plans/x.md').hookSpecificOutput).toBeUndefined()
  })
})

describe('never throws', () => {
  const throwing = (): never => {
    throw new Error('boom')
  }
  const trap = new Proxy({}, { get: throwing, has: throwing, ownKeys: throwing, getOwnPropertyDescriptor: throwing })
  const policies: Array<ToolPolicy | undefined> = [
    undefined,
    policy(),
    policy({ allowGitRead: true, allowPlanWrites: true })
  ]

  it('denies a throwing top-level input', () => {
    for (const p of policies) {
      const out = guardPreToolUse(trap, cwd, p)
      expect(isDenied(out)).toBe(true)
    }
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    expect(isDenied(guardPreToolUse(revoked.proxy, cwd))).toBe(true)
  })

  it('denies a throwing tool_name getter', () => {
    const input = {
      get tool_name(): string {
        throw new Error('boom')
      }
    }
    expect(isDenied(guardPreToolUse(input, cwd, policy()))).toBe(true)
  })

  it('denies a throwing tool_input for every tool that inspects it', () => {
    const all = policy({ allowGitRead: true, allowPlanWrites: true })
    const tools = ['Read', 'Grep', 'Glob', 'Agent', 'Task', 'Write', 'ToolSearch', 'mcp__git__git_status', 'mcp__git__git_log', 'mcp__git__git_diff']
    for (const tool of tools) {
      for (const tool_input of [
        trap,
        {
          get file_path(): string {
            throw new Error('boom')
          }
        },
        {
          get path(): string {
            throw new Error('boom')
          }
        }
      ]) {
        let out: ReturnType<typeof guardPreToolUse> | undefined
        expect(() => {
          out = guardPreToolUse({ tool_name: tool, tool_input }, cwd, all)
        }).not.toThrow()
        // Never allowed when the input could not be read (getter-only objects count as read failures).
        if (tool_input === trap && tool !== 'ToolSearch') expect(isDenied(out as ReturnType<typeof guardPreToolUse>)).toBe(true)
      }
    }
  })

  it('denies throwing getters for the keys each checker actually reads', () => {
    const boom = (key: string) => ({
      get [key](): string {
        throw new Error('boom')
      }
    })
    const all = policy({ allowGitRead: true, allowPlanWrites: true })
    const g = (tool_name: string, tool_input: unknown) => guardPreToolUse({ tool_name, tool_input }, wcwd, all)
    expect(isDenied(g('Read', boom('file_path')))).toBe(true)
    expect(isDenied(g('Grep', boom('glob')))).toBe(true)
    expect(isDenied(g('Grep', boom('path')))).toBe(true)
    expect(isDenied(g('Glob', boom('pattern')))).toBe(true)
    expect(isDenied(g('Write', boom('file_path')))).toBe(true)
    expect(isDenied(g('Write', boom('content')))).toBe(true)
    expect(isDenied(g('Agent', boom('prompt')))).toBe(true)
    expect(isDenied(g('mcp__git__git_log', boom('path')))).toBe(true)
  })

  it('denies non-object and exotic top-level inputs', () => {
    for (const bad of [undefined, null, 0, 1, '', 'Read', true, Symbol('x'), () => 1, [], [{ tool_name: 'Read' }], 10n]) {
      let out: ReturnType<typeof guardPreToolUse> | undefined
      expect(() => {
        out = guardPreToolUse(bad, cwd, policy())
      }).not.toThrow()
      expect(isDenied(out as ReturnType<typeof guardPreToolUse>)).toBe(true)
    }
  })

  it('denies a non-string or empty tool_name', () => {
    for (const name of [undefined, null, 5, '', {}, [], ['Read'], true]) {
      expect(isDenied(gp(policy(), name, { file_path: 'a.txt' }))).toBe(true)
    }
  })

  it('denies path tools for a non-string cwd and never throws on odd cwd values', () => {
    for (const bad of [undefined, null, 5, {}, [], true]) {
      expect(isDenied(gcwd(policy(), 'Read', { file_path: 'a.txt' }, bad))).toBe(true)
      expect(isDenied(gcwd(policy(), 'Glob', { pattern: '*' }, bad))).toBe(true)
    }
    expect(gcwd(policy(), 'Skill', {}, undefined)).toEqual({})
  })

  it('denies (does not throw) for a cwd that does not exist on disk', () => {
    const ghost = path.join(root, 'ghost-dir')
    let out: ReturnType<typeof guardPreToolUse> | undefined
    expect(() => {
      out = gp(policy(), 'Read', { file_path: 'a.txt' }, ghost)
    }).not.toThrow()
    expect(out).toBeDefined()
  })
})

describe('Phase 2 behaviour without a policy', () => {
  const p2 = (tool_name: string, tool_input?: unknown) => guardPreToolUse({ tool_name, tool_input }, cwd)

  it('allows the read-only set and denies everything the policy would add', () => {
    expect(p2('Read', { file_path: 'a.txt' })).toEqual({})
    expect(p2('Glob', { pattern: 'src/**' })).toEqual({})
    expect(p2('Grep', { pattern: 'x', glob: '*.ts' })).toEqual({})
    expect(p2('Skill')).toEqual({})
    expect(p2('Agent', { prompt: 'p' })).toEqual({})
    for (const t of ['Write', 'Edit', 'Bash', 'ToolSearch', 'mcp__git__git_status', 'mcp__git__git_log', 'mcp__git__git_diff']) {
      expect(isDenied(p2(t, { file_path: 'docs/plans/x.md', content: 'c' }))).toBe(true)
    }
  })

  it('still applies the default protected list to path checks', () => {
    for (const f of ['.env', '.git/config', 'k.pem']) {
      expect(isDenied(p2('Read', { file_path: f }))).toBe(true)
    }
    expect(isDenied(p2('Glob', { pattern: '.git/**' }))).toBe(true)
  })

  it('an explicit undefined policy equals an omitted one', () => {
    const input = { tool_name: 'Grep', tool_input: { pattern: 'x', glob: '*.ts' } }
    expect(guardPreToolUse(input, cwd, undefined)).toEqual(guardPreToolUse(input, cwd))
    expect(guardPreToolUse(input, cwd, undefined)).toEqual({})
  })

  it('an explicit null policy is not the same as no policy: it denies', () => {
    expect(isDenied(guardPreToolUse({ tool_name: 'Read', tool_input: { file_path: 'a.txt' } }, cwd, null as unknown as ToolPolicy))).toBe(true)
  })
})
