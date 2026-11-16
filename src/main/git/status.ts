import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'

export const GIT_TIMEOUT_MS = 10_000

export type GitStatus = { branch: string | null; dirty: boolean }
export type GitStatusError = 'not-a-git-repo' | 'unreadable'
export type GitStatusResult = ({ ok: true } & GitStatus) | { ok: false; error: GitStatusError }

type GitRun = { code: number; stdout: string } | { spawnError: string }

function runGit(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (!error) {
          resolve({ code: 0, stdout })
          return
        }
        const code = (error as { code?: unknown }).code
        if (typeof code === 'number') resolve({ code, stdout })
        else resolve({ spawnError: String(code ?? error.name) })
      }
    )
  })
}

/**
 * Reads branch and dirty state of the repo at `path`. Never throws:
 * non-repos and unreadable folders are returned as errors.
 */
export async function readGitStatus(path: string): Promise<GitStatusResult> {
  try {
    if (!(await stat(path)).isDirectory()) return { ok: false, error: 'unreadable' }
  } catch {
    return { ok: false, error: 'unreadable' }
  }

  const inside = await runGit(path, ['rev-parse', '--is-inside-work-tree'])
  if ('spawnError' in inside) return { ok: false, error: 'unreadable' }
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return { ok: false, error: inside.code === 128 ? 'not-a-git-repo' : 'unreadable' }
  }

  // Fails (non-zero) on a detached HEAD: branch is then null. Works on an unborn branch.
  const head = await runGit(path, ['symbolic-ref', '--short', '-q', 'HEAD'])
  if ('spawnError' in head) return { ok: false, error: 'unreadable' }
  const name = head.code === 0 ? head.stdout.trim() : ''
  const branch = name === '' ? null : name

  const porcelain = await runGit(path, ['status', '--porcelain'])
  if ('spawnError' in porcelain || porcelain.code !== 0) return { ok: false, error: 'unreadable' }

  return { ok: true, branch, dirty: porcelain.stdout.trim() !== '' }
}
