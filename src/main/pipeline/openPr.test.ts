import { describe, expect, it, vi } from 'vitest'
import { hostOf, openPullRequest, prBranchName, type Exec } from './openPr'

const ARGS = {
  projectPath: '/proj',
  integrationPath: null,
  baseBranch: 'main',
  runBranch: 'run/f2700427',
  planFile: 'greet-cli.md',
  title: 'Greet CLI',
  body: 'Built by claude-desk'
}

/** A fake exec: `answers` maps "file first-args" prefixes to a result or an error. */
function fake(answers: Record<string, string | Error>) {
  const calls: { file: string; args: string[] }[] = []
  const exec: Exec = vi.fn(async (file: string, args: string[]) => {
    calls.push({ file, args })
    const plain = args.filter((a: string, i: number) => !(a === '-c' || args[i - 1] === '-c'))
    const key = Object.keys(answers)
      .sort((a, b) => b.length - a.length)
      .find((k) => `${file} ${plain.join(' ')}`.startsWith(k))
    const v = key === undefined ? '' : answers[key]
    if (v instanceof Error) throw v
    return { stdout: v ?? '', stderr: '' }
  })
  return { exec, calls }
}

const GH_OK = {
  'git remote get-url origin': 'git@github.com:vasibreban27/greet-cli.git\n',
  'git ls-remote': 'abc\trefs/heads/main\n',
  'gh pr create': 'https://github.com/vasibreban27/greet-cli/pull/3\n'
}

describe('hostOf / prBranchName', () => {
  it.each([
    ['https://github.com/o/r.git', 'github'],
    ['git@github.com:o/r.git', 'github'],
    ['ssh://git@github.com/o/r.git', 'github'],
    ['https://gitlab.com/g/r.git', 'gitlab'],
    ['git@gitlab.example.com:g/r.git', 'gitlab'],
    ['https://bitbucket.org/o/r.git', null],
    ['C:/repos/bare.git', null],
    ['https://evil.com/github.com/o/r', null]
  ])('%s -> %s', (url, host) => expect(hostOf(url)).toBe(host))

  it('names the review branch from the plan and run', () => {
    expect(prBranchName('greet-cli.md', 'run/f2700427')).toBe('desk/greet-cli-f2700427')
    expect(prBranchName('My Plan!.md', 'run/abc')).toBe('desk/my-plan-abc')
  })
})

describe('openPullRequest', () => {
  it('pushes the run branch under the review name and opens a PR into the base branch', async () => {
    const f = fake(GH_OK)
    const r = await openPullRequest(ARGS, f.exec)
    expect(r).toEqual({ ok: true, url: 'https://github.com/vasibreban27/greet-cli/pull/3', branch: 'desk/greet-cli-f2700427', host: 'github' })
    const push = f.calls.find((c) => c.args.includes('push'))
    expect(push?.args.slice(-3)).toEqual(['--set-upstream', 'origin', 'refs/heads/run/f2700427:refs/heads/desk/greet-cli-f2700427'].slice(-3))
    expect(push?.args).toContain('core.hooksPath=')
    const pr = f.calls.find((c) => c.file === 'gh' && c.args[0] === 'pr')
    expect(pr?.args).toEqual(['pr', 'create', '--base', 'main', '--head', 'desk/greet-cli-f2700427', '--title', 'Greet CLI', '--body', 'Built by claude-desk'])
    expect(f.calls.some((c) => c.args.join(' ').includes('push') && c.args.join(' ').includes('refs/heads/main:'))).toBe(false)
  })

  it('returns the existing PR when gh says it already exists', async () => {
    const err = Object.assign(new Error('exit 1'), {
      stdout: '',
      stderr: 'a pull request for branch "desk/greet-cli-f2700427" into branch "main" already exists:\nhttps://github.com/o/r/pull/2\n'
    })
    const f = fake({ ...GH_OK, 'gh pr create': err })
    expect(await openPullRequest(ARGS, f.exec)).toMatchObject({ ok: true, url: 'https://github.com/o/r/pull/2' })
  })

  it.each([
    ['no origin', { 'git remote get-url origin': new Error('no such remote') }, 'no-remote'],
    ['bitbucket', { 'git remote get-url origin': 'https://bitbucket.org/o/r.git' }, 'unsupported-host'],
    ['gh missing', { ...GH_OK, 'gh --version': new Error('ENOENT') }, 'no-cli'],
    ['gh logged out', { ...GH_OK, 'gh auth status': new Error('not logged in') }, 'not-logged-in'],
    ['base not pushed', { ...GH_OK, 'git ls-remote': '' }, 'base-not-on-remote'],
    ['push rejected', { ...GH_OK, 'git push': Object.assign(new Error('x'), { stderr: 'rejected' }) }, 'push-failed'],
    ['pr fails', { ...GH_OK, 'gh pr create': Object.assign(new Error('x'), { stderr: 'HTTP 422' }) }, 'pr-failed']
  ])('%s -> %s, with nothing pushed before the checks pass', async (_n, answers, error) => {
    const f = fake(answers as Record<string, string | Error>)
    const r = await openPullRequest(ARGS, f.exec)
    expect(r).toMatchObject({ ok: false, error })
    if (error !== 'push-failed' && error !== 'pr-failed') expect(f.calls.some((c) => c.args.includes('push'))).toBe(false)
  })

  it('uses glab for GitLab remotes', async () => {
    const f = fake({
      'git remote get-url origin': 'https://gitlab.com/g/r.git',
      'git ls-remote': 'abc\trefs/heads/main\n',
      'glab mr create': 'https://gitlab.com/g/r/-/merge_requests/7\n'
    })
    expect(await openPullRequest(ARGS, f.exec)).toMatchObject({ ok: true, host: 'gitlab', url: 'https://gitlab.com/g/r/-/merge_requests/7' })
    const mr = f.calls.find((c) => c.file === 'glab' && c.args[0] === 'mr')
    expect(mr?.args).toEqual(expect.arrayContaining(['--source-branch', 'desk/greet-cli-f2700427', '--target-branch', 'main', '--yes']))
  })
})
