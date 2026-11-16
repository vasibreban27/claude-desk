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
      actual.realpathSync
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

  it('denies a symlink that points outside', () => {
    const link = path.join(cwd, 'link')
    try {
      symlinkSync(outside, link, 'junction')
    } catch {
      return // symlinks unavailable
    }
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

  it('denies patterns whose literal prefix goes through a link that leaves the project', () => {
    const link = path.join(cwd, 'docs-link')
    try {
      symlinkSync(outside, link, 'junction')
    } catch {
      return // symlinks unavailable
    }
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

  it('the worst allowed pattern (64 segments, 64 expansions) is cheap and bounded', () => {
    const worst = '{a,b}/{c,d}/{e,f}/{g,h}/{i,j}/{k,l}/' + 'a/'.repeat(57) + '*'
    const t0 = performance.now()
    expect(g('Glob', { pattern: worst })).toEqual({})
    const ms = performance.now() - t0
    expect(fsCalls.n).toBeLessThan(200)
    expect(ms).toBeLessThan(500) // generous: guards against pathological regressions only
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
    const names = Array.from({ length: 64 }, (_, i) => `q${i}`)
    for (const n of names) mkdirSync(path.join(cwd, 'fan', n, 'a', 'b', 'c'), { recursive: true })
    const out = g('Glob', { pattern: `fan/{${names.join(',')}}/a/b/c/*` })
    expect(isDenied(out)).toBe(true)
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('too complex')
    expect(fsCalls.n).toBeLessThanOrEqual(300)
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

  it('still allows existing in-project prefixes and denies a link prefix mid-pattern', () => {
    expect(g('Glob', { pattern: '{src,w0}/{x,y}/**' })).toEqual({})
    const link = path.join(cwd, 'deep-link')
    try {
      symlinkSync(outside, link, 'junction')
    } catch {
      return // symlinks unavailable
    }
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
    const t0 = performance.now()
    expect(g('Read', { file_path: rel64 })).toEqual({})
    const ms = performance.now() - t0
    expect(fsCalls.n).toBeLessThanOrEqual(70)
    expect(ms).toBeLessThan(500)
  })

  it('denies a Read/Grep/Glob path through a junction pointing outside', () => {
    const link = path.join(cwd, 'out-link')
    try {
      symlinkSync(outside, link, 'junction')
    } catch {
      return // symlinks unavailable
    }
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
