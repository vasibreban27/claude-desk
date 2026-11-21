import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ToolkitGit, ToolkitUpdateResult } from '../../shared/toolkit'

/**
 * The toolkit folder in Settings: finding the plugin inside a picked folder, and its git state and update. Git runs
 * with execFile and argument arrays, no prompts, inside the toolkit folder only.
 */

export type GitExec = (cwd: string, args: string[], timeoutMs: number) => Promise<string>

const defaultExec: GitExec = (cwd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr: typeof stderr === 'string' ? stderr : '' }))
        else resolve(stdout)
      }
    )
  })

const isPlugin = (dir: string): boolean => {
  try {
    return statSync(path.join(dir, '.claude-plugin', 'plugin.json')).isFile()
  } catch {
    return false
  }
}

/**
 * The plugin folder for a picked folder: the folder itself when it is a plugin, else its one plugin under `plugins/`
 * (the `flow` plugin when there are several). Null when none is found.
 */
export function findToolkitPlugin(picked: string): string | null {
  const root = path.resolve(picked)
  if (isPlugin(root)) return root
  const plugins = path.join(root, 'plugins')
  if (!existsSync(plugins)) return null
  let names: string[]
  try {
    names = readdirSync(plugins).filter((n) => isPlugin(path.join(plugins, n))).sort()
  } catch {
    return null
  }
  if (names.length === 1) return path.join(plugins, names[0] as string)
  if (names.includes('flow')) return path.join(plugins, 'flow')
  return null
}

const errText = (e: unknown): string => {
  const x = e as { stderr?: unknown; message?: unknown }
  const s = typeof x.stderr === 'string' && x.stderr.trim() ? x.stderr : typeof x.message === 'string' ? x.message : 'git failed'
  return s.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300)
}

/** Branch, last commit and uncommitted state of the toolkit's git repo; null when it is not a git repo. */
export async function readToolkitGit(folder: string, exec: GitExec = defaultExec): Promise<ToolkitGit | null> {
  try {
    const branch = (await exec(folder, ['rev-parse', '--abbrev-ref', 'HEAD'], 10_000)).trim()
    const last = (await exec(folder, ['log', '-1', '--format=%h%x00%cs%x00%s'], 10_000)).trim().split('\0')
    const dirty = (await exec(folder, ['status', '--porcelain', '--untracked-files=no'], 10_000)).trim() !== ''
    return {
      branch: branch === 'HEAD' ? null : branch,
      commit: last[0] ?? '',
      date: last[1] ?? '',
      subject: (last[2] ?? '').slice(0, 200),
      dirty
    }
  } catch {
    return null
  }
}

/** Fast-forwards the toolkit from its remote. Refused with uncommitted changes; never merges or rewrites. */
export async function updateToolkit(folder: string, exec: GitExec = defaultExec): Promise<ToolkitUpdateResult> {
  const before = await readToolkitGit(folder, exec)
  if (before === null) return { ok: false, error: 'not-a-repo', message: 'The toolkit folder is not a git repository.' }
  if (before.dirty) {
    return { ok: false, error: 'dirty', message: 'The toolkit has uncommitted changes. Commit or stash them in claude-toolkit first.' }
  }
  if (before.branch === null) return { ok: false, error: 'failed', message: 'The toolkit is on a detached HEAD; switch it to a branch first.' }
  try {
    await exec(folder, ['pull', '--ff-only', '--quiet'], 120_000)
  } catch (e) {
    return { ok: false, error: 'failed', message: `git pull failed: ${errText(e)}` }
  }
  const after = await readToolkitGit(folder, exec)
  const to = after?.commit ?? before.commit
  return { ok: true, updated: to !== before.commit, from: before.commit, to }
}
