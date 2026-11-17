import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, loadEnvFile, MAX_MANIFEST_BYTES, readToolkitInfo } from './config'

describe('loadEnvFile', () => {
  const reading = (text: string) => ({ readText: () => text })

  it('copies CLAUDE_TOOLKIT_PATH from the file into an empty env', () => {
    const env: Record<string, string | undefined> = {}
    expect(loadEnvFile('/proj', env, reading('# comment\nCLAUDE_TOOLKIT_PATH=/some/plugin\n'))).toBe('loaded')
    expect(env['CLAUDE_TOOLKIT_PATH']).toBe('/some/plugin')
  })

  it('handles quoted values and CRLF line endings', () => {
    const env: Record<string, string | undefined> = {}
    loadEnvFile('/proj', env, reading('CLAUDE_TOOLKIT_PATH="C:\\\\tools\\\\flow"\r\n'))
    expect(env['CLAUDE_TOOLKIT_PATH']).toBeDefined()
    expect(env['CLAUDE_TOOLKIT_PATH']).not.toContain('"')
  })

  it('does not override a variable that is already set', () => {
    const env: Record<string, string | undefined> = { CLAUDE_TOOLKIT_PATH: '/from/shell' }
    loadEnvFile('/proj', env, reading('CLAUDE_TOOLKIT_PATH=/from/file'))
    expect(env['CLAUDE_TOOLKIT_PATH']).toBe('/from/shell')
  })

  it('treats a blank existing variable as unset', () => {
    const env: Record<string, string | undefined> = { CLAUDE_TOOLKIT_PATH: '  ' }
    loadEnvFile('/proj', env, reading('CLAUDE_TOOLKIT_PATH=/from/file'))
    expect(env['CLAUDE_TOOLKIT_PATH']).toBe('/from/file')
  })

  it('ignores keys that are not allowed, such as an API key', () => {
    const env: Record<string, string | undefined> = {}
    loadEnvFile('/proj', env, reading('ANTHROPIC_API_KEY=sk-ant-x\nNODE_OPTIONS=--inspect\nCLAUDE_TOOLKIT_PATH=/p'))
    expect(env).toEqual({ CLAUDE_TOOLKIT_PATH: '/p' })
  })

  it('returns missing when the file does not exist', () => {
    const env: Record<string, string | undefined> = {}
    const readText = (): string => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' })
    }
    expect(loadEnvFile('/proj', env, { readText })).toBe('missing')
    expect(env).toEqual({})
  })

  it('returns failed on other read errors without leaking the message', () => {
    const env: Record<string, string | undefined> = {}
    const readText = (): string => {
      throw Object.assign(new Error('secret detail'), { code: 'EACCES' })
    }
    expect(loadEnvFile('/proj', env, { readText })).toBe('failed')
    expect(env).toEqual({})
  })

  describe('with a real file', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'claude-desk-env-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    })

    it('reads <dir>/.env from disk', () => {
      writeFileSync(path.join(dir, '.env'), 'CLAUDE_TOOLKIT_PATH=/real/plugin\n')
      const env: Record<string, string | undefined> = {}
      expect(loadEnvFile(dir, env)).toBe('loaded')
      expect(env['CLAUDE_TOOLKIT_PATH']).toBe('/real/plugin')
    })

    it('returns missing when the folder has no .env', () => {
      expect(loadEnvFile(dir, {})).toBe('missing')
    })
  })
})

describe('loadConfig', () => {
  it('errors when unset', () => {
    const r = loadConfig({}, { isDirectory: () => true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('toolkit-path-unset')
  })

  it('errors when the path does not exist, without leaking the value', () => {
    const secret = path.resolve('/very/secret/place')
    const r = loadConfig({ CLAUDE_TOOLKIT_PATH: secret }, { isDirectory: () => false })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('toolkit-path-missing')
      expect(r.error.message).not.toContain('secret')
    }
  })

  it('returns the resolved path when valid', () => {
    const p = path.resolve('/tmp/toolkit')
    const r = loadConfig({ CLAUDE_TOOLKIT_PATH: p }, { isDirectory: () => true })
    expect(r).toEqual({ ok: true, config: { toolkitPath: p } })
  })
})

describe('readToolkitInfo', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'toolkit-info-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  const manifest = (content: string): void => {
    mkdirSync(path.join(dir, '.claude-plugin'))
    writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), content)
  }
  const env = (): Record<string, string | undefined> => ({ CLAUDE_TOOLKIT_PATH: dir })

  it('is unset when the variable is unset or blank', () => {
    expect(readToolkitInfo({})).toEqual({ status: 'unset', path: null, version: null })
    expect(readToolkitInfo({ CLAUDE_TOOLKIT_PATH: '  ' }).status).toBe('unset')
  })

  it('is invalid for a missing folder', () => {
    const missing = path.join(dir, 'nope')
    expect(readToolkitInfo({ CLAUDE_TOOLKIT_PATH: missing })).toEqual({
      status: 'invalid',
      path: path.resolve(missing),
      version: null
    })
  })

  it('is invalid when plugin.json is missing', () => {
    expect(readToolkitInfo(env()).status).toBe('invalid')
  })

  it('is invalid for oversized, unparsable or nameless manifests', () => {
    manifest(JSON.stringify({ name: 'flow', pad: 'x'.repeat(MAX_MANIFEST_BYTES) }))
    expect(readToolkitInfo(env()).status).toBe('invalid')
    writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{not json')
    expect(readToolkitInfo(env()).status).toBe('invalid')
    writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{"version":"1.0.0"}')
    expect(readToolkitInfo(env()).status).toBe('invalid')
    writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '[1]')
    expect(readToolkitInfo(env()).status).toBe('invalid')
  })

  it('is invalid when plugin.json is a directory', () => {
    mkdirSync(path.join(dir, '.claude-plugin', 'plugin.json'), { recursive: true })
    expect(readToolkitInfo(env()).status).toBe('invalid')
  })

  it.runIf(process.platform !== 'win32')('is invalid, without blocking, when plugin.json is a FIFO', () => {
    mkdirSync(path.join(dir, '.claude-plugin'))
    execFileSync('mkfifo', [path.join(dir, '.claude-plugin', 'plugin.json')])
    expect(readToolkitInfo(env()).status).toBe('invalid')
  })

  it('follows a symlink to a regular manifest', (ctx) => {
    mkdirSync(path.join(dir, '.claude-plugin'))
    const target = path.join(dir, 'real.json')
    writeFileSync(target, '{"name":"flow","version":"2.0.0"}')
    try {
      symlinkSync(target, path.join(dir, '.claude-plugin', 'plugin.json'))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return ctx.skip()
      throw err
    }
    expect(readToolkitInfo(env())).toMatchObject({ status: 'valid', version: '2.0.0' })
  })

  it('is valid with the version, or null when the version is missing or too long', () => {
    manifest('{"name":"flow","version":"1.2.3","secret":"s"}')
    expect(readToolkitInfo(env())).toEqual({ status: 'valid', path: path.resolve(dir), version: '1.2.3' })
    writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{"name":"flow"}')
    expect(readToolkitInfo(env()).version).toBeNull()
    writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'flow', version: 'v'.repeat(65) }))
    expect(readToolkitInfo(env())).toMatchObject({ status: 'valid', version: null })
  })
})
