import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROTECTED_PATHS } from '../../shared/settings'
import { checkWritablePath } from './workerGuard'
import { createWorkerTools } from './workerTools'

let wt: string
const OWNS = ['src/a/', 'src/b/']
const g = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: wt, encoding: 'utf8' }).trim()

beforeEach(() => {
  wt = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'move-commit-')))
  g('init', '-q', '-b', 'task/x-t1')
  for (const f of ['src/a/One.java', 'src/a/Two.java', 'src/a/Old.java']) {
    mkdirSync(path.join(wt, path.dirname(f)), { recursive: true })
    writeFileSync(path.join(wt, f), `class ${path.basename(f, '.java')} {}\n`)
  }
  g('add', '.')
  g('commit', '-q', '-m', 'init')
})
afterEach(() => rmSync(wt, { recursive: true, force: true }))

describe('moving and deleting, then git_commit (real git)', () => {
  it('commits the moves as renames and the deletion', async () => {
    const h = createWorkerTools({
      taskId: 'T1',
      worktree: wt,
      branch: 'task/x-t1',
      owns: OWNS,
      checks: [],
      onBlocked: () => undefined,
      checkPath: (tool, rel) => checkWritablePath(tool, rel, { worktree: wt, owns: OWNS, protectedPatterns: DEFAULT_PROTECTED_PATHS })
    }).handlers
    expect(
      (await h.move_files({ moves: [{ from: 'src/a/One.java', to: 'src/b/One.java' }, { from: 'src/a/Two.java', to: 'src/b/Two.java' }] })).isError
    ).toBeUndefined()
    expect((await h.delete_files({ paths: ['src/a/Old.java'] })).isError).toBeUndefined()
    const r = await h.git_commit({
      paths: ['src/a/One.java', 'src/b/One.java', 'src/a/Two.java', 'src/b/Two.java', 'src/a/Old.java'],
      message: 'refactor: move to b'
    })
    expect(r.isError, r.content[0]?.text).toBeUndefined()
    expect(g('status', '--porcelain')).toBe('')
    expect(g('show', '--name-status', '--format=', '-M', 'HEAD').split('\n').sort()).toEqual([
      'D\tsrc/a/Old.java',
      'R100\tsrc/a/One.java\tsrc/b/One.java',
      'R100\tsrc/a/Two.java\tsrc/b/Two.java'
    ])
  })
})
