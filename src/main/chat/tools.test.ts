import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
  it.each(['Agent', 'Task', 'Skill'])('allows %s', (tool_name) => {
    expect(g(tool_name)).toEqual({})
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
