import { closeSync, constants, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import type { AppInfo } from '../shared/ipc'

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

/** Only these keys are taken from `.env`; anything else in the file is ignored (for example an API key would change billing). */
export const ENV_FILE_KEYS = ['CLAUDE_TOOLKIT_PATH'] as const

export type EnvFileResult = 'loaded' | 'missing' | 'failed'

export interface EnvFileDeps {
  readText?: (file: string) => string
}

const defaultReadText = (file: string): string => readFileSync(file, 'utf8')

/**
 * Copies the allowed keys from `<dir>/.env` into `env`. A variable that is already set (non-blank) wins over the file.
 * A missing file is normal. Never logs or throws with file contents.
 */
export function loadEnvFile(
  dir: string,
  env: Record<string, string | undefined> = process.env,
  deps: EnvFileDeps = {}
): EnvFileResult {
  const readText = deps.readText ?? defaultReadText
  let text: string
  try {
    text = readText(path.join(dir, '.env'))
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'failed'
  }
  let parsed: Record<string, string | undefined>
  try {
    parsed = parseEnv(text)
  } catch {
    return 'failed'
  }
  for (const key of ENV_FILE_KEYS) {
    const fromFile = parsed[key]
    if (fromFile !== undefined && !env[key]?.trim()) env[key] = fromFile
  }
  return 'loaded'
}

export const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_VERSION_LENGTH = 64

export interface ToolkitInfoDeps {
  isDirectory?: (p: string) => boolean
}

/**
 * Describes the toolkit folder for the App section. Never throws; the only value taken
 * from the manifest is a short version string. Reads at most MAX_MANIFEST_BYTES + 1 bytes.
 */
export function readToolkitInfo(
  env: Record<string, string | undefined> = process.env,
  deps: ToolkitInfoDeps = {}
): AppInfo['toolkit'] {
  const raw = env['CLAUDE_TOOLKIT_PATH']?.trim()
  if (!raw) return { status: 'unset', path: null, version: null }
  const resolved = path.resolve(raw)
  const invalid: AppInfo['toolkit'] = { status: 'invalid', path: resolved, version: null }
  try {
    if (!(deps.isDirectory ?? defaultIsDirectory)(resolved)) return invalid
    const manifestPath = path.join(resolved, '.claude-plugin', 'plugin.json')
    // Only a regular file is opened: opening a FIFO without a writer would block the main process.
    const st = statSync(manifestPath)
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return invalid
    const fd = openSync(manifestPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    let text: string
    try {
      const buf = Buffer.alloc(MAX_MANIFEST_BYTES + 1)
      let total = 0
      while (total < buf.length) {
        const n = readSync(fd, buf, total, buf.length - total, null)
        if (n === 0) break
        total += n
      }
      if (total > MAX_MANIFEST_BYTES) return invalid
      text = buf.subarray(0, total).toString('utf8')
    } finally {
      closeSync(fd)
    }
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return invalid
    const { name, version } = parsed as { name?: unknown; version?: unknown }
    if (typeof name !== 'string' || name.trim() === '') return invalid
    const safeVersion =
      typeof version === 'string' && version.length > 0 && version.length <= MAX_VERSION_LENGTH ? version : null
    return { status: 'valid', path: resolved, version: safeVersion }
  } catch {
    return invalid
  }
}

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
