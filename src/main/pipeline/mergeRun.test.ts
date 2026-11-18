import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergeRunIntoBase } from './mergeRun'

let repo: string
const g = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
    encoding: 'utf8'
  }).trim()

beforeEach(() => {
  repo = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'merge-run-')))
  g('init', '-q', '-b', 'main')
  g('commit', '-q', '--allow-empty', '-m', 'init')
  g('branch', 'run/abcd1234')
  g('switch', '-q', 'run/abcd1234')
  writeFileSync(path.join(repo, 'app.py'), 'print(1)\n')
  g('add', 'app.py')
  g('commit', '-q', '-m', 'work')
  g('switch', '-q', 'main')
  mkdirSync(path.join(repo, 'docs', 'plans'), { recursive: true })
  writeFileSync(path.join(repo, 'docs', 'plans', 'todo.md'), '# plan\n')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

const args = () => ({ projectPath: repo, baseBranch: 'main', runBranch: 'run/abcd1234', planFile: 'todo.md' })

describe('mergeRunIntoBase (real git)', () => {
  it('fast-forwards main to the run and commits the untracked plan file', async () => {
    const r = await mergeRunIntoBase(args())
    expect(r).toMatchObject({ ok: true, planCommitted: true })
    expect(g('log', '--format=%s', '-3')).toBe('docs(plan): todo.md\nwork\ninit')
    expect(g('status', '--porcelain')).toBe('')
  })

  it('refuses when the checkout is on another branch', async () => {
    g('switch', '-q', '-c', 'other')
    expect(await mergeRunIntoBase(args())).toMatchObject({ ok: false, error: 'wrong-branch' })
  })

  it('refuses with tracked changes and leaves main untouched', async () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'a')
    g('add', 'tracked.txt')
    const before = g('rev-parse', 'main')
    expect(await mergeRunIntoBase(args())).toMatchObject({ ok: false, error: 'dirty' })
    expect(g('rev-parse', 'main')).toBe(before)
  })

  it('refuses when main moved since the run started (no merge commit)', async () => {
    g('commit', '-q', '--allow-empty', '-m', 'moved')
    const before = g('rev-parse', 'main')
    expect(await mergeRunIntoBase(args())).toMatchObject({ ok: false, error: 'not-fast-forward' })
    expect(g('rev-parse', 'main')).toBe(before)
  })
})
