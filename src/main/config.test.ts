import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { loadConfig } from './config'

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
