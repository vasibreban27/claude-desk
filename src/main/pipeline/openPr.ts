/**
 * "Open pull request" for a finished run: pushes the run branch to `origin` under a review branch name and opens a
 * PR (GitHub, `gh`) or merge request (GitLab, `glab`) into the base branch with the CLI the user is already logged
 * in with. No tokens pass through the app. Nothing is merged; the base branch is never pushed.
 * Every process: execFile with an argument array, fixed cwd, timeout, no terminal prompts.
 */
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type ExecResult = { stdout: string; stderr: string }
export type Exec = (file: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<ExecResult>

const HARDEN = ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat']
const IDENTITY = ['-c', 'user.name=claude-desk', '-c', 'user.email=claude-desk@localhost', '-c', 'commit.gpgsign=false']

export const defaultExec: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GLAB_NO_PROMPT: '1' }
      },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }))
        else resolve({ stdout, stderr })
      }
    )
  })

export type PrHost = 'github' | 'gitlab'
export type OpenPrError = 'no-remote' | 'unsupported-host' | 'no-cli' | 'not-logged-in' | 'base-not-on-remote' | 'push-failed' | 'pr-failed'
export type OpenPrResult = { ok: true; url: string; branch: string; host: PrHost } | { ok: false; error: OpenPrError; message: string }

export interface OpenPrArgs {
  projectPath: string
  /** The run's integration worktree (the plan file is committed there when the run branch lacks it); may be gone. */
  integrationPath: string | null
  baseBranch: string
  runBranch: string
  /** Validated plan file name in docs/plans. */
  planFile: string
  title: string
  body: string
}

/** GitHub or GitLab from an origin URL (https or ssh form); null for anything else. */
export function hostOf(remoteUrl: string): PrHost | null {
  const u = remoteUrl.trim().toLowerCase()
  if (/^(https:\/\/|ssh:\/\/|git@)([^/]*@)?github\.com[:/]/.test(u)) return 'github'
  if (/^(https:\/\/|ssh:\/\/|git@)([^/]*@)?[^/:]*gitlab[^/:]*[:/]/.test(u)) return 'gitlab'
  return null
}

/** The review branch name: `desk/<plan slug>-<run id 8>`. */
export function prBranchName(planFile: string, runBranch: string): string {
  const slug = planFile.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plan'
  const run8 = runBranch.replace(/^run\//, '').slice(0, 8).replace(/[^a-zA-Z0-9]/g, '')
  return `desk/${slug}-${run8}`
}

const firstUrl = (text: string): string | null => /https:\/\/[^\s"'<>]+/.exec(text)?.[0] ?? null
const errText = (e: unknown): string => {
  const x = e as { stderr?: unknown; message?: unknown }
  const s = typeof x.stderr === 'string' && x.stderr.trim() ? x.stderr : typeof x.message === 'string' ? x.message : 'failed'
  return s.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300)
}

export async function openPullRequest(a: OpenPrArgs, exec: Exec = defaultExec): Promise<OpenPrResult> {
  const git = (args: string[], cwd = a.projectPath, timeoutMs = 30_000) => exec('git', [...HARDEN, ...args], { cwd, timeoutMs })

  let remote: string
  try {
    remote = (await git(['remote', 'get-url', 'origin'])).stdout.trim()
  } catch {
    return { ok: false, error: 'no-remote', message: 'The project has no "origin" remote. Create the repository on GitHub or GitLab and add it as origin first.' }
  }
  const host = hostOf(remote)
  if (host === null) return { ok: false, error: 'unsupported-host', message: 'Only GitHub (gh) and GitLab (glab) remotes are supported for now.' }
  const cli = host === 'github' ? 'gh' : 'glab'

  try {
    await exec(cli, ['--version'], { cwd: a.projectPath, timeoutMs: 15_000 })
  } catch {
    return { ok: false, error: 'no-cli', message: `${cli} was not found. Install it and run "${cli} auth login".` }
  }
  try {
    await exec(cli, ['auth', 'status'], { cwd: a.projectPath, timeoutMs: 30_000 })
  } catch {
    return { ok: false, error: 'not-logged-in', message: `${cli} is not logged in. Run "${cli} auth login" in a terminal.` }
  }

  try {
    const heads = (await git(['ls-remote', '--heads', 'origin', `refs/heads/${a.baseBranch}`], a.projectPath, 60_000)).stdout.trim()
    if (heads === '') {
      return {
        ok: false,
        error: 'base-not-on-remote',
        message: `origin has no ${a.baseBranch} branch yet. Push it once ("git push -u origin ${a.baseBranch}") so the pull request has a base.`
      }
    }
  } catch (e) {
    return { ok: false, error: 'push-failed', message: `Could not reach origin: ${errText(e)}` }
  }

  // The plan was written in the main checkout; put it on the run branch so the PR carries it.
  const planRel = `docs/plans/${a.planFile}`
  if (a.integrationPath !== null) {
    const inRun = await git(['cat-file', '-e', `refs/heads/${a.runBranch}:${planRel}`]).then(
      () => true,
      () => false
    )
    const wtExists = await access(a.integrationPath).then(
      () => true,
      () => false
    )
    if (!inRun && wtExists) {
      try {
        const text = await readFile(path.join(a.projectPath, 'docs', 'plans', a.planFile), 'utf8')
        await mkdir(path.join(a.integrationPath, 'docs', 'plans'), { recursive: true })
        await writeFile(path.join(a.integrationPath, 'docs', 'plans', a.planFile), text, 'utf8')
        await git(['add', '--', planRel], a.integrationPath)
        await git([...IDENTITY, 'commit', '--quiet', '-m', `docs(plan): ${a.planFile}`, '--', planRel], a.integrationPath)
      } catch {
        // The PR still works without the plan file.
      }
    }
  }

  const branch = prBranchName(a.planFile, a.runBranch)
  try {
    await git(['push', '--set-upstream', 'origin', `refs/heads/${a.runBranch}:refs/heads/${branch}`], a.projectPath, 120_000)
  } catch (e) {
    return { ok: false, error: 'push-failed', message: `git push failed: ${errText(e)}` }
  }

  const args =
    host === 'github'
      ? ['pr', 'create', '--base', a.baseBranch, '--head', branch, '--title', a.title, '--body', a.body]
      : ['mr', 'create', '--source-branch', branch, '--target-branch', a.baseBranch, '--title', a.title, '--description', a.body, '--yes']
  try {
    const out = await exec(cli, args, { cwd: a.projectPath, timeoutMs: 60_000 })
    const url = firstUrl(`${out.stdout}\n${out.stderr}`)
    if (url === null) return { ok: false, error: 'pr-failed', message: `${cli} did not return a pull request URL.` }
    return { ok: true, url, branch, host }
  } catch (e) {
    // A PR for this branch may already exist: gh/glab print its URL.
    const x = e as { stdout?: unknown; stderr?: unknown }
    const text = `${typeof x.stdout === 'string' ? x.stdout : ''}\n${typeof x.stderr === 'string' ? x.stderr : ''}`
    const url = /already exists/i.test(text) ? firstUrl(text) : null
    if (url !== null) return { ok: true, url, branch, host }
    return { ok: false, error: 'pr-failed', message: `${cli} could not open the pull request: ${errText(e)}` }
  }
}
