import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
const fsCalls = vi.hoisted(() => ({ n: 0, jsRealpath: 0 }))

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
        fsCalls.jsRealpath++
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

import { ALLOWED_TOOLS, guardPreToolUse, isDenied } from './tools'

let root: string
let cwd: string
let outside: string

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'desk-guard-')))
  cwd = path.join(root, 'proj')
  outside = path.join(root, 'proj-evil')
  mkdirSync(path.join(cwd, 'src'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(path.join(cwd, 'a.txt'), 'x')
  writeFileSync(path.join(outside, 'data.txt'), 's')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

/** Creates a junction/symlink; skips the test only when the platform or permissions forbid it, rethrows otherwise. */
function makeLink(ctx: { skip: () => never }, target: string, linkPath: string, type: 'junction' | 'dir' = 'junction'): void {
  try {
    symlinkSync(target, linkPath, type)
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) ctx.skip()
    throw error
  }
}

const g = (tool_name: string, tool_input?: unknown) =>
  guardPreToolUse({ hook_event_name: 'PreToolUse', tool_name, tool_input }, cwd)

describe('guardPreToolUse', () => {
  it('allows Skill without inspecting input', () => {
    expect(g('Skill')).toEqual({})
    expect(g('Skill', { skill: 'x', args: 'y' })).toEqual({})
  })

  it.each(['Agent', 'Task'])('%s: allows only string description, prompt, subagent_type, model, name and resume (S31)', (tool) => {
    expect(g(tool, { description: 'd', prompt: 'p', subagent_type: 'Explore', model: 'haiku' })).toEqual({})
    expect(g(tool, { description: 'd', prompt: 'p', name: 'helper', resume: 'agent-1' })).toEqual({})
    expect(isDenied(g(tool, { prompt: 'p', name: 1 }))).toBe(true)
    expect(isDenied(g(tool, { prompt: 'p', resume: { id: 'x' } }))).toBe(true)
    expect(isDenied(g(tool, { prompt: 'p', model: null }))).toBe(true)
    for (const key of ['isolation', 'mode', 'team_name', 'cwd', 'run_in_background']) {
      expect(isDenied(g(tool, { prompt: 'p', [key]: 'x' }))).toBe(true)
    }
    expect(isDenied(g(tool, { description: 'd', prompt: 'p', isolation: 'worktree' }))).toBe(true)
    expect(isDenied(g(tool, { description: 'd', prompt: 'p', surprise: 1 }))).toBe(true)
    expect(isDenied(g(tool, { prompt: 'p', run_in_background: true }))).toBe(true)
    expect(isDenied(g(tool))).toBe(true)
    expect(isDenied(g(tool, []))).toBe(true)
    const out = g(tool, { isolation: 'worktree' })
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('isolation')
  })

  it.each(['Write', 'Edit', 'Bash', 'NotebookEdit', 'WebFetch', 'mcp__x__y', 'read'])(
    'denies %s with a reason',
    (tool_name) => {
      const out = g(tool_name)
      expect(out.hookSpecificOutput?.hookEventName).toBe('PreToolUse')
      expect(out.hookSpecificOutput?.permissionDecision).toBe('deny')
      expect(out.hookSpecificOutput?.permissionDecisionReason).toBeTruthy()
      expect(isDenied(out)).toBe(true)
    }
  )

  it.each([undefined, null, 'Read', 5, {}, { tool_name: 3 }, { tool_name: '' }])(
    'denies malformed input %j',
    (input) => {
      expect(isDenied(guardPreToolUse(input, cwd))).toBe(true)
    }
  )

  it('exposes the allowlist', () => {
    expect([...ALLOWED_TOOLS]).toEqual(['Read', 'Grep', 'Glob', 'Agent', 'Task', 'Skill'])
  })
})

describe('guardPreToolUse path scoping (S10)', () => {
  it('allows reads inside the project, absolute or relative, existing or not', () => {
    expect(g('Read', { file_path: path.join(cwd, 'a.txt') })).toEqual({})
    expect(g('Read', { file_path: 'a.txt' })).toEqual({})
    expect(g('Read', { file_path: path.join(cwd, 'new', 'later.ts') })).toEqual({})
    expect(g('Grep', { pattern: 'foo' })).toEqual({})
    expect(g('Grep', { pattern: 'foo', path: 'src', glob: '**/*.ts' })).toEqual({})
    expect(g('Glob', { pattern: 'src/**/*.ts' })).toEqual({})
    expect(g('Glob', { pattern: '*.ts', path: cwd })).toEqual({})
  })

  it('denies reads outside, including a sibling that shares the name prefix', () => {
    expect(isDenied(g('Read', { file_path: path.join(outside, 'data.txt') }))).toBe(true)
    expect(isDenied(g('Read', { file_path: path.join(root, 'x') }))).toBe(true)
    expect(isDenied(g('Grep', { pattern: 'a', path: outside }))).toBe(true)
    expect(isDenied(g('Glob', { pattern: '*', path: root }))).toBe(true)
  })

  it('denies .. escapes and home paths', () => {
    expect(isDenied(g('Read', { file_path: '../proj-evil/data.txt' }))).toBe(true)
    expect(isDenied(g('Read', { file_path: 'src/../../proj-evil/data.txt' }))).toBe(true)
    expect(isDenied(g('Read', { file_path: '~/.ssh/id_rsa' }))).toBe(true)
    expect(isDenied(g('Grep', { pattern: 'a', path: '~' }))).toBe(true)
  })

  it('denies glob patterns that escape', () => {
    expect(isDenied(g('Glob', { pattern: '../**/*' }))).toBe(true)
    expect(isDenied(g('Glob', { pattern: 'src\\..\\..\\*' }))).toBe(true)
    expect(isDenied(g('Glob', { pattern: path.join(outside, '*') }))).toBe(true)
    expect(isDenied(g('Glob', { pattern: '~/**' }))).toBe(true)
    expect(isDenied(g('Grep', { pattern: 'a', glob: '../*' }))).toBe(true)
    expect(g('Glob', { pattern: path.join(cwd, '**', '*.ts').replace(/\\/g, '/') })).toEqual({})
  })

  it('denies a symlink that points outside', (ctx) => {
    const link = path.join(cwd, 'link')
    makeLink(ctx, outside, link)
    expect(isDenied(g('Read', { file_path: path.join(link, 'data.txt') }))).toBe(true)
    expect(isDenied(g('Grep', { pattern: 'a', path: 'link' }))).toBe(true)
  })

  it('denies malformed tool_input and a missing cwd (fails closed)', () => {
    expect(isDenied(g('Read'))).toBe(true)
    expect(isDenied(g('Read', {}))).toBe(true)
    expect(isDenied(g('Read', { file_path: 5 }))).toBe(true)
    expect(isDenied(g('Grep', { pattern: 'a', path: 7 }))).toBe(true)
    expect(isDenied(g('Glob', { pattern: 3 }))).toBe(true)
    expect(isDenied(g('Glob', [] as unknown))).toBe(true)
    expect(isDenied(guardPreToolUse({ tool_name: 'Read', tool_input: { file_path: 'a' } }, ''))).toBe(true)
  })

  it.runIf(process.platform === 'win32')('is case-insensitive on win32 and denies other drives and UNC', () => {
    expect(g('Read', { file_path: path.join(cwd, 'A.TXT').toUpperCase() })).toEqual({})
    expect(isDenied(g('Read', { file_path: 'Z:\\nope\\x' }))).toBe(true)
    expect(isDenied(g('Read', { file_path: '\\\\server\\share\\x' }))).toBe(true)
    expect(isDenied(g('Glob', { pattern: 'D:foo' }))).toBe(true)
  })
})

describe('guardPreToolUse glob and link hardening (F1, S30)', () => {
  it.each(['**/*.{ts,tsx}', 'src/{a,b}/*.ts', '*.{ts,js}', '{src,tests}/**/*.ts', 'src/{a,{b,c}}/*.ts', 'src/{,x}/*.ts'])(
    'allows brace pattern %s',
    (pattern) => {
      expect(g('Glob', { pattern })).toEqual({})
      expect(g('Grep', { pattern: 'a', glob: pattern })).toEqual({})
    }
  )

  it.each([
    '{..,x}/*',
    '{a,..}/.ssh/*',
    '{.,.}./out/*',
    '{/etc,x}/*',
    '{~,x}/*',
    '{a,{..,b}}/x',
    '{a,b',
    'a,b}',
    '}{a,b}',
    '{\\\\host\\s,x}/*',
    '{a,b}'.repeat(8)
  ])('denies brace pattern %s', (pattern) => {
    expect(isDenied(g('Glob', { pattern }))).toBe(true)
    expect(isDenied(g('Grep', { pattern: 'a', glob: pattern }))).toBe(true)
  })

  it('denies an expansion longer than the cap', () => {
    expect(isDenied(g('Glob', { pattern: '{a,b}' + 'x'.repeat(600) }))).toBe(true)
  })

  it('allows exactly 128 expansions, denies 256, and brace-free patterns longer than the brace cap', () => {
    expect(g('Glob', { pattern: '{a,b}'.repeat(6) })).toEqual({})
    expect(g('Glob', { pattern: '**/' + 'x'.repeat(600) })).toEqual({})
    expect(g('Grep', { pattern: 'a', glob: '**/' + 'x'.repeat(600) })).toEqual({})
  })

  it('denies "[" inside a brace group but allows a class outside braces', () => {
    expect(isDenied(g('Glob', { pattern: '{a,[bc]}/*' }))).toBe(true)
    expect(isDenied(g('Glob', { pattern: '{a,{b,[c]}}/*' }))).toBe(true)
    expect(isDenied(g('Grep', { pattern: 'a', glob: '*.{ts,[jt]s}' }))).toBe(true)
    expect(g('Glob', { pattern: 'src/[ab]*.ts' })).toEqual({})
    expect(g('Glob', { pattern: '{a,b}/[cd]*.ts' })).toEqual({})
  })

  it('mentions the limits in the deny reason', () => {
    const reason = g('Glob', { pattern: '{..,x}/*' }).hookSpecificOutput?.permissionDecisionReason
    expect(reason).toContain('512')
    expect(reason).toContain('128')
  })

  it('gives a hint in the deny reason', () => {
    const out = g('Glob', { pattern: '{..,x}/*' })
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('relative')
  })

  it('denies an absolute brace pattern', () => {
    const abs = cwd.replace(/\\/g, '/') + '/{.,.}./out/*'
    expect(isDenied(g('Glob', { pattern: abs }))).toBe(true)
  })

  it('denies patterns whose literal prefix goes through a link that leaves the project', (ctx) => {
    const link = path.join(cwd, 'docs-link')
    makeLink(ctx, outside, link)
    expect(isDenied(g('Glob', { pattern: 'docs-link/**' }))).toBe(true)
    expect(isDenied(g('Glob', { pattern: '{docs-link,x}/**' }))).toBe(true)
    expect(isDenied(g('Grep', { pattern: 'a', glob: '{src,docs-link}/*.{ts,txt}' }))).toBe(true)
    expect(isDenied(g('Glob', { pattern: 'docs-link/*.txt', path: cwd }))).toBe(true)
    expect(isDenied(g('Grep', { pattern: 'a', glob: 'docs-link/**/*.txt' }))).toBe(true)
    expect(isDenied(g('Grep', { pattern: 'a', glob: '*.txt', path: 'docs-link' }))).toBe(true)
    expect(g('Glob', { pattern: 'src/**' })).toEqual({})
  })
})

describe('guardPreToolUse never touches the filesystem for UNC and other drives (F2)', () => {
  beforeEach(() => {
    fsCalls.n = 0
  })

  it.runIf(process.platform === 'win32')('denies UNC, extended-length and other-drive paths up front', () => {
    const cases = [
      '\\\\attacker\\share\\x',
      '//attacker/share/x',
      '\\\\?\\C:\\x',
      '\\\\.\\pipe\\x',
      'Z:\\nope\\x'
    ]
    for (const p of cases) {
      expect(isDenied(g('Read', { file_path: p }))).toBe(true)
      expect(isDenied(g('Grep', { pattern: 'a', path: p }))).toBe(true)
      expect(isDenied(g('Glob', { pattern: '**', path: p }))).toBe(true)
      expect(isDenied(g('Glob', { pattern: p + '\\*' }))).toBe(true)
    }
    expect(fsCalls.n).toBe(0)
  })

  it('denies UNC-style brace expansions without touching the filesystem', () => {
    for (const p of ['{\\\\host\\s,x}/*', '{src,\\\\host\\s}/*', '{//h/s,x}/*']) {
      expect(isDenied(g('Glob', { pattern: p }))).toBe(true)
    }
    expect(fsCalls.n).toBe(0)
  })

  it('denies lexical brace escapes without touching the filesystem (F23)', () => {
    for (const p of ['{..,x}/*', '{~,x}/*', '{a,{..,b}}/x']) {
      expect(isDenied(g('Glob', { pattern: p }))).toBe(true)
    }
    expect(fsCalls.n).toBe(0)
  })

  it('denies an absolute brace expansion outside the project with only a few probes', () => {
    expect(isDenied(g('Glob', { pattern: '{/etc,x}/*' }))).toBe(true)
    expect(fsCalls.n).toBeLessThan(10)
  })

  it('does not touch the filesystem to deny an over-long brace pattern or a "[" in braces', () => {
    expect(isDenied(g('Glob', { pattern: '{a,b}' + 'x'.repeat(600) }))).toBe(true)
    expect(isDenied(g('Glob', { pattern: '{a,[b]}/*' }))).toBe(true)
    expect(fsCalls.n).toBe(0)
  })

  it('still resolves legitimate paths with the filesystem', () => {
    expect(g('Read', { file_path: 'a.txt' })).toEqual({})
    expect(fsCalls.n).toBeGreaterThan(0)
  })
})

describe('guardPreToolUse bounds the filesystem work of brace expansion (S51)', () => {
  beforeEach(() => {
    fsCalls.n = 0
  })

  it('denies a deep pattern (more than 64 segments) lexically, with no fs calls', () => {
    const deep = '{a,b}/{c,d}/{e,f}/{g,h}/{i,j}/{k,l}/' + 'a/'.repeat(115) + '*'
    expect(deep.length).toBeLessThanOrEqual(512)
    const out = g('Glob', { pattern: deep })
    expect(isDenied(out)).toBe(true)
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('64 path segments')
    expect(fsCalls.n).toBe(0)
    expect(isDenied(g('Grep', { pattern: 'x', glob: deep }))).toBe(true)
    expect(fsCalls.n).toBe(0)
  })

  it('the worst allowed pattern (64 segments, 6 brace groups) is cheap and bounded', () => {
    const worst = '{a,b}/{c,d}/{e,f}/{g,h}/{i,j}/{k,l}/' + 'a/'.repeat(57) + '*'
    expect(g('Glob', { pattern: worst })).toEqual({})
    expect(fsCalls.n).toBeLessThan(200)
    fsCalls.n = 0
    expect(g('Grep', { pattern: 'x', glob: worst })).toEqual({})
    expect(fsCalls.n).toBeLessThan(200)
  })

  it('deduplicates expansions and resolves the real cwd once', () => {
    expect(g('Glob', { pattern: '{src,src,src}/{a,a}/*.ts' })).toEqual({})
    // cwd (2 probes) + src (2) + src/a missing (1)
    expect(fsCalls.n).toBeLessThanOrEqual(6)
  })

  it('denies with a clear reason when the probe budget is exceeded', () => {
    const names = Array.from({ length: 100 }, (_, i) => `q${i}`)
    for (const n of names) mkdirSync(path.join(cwd, 'fan', n, 'a', 'b', 'c', 'd', 'e'), { recursive: true })
    const out = g('Glob', { pattern: `fan/{${names.join(',')}}/a/b/c/d/e/*` })
    expect(isDenied(out)).toBe(true)
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('too complex')
    expect(fsCalls.n).toBeLessThanOrEqual(600)
  })

  it('allows a legitimate fan-out glob over existing directories (F30)', () => {
    const ps = Array.from({ length: 10 }, (_, i) => `p${i + 1}`)
    for (const p of ps) for (const x of ['a', 'b', 'c', 'd', 'e']) mkdirSync(path.join(cwd, p, 'src', x), { recursive: true })
    const pattern = `{${ps.join(',')}}/src/{a,b,c,d,e}/**/*.{ts,tsx}`
    expect(g('Glob', { pattern })).toEqual({})
    expect(g('Grep', { pattern: 'x', glob: pattern })).toEqual({})
  })

  it('memoizes probes: a repeated shared prefix costs each component once', () => {
    expect(g('Glob', { pattern: '{p1,p2}/src/{a,b,c}/**' })).toEqual({})
    // real cwd (1) + p1,p2 (2) + src x2 (2) + a,b,c x2 (6)
    expect(fsCalls.n).toBeLessThanOrEqual(11)
  })

  it('reports a clearly outside absolute target as outside even when the budget would be exhausted (F32)', () => {
    const names = Array.from({ length: 64 }, (_, i) => `q${i}`)
    const abs = outside.split(path.sep).join('/')
    const out = g('Glob', { pattern: `{fan/{${names.join(',')}}/a/b/c/*,${abs}/*}` })
    expect(isDenied(out)).toBe(true)
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('inside the project folder')
  })

  it('still allows existing in-project prefixes and denies a link prefix mid-pattern', (ctx) => {
    expect(g('Glob', { pattern: '{src,w0}/{x,y}/**' })).toEqual({})
    const link = path.join(cwd, 'deep-link')
    makeLink(ctx, outside, link)
    expect(isDenied(g('Glob', { pattern: '{src,deep-link}/**' }))).toBe(true)
    expect(isDenied(g('Glob', { pattern: 'src/../deep-link/*' }))).toBe(true)
    expect(isDenied(g('Glob', { pattern: '{a,deep-link}/x/y/*' }))).toBe(true)
  })
})

describe('guardPreToolUse bounds path arguments (S60, S61)', () => {
  beforeEach(() => {
    fsCalls.n = 0
  })

  const segs = (n: number) => 'a/'.repeat(n).slice(0, -1)

  it.each([5000, 50000])('denies %i repeated segments with no fs calls', (n) => {
    const long = segs(n)
    for (const out of [
      g('Read', { file_path: long }),
      g('Grep', { pattern: 'x', path: long }),
      g('Glob', { pattern: '*', path: long }),
      g('Read', { file_path: path.join(cwd, long) })
    ]) {
      expect(isDenied(out)).toBe(true)
      expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('64 path segments')
    }
    expect(fsCalls.n).toBe(0)
  })

  it('denies values longer than 4096 characters with no fs calls', () => {
    expect(isDenied(g('Read', { file_path: 'x'.repeat(4097) }))).toBe(true)
    expect(fsCalls.n).toBe(0)
  })

  it('allows exactly 64 segments and denies 65 (boundary)', () => {
    mkdirSync(path.join(cwd, 'deep64'), { recursive: true })
    const ok = 'deep64/' + segs(63)
    expect(g('Read', { file_path: ok })).toEqual({})
    expect(fsCalls.n).toBeLessThan(10)
    fsCalls.n = 0
    expect(isDenied(g('Read', { file_path: 'deep64/' + segs(64) }))).toBe(true)
    expect(fsCalls.n).toBe(0)
  })

  it('allows a legitimate existing 64-segment in-project path within the budget', () => {
    const parts = Array.from({ length: 63 }, (_, i) => `d${i}`)
    const dir = path.join(cwd, 'legit', ...parts)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'f.txt'), 'x')
    const rel = ['legit', ...parts].join('/') + '/f.txt'
    expect(rel.split('/').length).toBe(65)
    const rel64 = ['legit', ...parts.slice(0, 62)].join('/') + '/f.txt'
    mkdirSync(path.join(cwd, 'legit', ...parts.slice(0, 62)), { recursive: true })
    writeFileSync(path.join(cwd, 'legit', ...parts.slice(0, 62), 'f.txt'), 'x')
    expect(g('Read', { file_path: rel64 })).toEqual({})
    expect(fsCalls.n).toBeLessThanOrEqual(70)
  })

  it('denies a Read/Grep/Glob path through a junction pointing outside', (ctx) => {
    const link = path.join(cwd, 'out-link')
    makeLink(ctx, outside, link)
    expect(isDenied(g('Read', { file_path: 'out-link/data.txt' }))).toBe(true)
    expect(isDenied(g('Read', { file_path: 'out-link' }))).toBe(true)
    expect(isDenied(g('Grep', { pattern: 'x', path: 'out-link' }))).toBe(true)
    expect(isDenied(g('Glob', { pattern: '*', path: 'out-link/sub' }))).toBe(true)
    expect(isDenied(g('Read', { file_path: path.join(cwd, 'out-link', 'data.txt') }))).toBe(true)
  })

  it('allows a missing path and still denies a prefix sibling', () => {
    expect(g('Read', { file_path: 'nope/missing.txt' })).toEqual({})
    expect(isDenied(g('Read', { file_path: path.join(outside, 'data.txt') }))).toBe(true)
  })
})

describe('guardPreToolUse denies win32 trailing dot and space segments lexically (S70)', () => {
  beforeEach(() => {
    fsCalls.n = 0
  })

  it.runIf(process.platform === 'win32').each([
    ['Grep path', () => g('Grep', { pattern: 'x', path: 'jfirst.' })],
    ['Read file', () => g('Read', { file_path: 'jfirst./s.txt' })],
    ['Read file, backslash', () => g('Read', { file_path: 'jfirst.\\s.txt' })],
    ['Read intermediate segment', () => g('Read', { file_path: 'src/a/jmid./s.txt' })],
    ['Read absolute', () => g('Read', { file_path: path.join(cwd, 'jfirst.', 's.txt') })],
    ['Read trailing space', () => g('Read', { file_path: 'jfirst /s.txt' })],
    ['Glob path', () => g('Glob', { pattern: '*', path: 'jfirst.' })],
    ['Glob prefix', () => g('Glob', { pattern: 'jfirst./**' })],
    ['Glob intermediate prefix', () => g('Glob', { pattern: 'src/jmid./**/*.ts' })],
    ['Glob literal pattern', () => g('Glob', { pattern: 'jfirst./s.txt' })],
    ['Glob brace expansion', () => g('Glob', { pattern: '{src,jfirst.}/**' })],
    ['Glob nested brace expansion', () => g('Glob', { pattern: 'src/{a,{b,jmid. }}/**' })],
    ['Grep glob prefix', () => g('Grep', { pattern: 'x', glob: 'jfirst./**' })],
    ['Grep glob brace expansion', () => g('Grep', { pattern: 'x', glob: '{jfirst.,src}/*.ts' })]
  ])('denies %s with no fs calls', (_name, call) => {
    expect(isDenied(call())).toBe(true)
    expect(fsCalls.n).toBe(0)
  })

  it.runIf(process.platform === 'win32')('keeps allowing "." and "..", inner dots and dot-prefixed names', () => {
    expect(g('Read', { file_path: './a.txt' })).toEqual({})
    expect(g('Read', { file_path: 'src/./../a.txt' })).toEqual({})
    expect(g('Read', { file_path: '.hidden/a.b.txt' })).toEqual({})
    expect(g('Glob', { pattern: 'src/**/*.' })).toEqual({})
  })

  it.runIf(process.platform === 'win32')('denies a junction reached through a trailing-dot name', (ctx) => {
    const link = path.join(cwd, 'jfirst')
    try {
      symlinkSync(outside, link, 'junction')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) ctx.skip()
      throw error
    }
    fsCalls.n = 0
    expect(isDenied(g('Grep', { pattern: 'x', path: 'jfirst.' }))).toBe(true)
    expect(isDenied(g('Read', { file_path: 'jfirst./data.txt' }))).toBe(true)
    expect(fsCalls.n).toBe(0)
  })
})

describe('guardPreToolUse bounds the cost of link chains (S61)', () => {
  it('resolves a long chain of in-project junctions with a bounded number of calls', (ctx) => {
    const target = path.join(cwd, 'chain-real')
    mkdirSync(target, { recursive: true })
    let prev = target
    try {
      for (let i = 0; i < 60; i++) {
        const link = path.join(cwd, `chain-${i}`)
        symlinkSync(prev, link, 'junction')
        prev = link
      }
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) ctx.skip()
      throw error
    }
    fsCalls.n = 0
    fsCalls.jsRealpath = 0
    const head = path.basename(prev)
    expect(g('Read', { file_path: `${head}/f.txt` })).toEqual({})
    expect(g('Glob', { pattern: `{${head},src}/{a,b,c}/**` })).toEqual({})
    // One native call per link regardless of chain length (previously one per hop).
    expect(fsCalls.n).toBeLessThan(25)
    // The JS realpath walks every hop in userland (~130 ms per probe for 60 hops); only the native one is allowed.
    expect(fsCalls.jsRealpath).toBe(0)
  })
})

describe('guardPreToolUse budget, pattern caps and path forms (F40, F41, F42)', () => {
  beforeEach(() => {
    fsCalls.n = 0
  })

  it('allows a 16 x 8 fan-out glob that costs more than 256 probes (F40)', () => {
    const a = Array.from({ length: 16 }, (_, i) => `m${i}`)
    const b = Array.from({ length: 8 }, (_, i) => `n${i}`)
    for (const x of a) for (const y of b) mkdirSync(path.join(cwd, x, y, 'src'), { recursive: true })
    const pattern = `{${a.join(',')}}/{${b.join(',')}}/src/**`
    expect(g('Glob', { pattern })).toEqual({})
    expect(fsCalls.n).toBeGreaterThan(256)
    expect(fsCalls.n).toBeLessThanOrEqual(512)
  })

  it('denies a brace-free pattern longer than 4096 characters with no fs calls (F41)', () => {
    for (const out of [g('Glob', { pattern: 'x'.repeat(4097) }), g('Grep', { pattern: 'x', glob: '*'.repeat(4097) })]) {
      expect(isDenied(out)).toBe(true)
      expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('4096 characters')
    }
    expect(fsCalls.n).toBe(0)
  })

  it('counts only literal-prefix segments toward the segment cap (F41)', () => {
    expect(g('Glob', { pattern: 'src/' + '*/'.repeat(100) + 'x' })).toEqual({})
    expect(isDenied(g('Glob', { pattern: 'a/'.repeat(65) + '*' }))).toBe(true)
  })

  it.runIf(process.platform === 'win32')('treats long and 8.3 forms of the cwd alike (F42)', (ctx) => {
    const long = realpathSync.native(cwd)
    if (long.toLowerCase() === cwd.toLowerCase()) ctx.skip() // the temp dir has no short form here
    expect(guardPreToolUse({ tool_name: 'Read', tool_input: { file_path: path.join(long, 'a.txt') } }, cwd)).toEqual({})
    // Documented limit: an 8.3 path under a long-form cwd fails closed (usability only, never unsafe).
    expect(isDenied(guardPreToolUse({ tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'a.txt') } }, long))).toBe(true)
    expect(isDenied(guardPreToolUse({ tool_name: 'Read', tool_input: { file_path: path.join(outside, 'data.txt') } }, long))).toBe(true)
  })
})

describe('guardPreToolUse link edge cases (F43)', () => {
  it('allows a dangling link whose target is inside and denies one whose target is outside', (ctx) => {
    makeLink(ctx, path.join(cwd, 'nope-inside'), path.join(cwd, 'dang-in'))
    makeLink(ctx, path.join(outside, 'nope-outside'), path.join(cwd, 'dang-out'))
    expect(g('Read', { file_path: 'dang-in/x.txt' })).toEqual({})
    expect(isDenied(g('Read', { file_path: 'dang-out/x.txt' }))).toBe(true)
    expect(isDenied(g('Glob', { pattern: 'dang-out/**' }))).toBe(true)
  })

  it('resolves relative link targets', (ctx) => {
    makeLink(ctx, path.join('..', 'proj-evil'), path.join(cwd, 'rel-out'), 'dir')
    makeLink(ctx, path.join('..', 'proj', 'src'), path.join(cwd, 'rel-in'), 'dir')
    expect(isDenied(g('Read', { file_path: 'rel-out/data.txt' }))).toBe(true)
    expect(g('Read', { file_path: 'rel-in/x.txt' })).toEqual({})
  })

  it('works when the cwd is itself a link', (ctx) => {
    const cwdLink = path.join(root, 'proj-link')
    makeLink(ctx, cwd, cwdLink)
    const viaLink = (file_path: string) => guardPreToolUse({ tool_name: 'Read', tool_input: { file_path } }, cwdLink)
    expect(viaLink('a.txt')).toEqual({})
    expect(viaLink(path.join(cwdLink, 'a.txt'))).toEqual({})
    expect(viaLink(path.join(realpathSync.native(cwd), 'a.txt'))).toEqual({})
    expect(isDenied(viaLink(path.join(outside, 'data.txt')))).toBe(true)
    expect(isDenied(viaLink('../proj-evil/data.txt'))).toBe(true)
  })

  it.runIf(process.platform === 'win32')('is case-insensitive for paths and links on win32', (ctx) => {
    makeLink(ctx, outside, path.join(cwd, 'case-link'))
    expect(g('Read', { file_path: path.join(cwd.toUpperCase(), 'A.TXT') })).toEqual({})
    expect(isDenied(g('Read', { file_path: path.join(outside.toUpperCase(), 'DATA.TXT') }))).toBe(true)
    expect(isDenied(g('Read', { file_path: 'CASE-LINK/data.txt' }))).toBe(true)
    expect(isDenied(g('Glob', { pattern: '{src,Case-Link}/**' }))).toBe(true)
  })
})

describe('guardPreToolUse denies backslashes in globs on POSIX (F12)', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor
  afterEach(() => Object.defineProperty(process, 'platform', realPlatform))
  const as = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { ...realPlatform, value: platform })

  it('denies an escaped ".." glob on linux with no fs calls', () => {
    as('linux')
    fsCalls.n = 0
    expect(isDenied(g('Glob', { pattern: '\\.\\./x' }))).toBe(true)
    expect(isDenied(g('Grep', { pattern: 'x', glob: 'src/\\*.ts' }))).toBe(true)
    expect(fsCalls.n).toBe(0)
  })

  it('does not apply the rule on win32, where a backslash is a separator', () => {
    as('win32')
    expect(isDenied(g('Glob', { pattern: 'src\\*.ts' }))).toBe(false)
    expect(isDenied(g('Glob', { pattern: '..\\x' }))).toBe(true)
  })
})

describe('guardPreToolUse walks the prefix through parentheses and "!" (S71)', () => {
  for (const dir of ['(grp)', 'a!b', 'a]b', 'x)']) it(`denies an absolute glob through a junction below "${dir}"`, (ctx) => {
    mkdirSync(path.join(cwd, dir), { recursive: true })
    makeLink(ctx, outside, path.join(cwd, dir, 'jin'))
    const abs = path.join(cwd, dir, 'jin').split(path.sep).join('/')
    expect(isDenied(g('Glob', { pattern: abs + '/*' }))).toBe(true)
    expect(isDenied(g('Grep', { pattern: 'x', glob: abs + '/**' }))).toBe(true)
    expect(isDenied(g('Glob', { pattern: dir + '/jin/*' }))).toBe(true)
    expect(g('Glob', { pattern: dir + '/*.ts' })).toEqual({})
  })
})

describe('guardPreToolUse denies whitespace-padded and drive-rooted paths (S73, S74)', () => {
  beforeEach(() => {
    fsCalls.n = 0
  })

  const WS = [' ', '\t', '\n', '\r', '\u00a0', '\u2003', '\ufeff']

  it.each(WS)('denies a path padded with %j, which the tool would trim, with no fs calls', (w) => {
    for (const out of [
      g('Grep', { pattern: 'S', path: w + 'C:\\Windows' }),
      g('Grep', { pattern: 'S', path: '..' + w }),
      g('Glob', { pattern: '*', path: '..' + w }),
      g('Grep', { pattern: 'S', path: w + '\\\\127.0.0.1\\c$' }),
      g('Read', { file_path: w + 'a.txt' }),
      g('Glob', { pattern: cwd + '\\..' + w + '\\*' }),
      g('Glob', { pattern: '{src,..' + w + '}/*' })
    ]) {
      expect(isDenied(out)).toBe(true)
    }
    expect(fsCalls.n).toBe(0)
  })

  it('still allows names with inner spaces', () => {
    mkdirSync(path.join(cwd, 'my docs'), { recursive: true })
    expect(g('Read', { file_path: 'my docs/a.txt' })).toEqual({})
    expect(g('Glob', { pattern: 'my docs/**/*.ts' })).toEqual({})
  })

  it.runIf(process.platform === 'win32')('denies rooted paths without a drive letter on win32', () => {
    const q = '/' + path.parse(cwd).root[0]?.toLowerCase() + '/Windows'
    for (const out of [
      g('Grep', { pattern: 'S', path: q }),
      g('Glob', { pattern: '*', path: '/cygdrive/c/Windows' }),
      g('Glob', { pattern: q + '/*' }),
      g('Read', { file_path: q + '/win.ini' })
    ]) {
      expect(isDenied(out)).toBe(true)
    }
    expect(fsCalls.n).toBe(0)
  })
})

/* ---------- Phase 3: policy (T8) ---------- */

import { linkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PROTECTED_PATHS } from '../../shared/settings'
import { protectedGrepExclusions, type ToolPolicy } from './tools'

const policy = (over: Partial<ToolPolicy> = {}): ToolPolicy => ({
  protectedPatterns: DEFAULT_PROTECTED_PATHS,
  allowGitRead: false,
  allowPlanWrites: false,
  ...over
})
const gp = (p: unknown, tool_name: string, tool_input?: unknown, dir: string = cwd) =>
  guardPreToolUse({ hook_event_name: 'PreToolUse', tool_name, tool_input }, dir, p as ToolPolicy)

describe('guardPreToolUse protected paths (T8)', () => {
  beforeAll(() => {
    writeFileSync(path.join(cwd, '.env'), 's')
    writeFileSync(path.join(cwd, '.env.example'), 's')
    writeFileSync(path.join(cwd, 'k.pem'), 's')
    mkdirSync(path.join(cwd, 'a'), { recursive: true })
    writeFileSync(path.join(cwd, 'a', '.env.local'), 's')
    mkdirSync(path.join(cwd, '.git'), { recursive: true })
    writeFileSync(path.join(cwd, '.git', 'config'), 's')
    mkdirSync(path.join(cwd, 'vault.key'), { recursive: true })
    writeFileSync(path.join(cwd, 'vault.key', 'x.txt'), 's')
  })

  it('applies the default list without a policy argument and keeps Grep unrewritten', () => {
    expect(isDenied(g('Read', { file_path: '.env' }))).toBe(true)
    expect(g('Read', { file_path: '.env.example' })).toEqual({})
    expect(g('Grep', { pattern: 'x' })).toEqual({})
  })

  it.each(['.env', 'a/.env.local', 'k.pem', '.git/config', '.git', 'vault.key/x.txt'])('denies Read of %s', (file) => {
    for (const target of [file, path.join(cwd, file)]) {
      const out = gp(policy(), 'Read', { file_path: target })
      expect(isDenied(out)).toBe(true)
      expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('protected')
    }
  })

  it('allows .env.example and unrelated files', () => {
    expect(gp(policy(), 'Read', { file_path: '.env.example' })).toEqual({})
    expect(gp(policy(), 'Read', { file_path: 'a.txt' })).toEqual({})
  })

  it('denies a protected Grep path or Glob prefix, and a literal protected glob', () => {
    expect(isDenied(gp(policy(), 'Grep', { pattern: 'x', path: '.git' }))).toBe(true)
    expect(isDenied(gp(policy(), 'Grep', { pattern: 'x', path: 'vault.key' }))).toBe(true)
    expect(isDenied(gp(policy(), 'Glob', { pattern: '.git/**' }))).toBe(true)
    expect(isDenied(gp(policy(), 'Glob', { pattern: '.env' }))).toBe(true)
    expect(isDenied(gp(policy(), 'Glob', { pattern: '*', path: '.git' }))).toBe(true)
    expect(gp(policy(), 'Glob', { pattern: 'src/**' })).toEqual({})
  })

  it('keeps the outside denial first', () => {
    const out = gp(policy(), 'Read', { file_path: path.join(outside, 'data.txt') })
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('inside the project')
  })

  it('uses custom patterns and honours a re-allow', () => {
    const p = policy({ protectedPatterns: ['a/', '!a/.env.local'] })
    expect(isDenied(gp(p, 'Read', { file_path: 'a/.env.local' }))).toBe(true) // parent dir stays excluded
    expect(gp(p, 'Read', { file_path: '.env' })).toEqual({})
    expect(gp(policy({ protectedPatterns: [] }), 'Read', { file_path: '.env' })).toEqual({})
  })

  it('falls back to the defaults when the pattern list is unusable', () => {
    const bad = policy({ protectedPatterns: ['ok', 'x\0y'] })
    expect(isDenied(gp(bad, 'Read', { file_path: '.env' }))).toBe(true)
    expect(gp(bad, 'Read', { file_path: 'a.txt' })).toEqual({})
  })

  it('denies a link whose real path is protected (junction)', (ctx) => {
    makeLink(ctx, path.join(cwd, 'vault.key'), path.join(cwd, 'vault-link'))
    try {
      expect(isDenied(gp(policy(), 'Read', { file_path: 'vault-link/x.txt' }))).toBe(true)
      expect(isDenied(gp(policy(), 'Glob', { pattern: 'vault-link/*' }))).toBe(true)
    } finally {
      rmSync(path.join(cwd, 'vault-link'), { recursive: true, force: true })
    }
  })

  it('matches a case variant on win32 (case-insensitive matcher)', (ctx) => {
    if (process.platform !== 'win32') return ctx.skip()
    expect(isDenied(gp(policy(), 'Read', { file_path: '.ENV' }))).toBe(true)
    expect(isDenied(gp(policy(), 'Read', { file_path: 'K.PEM' }))).toBe(true)
  })

  it('denies the 8.3 short name of a protected file on win32', (ctx) => {
    if (process.platform !== 'win32') return ctx.skip()
    const short = execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${path.join(cwd, '.env')}") do @echo %~sI`], {
      encoding: 'utf8'
    }).trim()
    if (!short.includes('~')) return ctx.skip()
    expect(isDenied(gp(policy(), 'Read', { file_path: short }))).toBe(true)
  })
})

describe('guardPreToolUse malformed policy (T8)', () => {
  it.each([
    null,
    5,
    'x',
    {},
    { protectedPatterns: 'x', allowGitRead: false, allowPlanWrites: false },
    { protectedPatterns: [1], allowGitRead: false, allowPlanWrites: false },
    { protectedPatterns: [], allowGitRead: 'yes', allowPlanWrites: false }
  ])('denies everything for %j', (bad) => {
    expect(isDenied(gp(bad, 'Read', { file_path: 'a.txt' }))).toBe(true)
    expect(isDenied(gp(bad, 'Skill'))).toBe(true)
  })

  it('never throws on a hostile policy object', () => {
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('boom')
        }
      }
    )
    expect(isDenied(gp(hostile, 'Read', { file_path: 'a.txt' }))).toBe(true)
  })
})

describe('guardPreToolUse git tools (T8)', () => {
  const [STATUS, LOG, DIFF] = ['mcp__git__git_status', 'mcp__git__git_log', 'mcp__git__git_diff'] as [string, string, string]

  it.each([STATUS, LOG, DIFF])('denies %s unless allowGitRead', (tool) => {
    expect(isDenied(gp(policy(), tool, {}))).toBe(true)
    expect(isDenied(guardPreToolUse({ tool_name: tool, tool_input: {} }, cwd))).toBe(true)
    expect(gp(policy({ allowGitRead: true }), tool, {})).toEqual({})
  })

  it('allows exactly the MCP tools the user ticked, and ToolSearch to load them', () => {
    const p = policy({ extraTools: ['mcp__linear__list_issues'] })
    expect(gp(p, 'mcp__linear__list_issues', { team: 'x' })).toEqual({})
    expect(isDenied(gp(p, 'mcp__linear__create_issue', {}))).toBe(true)
    expect(isDenied(gp(p, 'mcp__other__list_issues', {}))).toBe(true)
    expect(gp(p, 'ToolSearch', { query: 'linear' })).toEqual({})
    expect(isDenied(gp(policy(), 'mcp__linear__list_issues', {}))).toBe(true)
    // A malformed list denies everything.
    expect(isDenied(gp({ ...policy(), extraTools: ['Bash'] }, 'Read', { file_path: 'a.ts' }))).toBe(true)
    expect(isDenied(gp({ ...policy(), extraTools: 'mcp__x__y' }, 'Read', { file_path: 'a.ts' }))).toBe(true)
  })

  it('allows ToolSearch in plan mode, where it loads the deferred start_pipeline tool', () => {
    expect(gp(policy({ allowPipelineStart: true }), 'ToolSearch', { query: 'select:mcp__desk__start_pipeline' })).toEqual({})
    expect(isDenied(gp(policy({ allowPipelineStart: true }), 'ToolSearch', 'start'))).toBe(true)
    expect(isDenied(gp(policy({ allowPlanWrites: true }), 'ToolSearch', { query: 'start' }))).toBe(true)
  })

  it('allows ToolSearch only with allowGitRead or pipeline start', () => {
    expect(isDenied(gp(policy(), 'ToolSearch', { query: 'git' }))).toBe(true)
    expect(gp(policy({ allowGitRead: true }), 'ToolSearch', { query: 'git', max_results: 3 })).toEqual({})
    expect(isDenied(gp(policy({ allowGitRead: true }), 'ToolSearch', 'git'))).toBe(true)
  })

  it('keeps every other MCP tool, shell and edit tool denied', () => {
    const on = policy({ allowGitRead: true, allowPlanWrites: true })
    for (const tool of ['mcp__git__git_push', 'mcp__x__git_status', 'mcp__git__', 'Bash', 'PowerShell', 'Edit', 'NotebookEdit']) {
      expect(isDenied(gp(on, tool, {})), tool).toBe(true)
    }
  })

  it('checks the path argument like Read, including protected and outside paths', () => {
    const on = policy({ allowGitRead: true })
    expect(gp(on, LOG, { maxCount: 5, path: 'src' })).toEqual({})
    expect(gp(on, DIFF, { staged: true, path: 'a.txt' })).toEqual({})
    expect(isDenied(gp(on, DIFF, { path: '.env' }))).toBe(true)
    expect(isDenied(gp(on, LOG, { path: '.git/config' }))).toBe(true)
    expect(isDenied(gp(on, LOG, { path: '..' }))).toBe(true)
    expect(isDenied(gp(on, DIFF, { path: path.join(outside, 'data.txt') }))).toBe(true)
    expect(isDenied(gp(on, DIFF, { path: 5 }))).toBe(true)
  })

  it('denies unexpected input keys and non-object input', () => {
    const on = policy({ allowGitRead: true })
    expect(isDenied(gp(on, STATUS, { path: 'a' }))).toBe(true)
    expect(isDenied(gp(on, LOG, { args: ['--output=x'] }))).toBe(true)
    expect(isDenied(gp(on, DIFF, []))).toBe(true)
  })
})

describe('guardPreToolUse plan writes (T8)', () => {
  let wcwd: string
  const on = policy({ allowPlanWrites: true })
  const abs = (slug: string, dir = wcwd) => path.join(dir, 'docs', 'plans', `${slug}.md`)
  const w = (file_path: unknown, extra: Record<string, unknown> = {}, p: ToolPolicy = on) =>
    gp(p, 'Write', { file_path, content: 'hello', ...extra }, wcwd)
  let n = 0
  beforeEach(() => {
    wcwd = path.join(root, `wproj-${n++}`)
    mkdirSync(wcwd)
    fsCalls.n = 0
  })

  it('is denied unless allowPlanWrites', () => {
    expect(isDenied(w(abs('x'), {}, policy()))).toBe(true)
    expect(isDenied(guardPreToolUse({ tool_name: 'Write', tool_input: { file_path: 'docs/plans/x.md', content: 'a' } }, wcwd))).toBe(true)
  })

  it('allows the absolute and relative exact shapes when the folders do not exist yet', () => {
    expect(w(abs('my-plan-2'))).toEqual({})
    expect(w('docs/plans/my-plan-2.md')).toEqual({})
  })

  it('lets the planner Edit an existing plan, and nothing else', () => {
    const e = (file_path: unknown, extra: Record<string, unknown> = {}, p: ToolPolicy = on) =>
      gp(p, 'Edit', { file_path, old_string: 'a', new_string: 'b', ...extra }, wcwd)
    expect(isDenied(e(abs('my-plan')))).toBe(true)
    mkdirSync(path.join(wcwd, 'docs', 'plans'), { recursive: true })
    writeFileSync(abs('my-plan'), 'a')
    expect(e(abs('my-plan'))).toEqual({})
    expect(e('docs/plans/my-plan.md', { replace_all: true })).toEqual({})
    expect(isDenied(e(abs('other')))).toBe(true)
    expect(isDenied(e(path.join(wcwd, 'src', 'a.ts')))).toBe(true)
    expect(isDenied(e(abs('my-plan'), {}, policy()))).toBe(true)
    expect(isDenied(e(abs('my-plan'), { content: 'x' }))).toBe(true)
    expect(isDenied(e(abs('my-plan'), { replace_all: 'yes' }))).toBe(true)
    expect(isDenied(e(abs('my-plan'), { new_string: 'x'.repeat(300 * 1024) }))).toBe(true)
  })

  it('denies every non-exact shape with zero filesystem calls', () => {
    const bad: unknown[] = [
      'docs/plans/../x.md',
      'docs/plans/x.md.',
      'docs\\plans\\x.md',
      './docs/plans/x.md',
      'Docs/plans/x.md',
      'docs/plans/X.md',
      'docs/plans/sub/x.md',
      'docs/plans/x.txt',
      'docs/plans/x.md ',
      'docs/plans/-x.md',
      'docs/plans/x--y.md',
      'docs/plans/x_y.md',
      `docs/plans/${'a'.repeat(65)}.md`,
      'docs/plans/.md',
      'x.md',
      '',
      7,
      null,
      abs('x').replace('docs', 'DOCS'),
      abs('x') + '.',
      abs('sub/x'),
      [wcwd, 'docs', 'plans', '..', 'plans', 'x.md'].join(path.sep),
      path.join(wcwd, 'x.md'),
      path.join(outside, 'docs', 'plans', 'x.md'),
      '//host/share/docs/plans/x.md'
    ]
    for (const file_path of bad) {
      expect(isDenied(w(file_path)), String(file_path)).toBe(true)
    }
    expect(isDenied(w(abs('x'), { extra: 1 }))).toBe(true)
    expect(isDenied(w(abs('x'), { content: 'x'.repeat(200_001) }))).toBe(true)
    expect(isDenied(w(abs('x'), { content: 5 }))).toBe(true)
    expect(isDenied(gp(on, 'Write', { file_path: abs('x') }, wcwd))).toBe(true)
    expect(isDenied(gp(on, 'Write', undefined, wcwd))).toBe(true)
    expect(fsCalls.n).toBe(0)
    expect(w(abs('a'.repeat(64)))).toEqual({})
  })

  it('allows a new or existing regular file', () => {
    mkdirSync(path.join(wcwd, 'docs', 'plans'), { recursive: true })
    expect(w(abs('new'))).toEqual({})
    writeFileSync(abs('old'), 'x')
    expect(w(abs('old'))).toEqual({})
    expect(w('docs/plans/old.md')).toEqual({})
    expect(w(abs('x'), { content: 'x'.repeat(200_000) })).toEqual({})
  })

  it('denies when docs or docs/plans is a link or junction', (ctx) => {
    mkdirSync(path.join(outside, 'plans'), { recursive: true })
    makeLink(ctx, outside, path.join(wcwd, 'docs'))
    expect(isDenied(w(abs('x')))).toBe(true)
    rmSync(path.join(wcwd, 'docs'), { recursive: true, force: true })
    mkdirSync(path.join(wcwd, 'docs'))
    makeLink(ctx, path.join(outside, 'plans'), path.join(wcwd, 'docs', 'plans'))
    expect(isDenied(w(abs('x')))).toBe(true)
    expect(isDenied(w('docs/plans/x.md'))).toBe(true)
  })

  it('denies a symlink target', (ctx) => {
    mkdirSync(path.join(wcwd, 'docs', 'plans'), { recursive: true })
    writeFileSync(path.join(outside, 'victim.txt'), 'v')
    makeLink(ctx, path.join(outside, 'victim.txt'), abs('lnk'), 'dir')
    expect(isDenied(w(abs('lnk')))).toBe(true)
  })

  it('denies a hard link and a directory target', () => {
    mkdirSync(path.join(wcwd, 'docs', 'plans'), { recursive: true })
    writeFileSync(path.join(outside, 'victim2.txt'), 'v')
    linkSync(path.join(outside, 'victim2.txt'), abs('hard'))
    expect(isDenied(w(abs('hard')))).toBe(true)
    mkdirSync(abs('dir'))
    expect(isDenied(w(abs('dir')))).toBe(true)
  })

  it('denies when docs is a file', () => {
    writeFileSync(path.join(wcwd, 'docs'), 'x')
    expect(isDenied(w(abs('x')))).toBe(true)
  })

  it('lets a protected pattern deny the target', () => {
    const p = policy({ allowPlanWrites: true, protectedPatterns: ['docs/plans/secret*.md'] })
    expect(isDenied(w(abs('secret-one'), {}, p))).toBe(true)
    expect(isDenied(w('docs/plans/secret-one.md', {}, p))).toBe(true)
    expect(w(abs('open'), {}, p)).toEqual({})
    mkdirSync(path.join(wcwd, 'docs', 'plans'), { recursive: true })
    expect(isDenied(w(abs('secret-one'), {}, p))).toBe(true)
  })
})

describe('guardPreToolUse Grep exclusions (T8)', () => {
  it('rewrites glob through updatedInput with the user glob first', () => {
    const out = gp(policy(), 'Grep', { pattern: 'x', glob: '*.ts', path: 'src' })
    const h = out.hookSpecificOutput
    expect(h?.permissionDecision).toBe('allow')
    const glob = h?.updatedInput?.['glob'] as string
    expect(glob.startsWith('*.ts !**/')).toBe(true)
    for (const e of protectedGrepExclusions(['.env.*', '.git/'])) expect(glob).toContain(e)
    expect(h?.updatedInput?.['pattern']).toBe('x')
    expect(h?.updatedInput?.['path']).toBe('src')
  })

  it('sets glob when absent and leaves input alone with no convertible patterns', () => {
    const out = gp(policy(), 'Grep', { pattern: 'x' })
    expect(typeof out.hookSpecificOutput?.updatedInput?.['glob']).toBe('string')
    expect(gp(policy({ protectedPatterns: [] }), 'Grep', { pattern: 'x' })).toEqual({})
    expect(gp(policy({ protectedPatterns: ['!keep'] }), 'Grep', { pattern: 'x' })).toEqual({})
  })

  it('still denies a protected path before rewriting', () => {
    expect(isDenied(gp(policy(), 'Grep', { pattern: 'x', path: '.env' }))).toBe(true)
  })

  it('converts patterns to ripgrep exclusions (posix)', () => {
    expect(protectedGrepExclusions(['.env', '*.pem', '.git/', '!.env.example', '#c', '', '/root.txt', 'a b'], 'linux')).toEqual([
      '!**/.env',
      '!**/.env/**',
      '!**/*.pem',
      '!**/*.pem/**',
      '!**/.git/**',
      '!**/root.txt',
      '!**/root.txt/**',
      '!**/a?b',
      '!**/a?b/**'
    ])
  })

  it('folds case on win32 outside character classes', () => {
    expect(protectedGrepExclusions(['.env', '[A-C]x/'], 'win32')).toEqual([
      '!**/.[eE][nN][vV]',
      '!**/.[eE][nN][vV]/**',
      '!**/[A-Ca-c][xX]/**'
    ])
  })

  it('folds case inside character classes on win32 (F1)', () => {
    expect(protectedGrepExclusions(['[a-z]x.pem'], 'win32')[0]).toBe('!**/[a-zA-Z][xX].[pP][eE][mM]')
    expect(protectedGrepExclusions(['[!ab]'], 'win32')[0]).toBe('!**/[!aAbB]')
    expect(protectedGrepExclusions(['[a-z]x.pem'], 'linux')[0]).toBe('!**/[a-z]x.pem')
  })

  it('converts escapes instead of skipping the pattern (F1)', () => {
    expect(protectedGrepExclusions(['\\#secret.txt'], 'linux')).toEqual(['!**/#secret.txt', '!**/#secret.txt/**'])
    expect(protectedGrepExclusions(['\\!bang', 'a\\ b', 'x\\*y', 'z\\'], 'linux')).toEqual([
      '!**/!bang',
      '!**/!bang/**',
      '!**/a?b',
      '!**/a?b/**',
      '!**/x[*]y',
      '!**/x[*]y/**',
      '!**/z',
      '!**/z/**'
    ])
    // An unescaped leading "#" is a comment and still protects nothing.
    expect(protectedGrepExclusions(['#comment'], 'linux')).toEqual([])
  })
})

describe('guardPreToolUse denies NTFS stream syntax on win32 (S1)', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor
  afterEach(() => Object.defineProperty(process, 'platform', realPlatform))
  const as = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { ...realPlatform, value: platform })
  const suffixes = ['::$DATA', ':$DATA', '::$INDEX_ALLOCATION', ':$I30:$INDEX_ALLOCATION']
  const full = policy({ allowGitRead: true, allowPlanWrites: true })

  for (const suffix of suffixes) {
    it(`denies "${suffix}" in every tool with no fs calls`, () => {
      as('win32')
      fsCalls.n = 0
      const abs = `C:\\proj\\.env${suffix}`
      const calls: GuardOutputLike[] = [
        g('Read', { file_path: `.env${suffix}` }),
        g('Read', { file_path: abs }),
        g('Read', { file_path: `.git${suffix}/config` }),
        g('Grep', { pattern: 'x', path: `.env${suffix}` }),
        g('Grep', { pattern: 'x', path: abs }),
        g('Grep', { pattern: 'x', glob: `.env${suffix}` }),
        g('Grep', { pattern: 'x', glob: `{a,.env${suffix}}` }),
        g('Glob', { pattern: `.env${suffix}` }),
        g('Glob', { pattern: `.git${suffix}/*` }),
        g('Glob', { pattern: `src/*${suffix}` }),
        g('Glob', { pattern: `{a,.env${suffix}}` }),
        g('Glob', { pattern: '*', path: `.git${suffix}` }),
        gp(full, 'mcp__git__git_log', { path: `.env${suffix}` }),
        gp(full, 'mcp__git__git_diff', { path: `.git${suffix}` })
      ]
      calls.forEach((c, i) => expect(isDenied(c), `call ${i}`).toBe(true))
      expect(fsCalls.n).toBe(0)
    })

    it(`denies "${suffix}" in a plan file name through the slug grammar (not the colon rule)`, () => {
      as('win32')
      expect(isDenied(gp(full, 'Write', { file_path: `docs/plans/x${suffix}.md`, content: 'a' }))).toBe(true)
      expect(isDenied(gp(full, 'Write', { file_path: `docs/plans/x.md${suffix}`, content: 'a' }))).toBe(true)
    })
  }

  it('keeps allowing ordinary names and drive-absolute paths', () => {
    as('win32')
    expect(g('Read', { file_path: 'a-b' })).toEqual({})
    expect(g('Glob', { pattern: 'a-b/*.ts' })).toEqual({})
    expect(g('Read', { file_path: path.join(cwd, 'a.txt') })).toEqual({})
  })

  it.runIf(process.platform !== 'win32')('does not apply on POSIX, where ":" is a legal name character', () => {
    as('linux')
    expect(g('Read', { file_path: 'a:b' })).toEqual({})
    expect(g('Glob', { pattern: 'a:b/*' })).toEqual({})
  })

  it.runIf(process.platform === 'win32')('denies reading a real protected file through the stream syntax', () => {
    const dir = path.join(root, 'stream-proj')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, '.env'), 'SECRET=1')
    const call = (file_path: string) => guardPreToolUse({ tool_name: 'Read', tool_input: { file_path } }, dir)
    expect(isDenied(call('.env'))).toBe(true)
    expect(isDenied(call('.env::$DATA'))).toBe(true)
    expect(isDenied(call(path.join(dir, '.env::$DATA')))).toBe(true)
  })
})

type GuardOutputLike = ReturnType<typeof guardPreToolUse>

describe('guardPreToolUse plan writes: device names and canonical target (F2, F3)', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor
  afterEach(() => Object.defineProperty(process, 'platform', realPlatform))
  const as = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { ...realPlatform, value: platform })
  const on = policy({ allowPlanWrites: true })

  it('denies Windows device names as slugs on win32 with no fs calls', () => {
    as('win32')
    fsCalls.n = 0
    for (const slug of ['nul', 'con', 'prn', 'aux', 'com1', 'lpt9', 'com0']) {
      expect(isDenied(gp(on, 'Write', { file_path: `docs/plans/${slug}.md`, content: 'a' }, cwd)), slug).toBe(true)
    }
    expect(fsCalls.n).toBe(0)
    expect(gp(on, 'Write', { file_path: 'docs/plans/nul-x.md', content: 'a' }, cwd)).toEqual({})
    expect(gp(on, 'Write', { file_path: 'docs/plans/com10.md', content: 'a' }, cwd)).toEqual({})
  })

  it.runIf(process.platform !== 'win32')('allows such slugs on POSIX', () => {
    as('linux')
    expect(gp(on, 'Write', { file_path: 'docs/plans/nul.md', content: 'a' }, cwd)).toEqual({})
  })

  it.runIf(process.platform === 'darwin')('matches protected patterns by the on-disk case on macOS', () => {
    const dir = path.join(root, 'mac-proj')
    mkdirSync(path.join(dir, 'Docs', 'plans'), { recursive: true })
    const p = policy({ allowPlanWrites: true, protectedPatterns: ['Docs/plans/secret*.md'] })
    expect(isDenied(gp(p, 'Write', { file_path: 'docs/plans/secret-one.md', content: 'a' }, dir))).toBe(true)
  })
})

describe('guardPreToolUse start_pipeline (plan mode)', () => {
  const name = 'mcp__desk__start_pipeline'
  const call = (p?: ToolPolicy) => guardPreToolUse({ tool_name: name, tool_input: { planFile: 'a.md' } }, process.cwd(), p)

  it('is allowed only when the policy enables pipeline start', () => {
    expect(isDenied(call())).toBe(true)
    expect(isDenied(call(policy({ allowPlanWrites: true })))).toBe(true)
    expect(call(policy({ allowPlanWrites: true, allowPipelineStart: true }))).toEqual({})
  })

  it('keeps Bash and other desk-looking tools denied in plan mode', () => {
    const p = policy({ allowPlanWrites: true, allowPipelineStart: true })
    expect(isDenied(guardPreToolUse({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, process.cwd(), p))).toBe(true)
    expect(isDenied(guardPreToolUse({ tool_name: 'mcp__desk__merge', tool_input: {} }, process.cwd(), p))).toBe(true)
  })
})
