/**
 * "Merge into main": the user's click brings a finished run into the base branch of the primary checkout.
 * Fast-forward only (never a merge commit, never a rewrite), never pushed. Refuses when the checkout is on another
 * branch, has tracked changes, or the base branch moved since the run started. The plan file the run used is
 * committed afterwards when it is untracked or modified (that path only).
 */
import { execFile } from 'node:child_process'
import { GIT_ENV_ADDITIONS, GIT_MAX_BUFFER, GIT_PREFIX, GIT_TIMEOUT_MS } from './worktrees'

export type GitExec = (cwd: string, args: string[]) => Promise<string>

export const defaultGitExec: GitExec = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_PREFIX, ...args],
      {
        cwd,
        env: { ...process.env, ...GIT_ENV_ADDITIONS },
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: 'utf8',
        windowsHide: true
      },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr: typeof stderr === 'string' ? stderr : '' }))
        else resolve(stdout)
      }
    )
  })

const IDENTITY = ['-c', 'user.name=claude-desk', '-c', 'user.email=claude-desk@localhost', '-c', 'commit.gpgsign=false']

export type MergeRunError = 'wrong-branch' | 'dirty' | 'not-fast-forward' | 'git-failed'
export type MergeRunResult =
  | { ok: true; head: string; planCommitted: boolean }
  | { ok: false; error: MergeRunError; message: string }

export interface MergeRunArgs {
  projectPath: string
  baseBranch: string
  runBranch: string
  /** Plan file name inside docs/plans (already validated by PLAN_FILE_PATTERN). */
  planFile: string
}

export async function mergeRunIntoBase(args: MergeRunArgs, git: GitExec = defaultGitExec): Promise<MergeRunResult> {
  const cwd = args.projectPath
  try {
    const current = (await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim()
    if (current !== args.baseBranch) {
      return { ok: false, error: 'wrong-branch', message: `The project is on "${current || 'detached HEAD'}"; switch to ${args.baseBranch} first.` }
    }
  } catch {
    return { ok: false, error: 'wrong-branch', message: `The project is not on ${args.baseBranch}.` }
  }
  try {
    const tracked = (await git(cwd, ['status', '--porcelain=v1', '--untracked-files=no'])).trim()
    if (tracked !== '') return { ok: false, error: 'dirty', message: 'The project has uncommitted changes to tracked files; commit or stash them first.' }
    try {
      await git(cwd, ['merge-base', '--is-ancestor', '--end-of-options', `refs/heads/${args.baseBranch}`, `refs/heads/${args.runBranch}`])
    } catch {
      return { ok: false, error: 'not-fast-forward', message: `${args.baseBranch} moved since the run started; merge ${args.runBranch} by hand.` }
    }
    await git(cwd, ['merge', '--ff-only', '--quiet', '--end-of-options', `refs/heads/${args.runBranch}`])
    const planPath = `docs/plans/${args.planFile}`
    const planState = (await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--', planPath])).trim()
    let planCommitted = false
    if (planState !== '') {
      await git(cwd, ['add', '--', planPath])
      await git(cwd, [...IDENTITY, 'commit', '--quiet', '-m', `docs(plan): ${args.planFile}`, '--', planPath])
      planCommitted = true
    }
    const head = (await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim()
    return { ok: true, head, planCommitted }
  } catch (e) {
    const stderr = (e as { stderr?: unknown }).stderr
    const text = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : e instanceof Error ? e.message : 'git failed'
    return { ok: false, error: 'git-failed', message: text.slice(0, 300) }
  }
}
