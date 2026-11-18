import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createWorkerTools, type ExecFn } from '../src/main/pipeline/workerTools'
import type { CheckConfig } from '../src/shared/settings'

// Real vitest child processes are slow on Windows.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 })

const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join('\n')

const require = createRequire(import.meta.url)
const vitestEntry = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs')

const PASSING = "test('passes', () => { expect(1 + 1).toBe(2) })\n"

describe('run_check with a real vitest in a temp project (4b-1 verification)', () => {
  let dir: string
  beforeAll(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'p4b-checks-')))
    fs.mkdirSync(path.join(dir, 'tests'))
    fs.writeFileSync(path.join(dir, 'tests', 'one.test.js'), PASSING)
    fs.writeFileSync(path.join(dir, 'tests', 'two.test.js'), PASSING)
  })
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const check: CheckConfig = {
    name: 'test',
    executable: process.execPath,
    args: [vitestEntry, 'run', '--globals'],
    timeoutMs: 150_000,
    acceptsTestPath: true
  }
  const make = (exec?: ExecFn) =>
    createWorkerTools({
      taskId: 'T1',
      worktree: dir,
      branch: 'task/x-t1',
      owns: ['tests/'],
      checks: [check],
      onBlocked: () => undefined,
      ...(exec ? { exec } : {})
    })

  it('passes with a testPath and runs only that file, under the reduced environment', async () => {
    const t = make()
    const r = await t.handlers.run_check({ name: 'test', testPath: 'tests/one.test.js' })
    const out = text(r)
    expect(r.isError, out).toBeUndefined()
    expect(t.getCheckResult()).toBe('passed')
    expect(out).toContain('one.test.js')
    expect(out).not.toContain('two.test.js')
  })

  it('passes without a testPath and runs both files', async () => {
    const t = make()
    const r = await t.handlers.run_check({ name: 'test' })
    expect(r.isError, text(r)).toBeUndefined()
    expect(text(r)).toContain('one.test.js')
    expect(text(r)).toContain('two.test.js')
  })

  it('records whether npm --version starts through the tool', async () => {
    const t = createWorkerTools({
      taskId: 'T1',
      worktree: dir,
      branch: 'task/x-t1',
      owns: ['tests/'],
      checks: [{ name: 'npm-v', executable: 'npm', args: ['--version'], timeoutMs: 60_000 }],
      onBlocked: () => undefined
    })
    const r = await t.handlers.run_check({ name: 'npm-v' })
    // The outcome is recorded in docs/notes/phase-4b-1-checks-verify.md; here it only must not throw.
    expect(typeof text(r)).toBe('string')
    console.log(`npm check: ${r.isError ? 'not started/failed' : 'passed'}: ${text(r).split('\n').slice(0, 2).join(' | ')}`)
  })
})

describe('git_commit after a failed commit (F6, real git)', () => {
  it('leaves nothing staged from the committed paths', async () => {
    const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'p4b-f6-')))
    try {
      const git = (...args: string[]): string =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], {
          cwd: repo,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        })
      git('init', '-q', '-b', 'task-branch')
      fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
      git('add', '--', 'a.txt')
      git('commit', '-q', '-m', 'init')
      fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n')
      fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n')
      // A pre-commit-free failure: an empty identity makes `git commit` fail after `git add` succeeded.
      const t = createWorkerTools({
        taskId: 'T1',
        worktree: repo,
        branch: 'task-branch',
        owns: ['a.txt', 'new.txt'],
        checks: [],
        onBlocked: () => undefined,
        exec: async (file, args, options) => {
          const isCommit = args.includes('commit')
          const argv = isCommit ? args.map((a) => (a.startsWith('user.email=') ? 'user.email=' : a)) : args
          return new Promise((resolve, reject) => {
            try {
              const stdout = execFileSync(file, argv, { cwd: options.cwd, env: { ...options.env, GIT_COMMITTER_EMAIL: '', GIT_AUTHOR_EMAIL: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
              resolve({ stdout, stderr: '' })
            } catch (e) {
              reject(e)
            }
          })
        }
      })
      const r = await t.handlers.git_commit({ paths: ['a.txt', 'new.txt'], message: 'm' })
      expect(r.isError, text(r)).toBe(true)
      expect(git('diff', '--cached', '--name-only').trim()).toBe('')
      expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('two\n')
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})
