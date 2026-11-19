import { execFile } from 'node:child_process'
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Project } from '../../shared/ipc'
import type { ProjectStore } from './store'

export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}$/
const RESERVED = new Set(['con', 'prn', 'aux', 'nul', ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)])

export type CreateProjectError = 'invalid-name' | 'no-root' | 'exists' | 'escape' | 'git-failed' | 'register-failed'
export type CreateProjectResult = { ok: true; project: Project } | { ok: false; error: CreateProjectError }

export type GitRun = (cwd: string, args: string[]) => Promise<void>

const GIT_HARDEN = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-c', 'core.pager=cat']

export const defaultGitRun: GitRun = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile('git', [...GIT_HARDEN, ...args], { cwd, timeout: 30_000, windowsHide: true, encoding: 'utf8' }, (err) =>
      err ? reject(err) : resolve()
    )
  })

const defaultReadBranch = (cwd: string): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(
      'git',
      [...GIT_HARDEN, 'symbolic-ref', '--short', '-q', 'HEAD'],
      { cwd, timeout: 10_000, windowsHide: true, encoding: 'utf8' },
      (err, out) => resolve(err ? null : out.trim() || null)
    )
  })

export function validProjectName(name: string): boolean {
  return PROJECT_NAME_RE.test(name) && !RESERVED.has(name) && !name.endsWith('-')
}

export interface CreateProjectDeps {
  store: ProjectStore
  git?: GitRun
  /** Current branch of the new repo (default: `git symbolic-ref`); null when it cannot be read. */
  readBranch?: (cwd: string) => Promise<string | null>
}

/**
 * Creates `<root>/<name>`, initialises git with an empty first commit and registers it.
 * The name is validated, the result is realpath-checked to stay inside the root, and the
 * new folder is removed again if anything after its creation fails.
 */
export async function createProject(
  root: string | null,
  name: string,
  deps: CreateProjectDeps,
  options: { claudeMd?: boolean } = {}
): Promise<CreateProjectResult> {
  if (!validProjectName(name)) return { ok: false, error: 'invalid-name' }
  if (!root) return { ok: false, error: 'no-root' }
  const git = deps.git ?? defaultGitRun
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch {
    return { ok: false, error: 'no-root' }
  }
  const target = path.join(realRoot, name)
  if (await stat(target).then(() => true, () => false)) return { ok: false, error: 'exists' }
  let created = false
  try {
    await mkdir(target)
    created = true
    const real = await realpath(target)
    if (path.dirname(real) !== realRoot) throw Object.assign(new Error('escape'), { escape: true })
    try {
      const id = ['-c', 'user.name=claude-desk', '-c', 'user.email=claude-desk@localhost', '-c', 'commit.gpgsign=false']
      await git(real, ['init', '-q', '-b', 'main'])
      await git(real, [...id, 'commit', '-q', '--allow-empty', '-m', 'chore: initial commit'])
      const files: string[] = []
      if (options.claudeMd) {
        await writeFile(path.join(real, 'CLAUDE.md'), `# ${name}\n`, { flag: 'wx' })
        files.push('CLAUDE.md')
      }
      if (files.length > 0) {
        await git(real, ['add', '--', ...files])
        await git(real, [...id, 'commit', '-q', '-m', 'docs: add CLAUDE.md'])
      }
    } catch {
      throw Object.assign(new Error('git'), { git: true })
    }
    const branch = await (deps.readBranch ?? defaultReadBranch)(real).catch(() => null)
    const added = await deps.store.add({ path: real, branch, dirty: false })
    if (!added.ok) throw new Error('register')
    return { ok: true, project: added.project }
  } catch (e) {
    if (created) await rm(target, { recursive: true, force: true }).catch(() => undefined)
    const tag = e as { escape?: boolean; git?: boolean }
    return { ok: false, error: tag.escape ? 'escape' : tag.git ? 'git-failed' : 'register-failed' }
  }
}
