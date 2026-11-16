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
    '{a,b}'.repeat(7)
  ])('denies brace pattern %s', (pattern) => {
    expect(isDenied(g('Glob', { pattern }))).toBe(true)
    expect(isDenied(g('Grep', { pattern: 'a', glob: pattern }))).toBe(true)
  })

  it('denies an expansion longer than the cap', () => {
    expect(isDenied(g('Glob', { pattern: '{a,b}' + 'x'.repeat(600) }))).toBe(true)
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

  it('still resolves legitimate paths with the filesystem', () => {
    expect(g('Read', { file_path: 'a.txt' })).toEqual({})
    expect(fsCalls.n).toBeGreaterThan(0)
  })
})
