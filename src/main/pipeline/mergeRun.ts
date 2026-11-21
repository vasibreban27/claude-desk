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

export type SaveBranchError = 'invalid-branch' | 'dirty' | 'not-fast-forward' | 'git-failed'
export type SaveBranchResult =
  | { ok: true; branch: string; head: string; created: boolean }
  | { ok: false; error: SaveBranchError; message: string }

export interface SaveBranchArgs {
  projectPath: string
  runBranch: string
  /** Already checked against BRANCH_NAME_PATTERN, the reserved prefixes and the base branch. */
  branch: string
}

const gitMessage = (e: unknown): string => {
  const stderr = (e as { stderr?: unknown }).stderr
  const text = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : e instanceof Error ? e.message : 'git failed'
  return text.slice(0, 300)
}

/**
 * "Save as branch": the user's click keeps a finished run as `branch`. A new branch is created at the run's tip; an
 * existing one is only fast-forwarded (refused when it has commits the run lacks). The checked-out branch of the
 * project never changes, except that a checked-out `branch` itself is fast-forwarded when its tracked files are clean.
 * Nothing is pushed, and the plan file is not added (it stays in the folder, so switching branches keeps working).
 */
export async function saveRunToBranch(args: SaveBranchArgs, git: GitExec = defaultGitExec): Promise<SaveBranchResult> {
  const cwd = args.projectPath
  const ref = `refs/heads/${args.branch}`
  const run = `refs/heads/${args.runBranch}`
  try {
    await git(cwd, ['check-ref-format', '--branch', args.branch])
  } catch {
    return { ok: false, error: 'invalid-branch', message: `"${args.branch}" is not a valid branch name.` }
  }
  try {
    const exists = await git(cwd, ['show-ref', '--verify', '--quiet', ref]).then(
      () => true,
      () => false
    )
    if (!exists) {
      await git(cwd, ['branch', '--no-track', '--end-of-options', args.branch, run])
      const head = (await git(cwd, ['rev-parse', '--short', ref])).trim()
      return { ok: true, branch: args.branch, head, created: true }
    }
    try {
      await git(cwd, ['merge-base', '--is-ancestor', '--end-of-options', ref, run])
    } catch {
      return {
        ok: false,
        error: 'not-fast-forward',
        message: `${args.branch} has commits this run does not have. Pick a new branch name, or merge ${args.runBranch} into it by hand.`
      }
    }
    const current = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).then(
      (s) => s.trim(),
      () => ''
    )
    if (current === args.branch) {
      const tracked = (await git(cwd, ['status', '--porcelain=v1', '--untracked-files=no'])).trim()
      if (tracked !== '') {
        return { ok: false, error: 'dirty', message: `${args.branch} is checked out with uncommitted changes; commit or stash them first.` }
      }
      await git(cwd, ['merge', '--ff-only', '--quiet', '--end-of-options', run])
    } else {
      // Refused by git when the branch is checked out in another worktree.
      await git(cwd, ['branch', '--force', '--no-track', '--end-of-options', args.branch, run])
    }
    const head = (await git(cwd, ['rev-parse', '--short', ref])).trim()
    return { ok: true, branch: args.branch, head, created: false }
  } catch (e) {
    return { ok: false, error: 'git-failed', message: gitMessage(e) }
  }
}
