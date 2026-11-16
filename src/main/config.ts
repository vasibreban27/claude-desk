import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

export type ConfigErrorCode = 'toolkit-path-unset' | 'toolkit-path-missing'

export class ConfigError extends Error {
  readonly code: ConfigErrorCode
  constructor(code: ConfigErrorCode, message: string) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
  }
}

export interface Config {
  toolkitPath: string
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; error: ConfigError }

export interface ConfigDeps {
  isDirectory?: (p: string) => boolean
}

const defaultIsDirectory = (p: string): boolean => existsSync(p) && statSync(p).isDirectory()

/** Reads CLAUDE_TOOLKIT_PATH. Error messages never include the env value. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  deps: ConfigDeps = {}
): ConfigResult {
  const isDirectory = deps.isDirectory ?? defaultIsDirectory
  const raw = env['CLAUDE_TOOLKIT_PATH']?.trim()
  if (!raw) {
    return {
      ok: false,
      error: new ConfigError(
        'toolkit-path-unset',
        'CLAUDE_TOOLKIT_PATH is not set. Point it at your claude-toolkit clone.'
      )
    }
  }
  const resolved = path.resolve(raw)
  if (!isDirectory(resolved)) {
    return {
      ok: false,
      error: new ConfigError(
        'toolkit-path-missing',
        'CLAUDE_TOOLKIT_PATH does not point to an existing folder.'
      )
    }
  }
  return { ok: true, config: { toolkitPath: resolved } }
}
