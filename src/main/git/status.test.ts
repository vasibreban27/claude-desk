import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { readGitStatus } from './status'

// git is spawned here: allow more time than the global default, only for this file
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

const root = mkdtempSync(join(tmpdir(), 'desk-git-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' }
  )
}

let n = 0
function newRepo(commit: boolean): string {
  const dir = join(root, `r${n++}`)
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  if (commit) {
    writeFileSync(join(dir, 'a.txt'), 'a')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'init')
  }
  return dir
}

describe('readGitStatus', () => {
  it('reports branch and clean state', async () => {
    expect(await readGitStatus(newRepo(true))).toEqual({ ok: true, branch: 'main', dirty: false })
  })

  it('reports dirty for an untracked file', async () => {
    const dir = newRepo(true)
    writeFileSync(join(dir, 'new.txt'), 'x')
    expect(await readGitStatus(dir)).toMatchObject({ ok: true, dirty: true })
  })

  it('reports dirty for a modified file', async () => {
    const dir = newRepo(true)
    writeFileSync(join(dir, 'a.txt'), 'changed')
    expect(await readGitStatus(dir)).toMatchObject({ ok: true, dirty: true })
  })

  it('returns null branch on a detached HEAD', async () => {
    const dir = newRepo(true)
    git(dir, 'checkout', '-q', '--detach')
    expect(await readGitStatus(dir)).toEqual({ ok: true, branch: null, dirty: false })
  })

  it('returns the unborn branch name in a repo with no commits', async () => {
    expect(await readGitStatus(newRepo(false))).toEqual({ ok: true, branch: 'main', dirty: false })
  })

  it('returns not-a-git-repo for a plain folder', async () => {
    const dir = join(root, 'plain')
    mkdirSync(dir)
    expect(await readGitStatus(dir)).toEqual({ ok: false, error: 'not-a-git-repo' })
  })

  it('returns unreadable for a missing folder', async () => {
    expect(await readGitStatus(join(root, 'missing'))).toEqual({ ok: false, error: 'unreadable' })
  })
})
