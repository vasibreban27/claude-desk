import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'

/**
 * In the installed app the SDK's Claude Code binary (from @anthropic-ai/claude-agent-sdk-<platform>-<arch>) is kept
 * outside app.asar, because a program cannot run from inside the archive. The SDK would look for it inside the
 * archive, so every session is pointed at the unpacked copy. In development nothing changes.
 */

export interface ExecutableDeps {
  resourcesPath?: string | undefined
  platform?: NodeJS.Platform
  arch?: string
  exists?: (p: string) => boolean
}

/** The unpacked Claude Code binary of a packaged app, or undefined (development, or not found). */
export function packagedClaudeExecutable(deps: ExecutableDeps = {}): string | undefined {
  const resources = deps.resourcesPath ?? (process as { resourcesPath?: string }).resourcesPath
  if (!resources) return undefined
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch
  const exe = path.join(
    resources,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    `claude-agent-sdk-${platform}-${arch}`,
    platform === 'win32' ? 'claude.exe' : 'claude'
  )
  return (deps.exists ?? existsSync)(exe) ? exe : undefined
}

let cached: { value: string | undefined } | null = null

/** Adds the packaged binary to the query options, unless the caller already chose one. */
export function withClaudeExecutable<T extends { options?: Options }>(params: T, deps?: ExecutableDeps): T {
  if (params.options?.pathToClaudeCodeExecutable) return params
  let exe: string | undefined
  if (deps) exe = packagedClaudeExecutable(deps)
  else {
    cached ??= { value: packagedClaudeExecutable() }
    exe = cached.value
  }
  if (exe === undefined) return params
  return { ...params, options: { ...params.options, pathToClaudeCodeExecutable: exe } }
}
