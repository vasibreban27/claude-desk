import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_PROTECTED_PATHS } from '../../shared/settings'
import { isDenied } from '../chat/tools'
import { guardWorkerToolUse, type WorkerGuardContext } from './workerGuard'

let root: string
let wt: string
let outside: string
let ctx: WorkerGuardContext

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'wguard-')))
  wt = path.join(root, 'wt')
  outside = path.join(root, 'outside')
  mkdirSync(path.join(wt, 'src', 'feature'), { recursive: true })
  mkdirSync(path.join(wt, '.git'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(path.join(wt, 'src', 'a.ts'), 'a')
  writeFileSync(path.join(wt, 'src', 'feature', 'b.ts'), 'b')
  writeFileSync(path.join(wt, 'other.ts'), 'o')
  writeFileSync(path.join(wt, 'src', 'a.pem'), 'k')
  writeFileSync(path.join(outside, 'x.ts'), 'x')
  ctx = { worktree: wt, owns: ['src/a.ts', 'src/feature/', 'src/a.pem', 'src/new.ts', '.git/config'], protectedPatterns: DEFAULT_PROTECTED_PATHS }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const write = (file: string, extra: Record<string, unknown> = {}) => ({
  tool_name: 'Write',
  tool_input: { file_path: file, content: 'x', ...extra }
})

describe('guardWorkerToolUse: Write and Edit', () => {
  it('allows a file covered by Owns (absolute and relative), a new file and a directory prefix', () => {
    expect(isDenied(guardWorkerToolUse(write(path.join(wt, 'src', 'a.ts')), ctx))).toBe(false)
    expect(isDenied(guardWorkerToolUse(write('src/a.ts'), ctx))).toBe(false)
    expect(isDenied(guardWorkerToolUse(write('src/new.ts'), ctx))).toBe(false)
    expect(isDenied(guardWorkerToolUse(write('src/feature/deep/c.ts'), ctx))).toBe(false)
    const edit = { tool_name: 'Edit', tool_input: { file_path: path.join(wt, 'src', 'a.ts'), old_string: 'a', new_string: 'b', replace_all: false } }
    expect(isDenied(guardWorkerToolUse(edit, ctx))).toBe(false)
  })

  it('denies files outside Owns, outside the worktree, and traversal', () => {
    expect(isDenied(guardWorkerToolUse(write('other.ts'), ctx))).toBe(true)
    expect(isDenied(guardWorkerToolUse(write(path.join(outside, 'x.ts')), ctx))).toBe(true)
    expect(isDenied(guardWorkerToolUse(write('../outside/x.ts'), ctx))).toBe(true)
    expect(isDenied(guardWorkerToolUse(write('src/../other.ts'), ctx))).toBe(true)
    expect(isDenied(guardWorkerToolUse(write('src'), ctx))).toBe(true)
  })

  it('denies protected paths and .git even when Owns covers them', () => {
    expect(isDenied(guardWorkerToolUse(write('src/a.pem'), ctx))).toBe(true)
    expect(isDenied(guardWorkerToolUse(write('.git/config'), ctx))).toBe(true)
  })

  it('denies unknown keys and malformed input', () => {
    expect(isDenied(guardWorkerToolUse(write('src/a.ts', { extra: 1 }), ctx))).toBe(true)
    expect(isDenied(guardWorkerToolUse({ tool_name: 'Write', tool_input: { file_path: 5 } }, ctx))).toBe(true)
    expect(isDenied(guardWorkerToolUse({ tool_name: 'Write', tool_input: null }, ctx))).toBe(true)
    expect(isDenied(guardWorkerToolUse({ tool_name: 'Write' }, ctx))).toBe(true)
    expect(isDenied(guardWorkerToolUse(write('src/a\0.ts'), ctx))).toBe(true)
  })

  it('denies a file reached through a directory junction or link', (t) => {
    const link = path.join(wt, 'src', 'feature', 'linkdir')
    try {
      symlinkSync(outside, link, 'junction')
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return t.skip()
      throw e
    }
    expect(isDenied(guardWorkerToolUse(write('src/feature/linkdir/x.ts'), ctx))).toBe(true)
    rmSync(link, { recursive: false, force: true })
  })

  it('denies a file that is itself a symlink', (t) => {
    const link = path.join(wt, 'src', 'feature', 'linkfile.ts')
    try {
      symlinkSync(path.join(outside, 'x.ts'), link, 'file')
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return t.skip()
      throw e
    }
    expect(isDenied(guardWorkerToolUse(write('src/feature/linkfile.ts'), ctx))).toBe(true)
    rmSync(link, { force: true })
  })

  it('denies a hard-linked file', (t) => {
    const hard = path.join(wt, 'src', 'feature', 'hard.ts')
    try {
      linkSync(path.join(outside, 'x.ts'), hard)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return t.skip()
      throw e
    }
    expect(isDenied(guardWorkerToolUse(write('src/feature/hard.ts'), ctx))).toBe(true)
    rmSync(hard, { force: true })
  })
})

describe('guardWorkerToolUse: other tools', () => {
  it.each(['Bash', 'PowerShell', 'Agent', 'Task', 'Skill', 'ToolSearch', 'mcp__evil__run', 'mcp__work__push'])(
    'denies %s',
    (tool_name) => {
      expect(isDenied(guardWorkerToolUse({ tool_name, tool_input: {} }, ctx))).toBe(true)
    }
  )

  it('denies malformed input and never throws', () => {
    for (const bad of [null, undefined, 5, 'x', {}, { tool_name: 5 }, { tool_name: '' }]) {
      expect(isDenied(guardWorkerToolUse(bad, ctx))).toBe(true)
    }
    expect(isDenied(guardWorkerToolUse({ tool_name: 'Read', tool_input: {} }, null as unknown as WorkerGuardContext))).toBe(true)
    const throwing = {
      tool_name: 'Write',
      get tool_input(): never {
        throw new Error('boom')
      }
    }
    expect(isDenied(guardWorkerToolUse(throwing, ctx))).toBe(true)
  })

  it('allows work and git MCP tools', () => {
    for (const n of ['run_check', 'git_commit', 'report_blocked']) {
      expect(guardWorkerToolUse({ tool_name: `mcp__work__${n}`, tool_input: {} }, ctx)).toEqual({})
    }
    expect(isDenied(guardWorkerToolUse({ tool_name: 'mcp__git__git_status', tool_input: {} }, ctx))).toBe(false)
  })

  it('applies the Phase 3 read rules inside the worktree', () => {
    expect(isDenied(guardWorkerToolUse({ tool_name: 'Read', tool_input: { file_path: path.join(wt, 'src', 'a.ts') } }, ctx))).toBe(false)
    expect(isDenied(guardWorkerToolUse({ tool_name: 'Read', tool_input: { file_path: path.join(outside, 'x.ts') } }, ctx))).toBe(true)
    expect(isDenied(guardWorkerToolUse({ tool_name: 'Read', tool_input: { file_path: path.join(wt, 'src', 'a.pem') } }, ctx))).toBe(true)
    expect(isDenied(guardWorkerToolUse({ tool_name: 'Glob', tool_input: { pattern: '../**' } }, ctx))).toBe(true)
  })
})
