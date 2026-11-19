/**
 * The app-run checks gate: runs every configured check in a task worktree with the same command resolution
 * and environment allowlist as the worker's `run_check` tool. It never throws; a check that cannot run,
 * times out or exits non-zero is a `failed` result with a short, capped output.
 */
import { execFile as nodeExecFile } from 'node:child_process'
import type { CheckConfig } from '../../shared/settings'
import { CHECK_OUTPUT_BUFFER, checkEnv, resolveCheckCommand, type ExecFn, type ResolveDeps } from './workerTools'

export const GATE_OUTPUT_CAP = 4000

export type ChecksGateResult =
  | { status: 'passed' }
  | { status: 'none' }
  | { status: 'failed'; check: string; output: string }

export interface ChecksGateArgs {
  worktree: string
  checks: readonly CheckConfig[]
  signal?: AbortSignal
}

export interface ChecksGateDeps extends ResolveDeps {
  exec?: ExecFn
}

const defaultExec: ExecFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, args, { ...options, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        Object.assign(err, { stdout, stderr })
        reject(err)
        return
      }
      resolve({ stdout, stderr })
    })
  })

interface ExecErr {
  code?: unknown
  name?: unknown
  killed?: boolean
  signal?: string | null
  stdout?: unknown
  stderr?: unknown
}

function tail(text: string, max: number): string {
  const t = text.trim()
  return t.length <= max ? t : `[truncated] ...${t.slice(t.length - max)}`
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : '')

export async function runChecksGate(args: ChecksGateArgs, deps: ChecksGateDeps = {}): Promise<ChecksGateResult> {
  if (args.checks.length === 0) return { status: 'none' }
  const exec = deps.exec ?? defaultExec
  const env = checkEnv(deps.env ?? process.env)
  for (const check of args.checks) {
    if (args.signal?.aborted) return { status: 'failed', check: check.name, output: 'cancelled' }
    try {
      const command = resolveCheckCommand(check, [], { platform: deps.platform, env: deps.env, fileExists: deps.fileExists, cwd: args.worktree })
      if ('error' in command) return { status: 'failed', check: check.name, output: tail(command.error, GATE_OUTPUT_CAP) }
      try {
        await exec(command.file, command.args, {
          cwd: args.worktree,
          env,
          timeout: check.timeoutMs,
          maxBuffer: CHECK_OUTPUT_BUFFER,
          signal: args.signal
        })
      } catch (e) {
        const err = (e ?? {}) as ExecErr
        if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return { status: 'failed', check: check.name, output: 'cancelled' }
        const out = `${asText(err.stdout)}\n${asText(err.stderr)}`.trim()
        let reason: string
        if (err.killed === true || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
          reason = `timed out after ${check.timeoutMs} ms`
        } else if (typeof err.code === 'number') {
          reason = `failed (exit code ${err.code})`
        } else if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reason = 'failed: output too large'
        } else {
          reason = `could not start (${typeof err.code === 'string' ? err.code : 'unknown error'})`
        }
        return { status: 'failed', check: check.name, output: tail(out ? `${reason}\n${out}` : reason, GATE_OUTPUT_CAP) }
      }
    } catch {
      return { status: 'failed', check: check.name, output: 'the check could not be run' }
    }
  }
  return { status: 'passed' }
}
