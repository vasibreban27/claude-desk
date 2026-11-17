import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROTECTED_PATHS,
  defaultSettings,
  needsSessionReset,
  parseSettingsOrDefaults,
  projectSettingsSchema
} from './settings'

const ok = (v: unknown): boolean => projectSettingsSchema.safeParse(v).success

describe('projectSettingsSchema', () => {
  const base = defaultSettings()

  it('accepts a valid object', () => {
    expect(ok(base)).toBe(true)
    expect(ok({ ...base, model: 'opus', protectedPaths: [], allowGitRead: true })).toBe(true)
  })

  it('rejects invalid values', () => {
    expect(ok({ ...base, version: 2 })).toBe(false)
    expect(ok({ ...base, model: 'gpt' })).toBe(false)
    expect(ok({ ...base, protectedPaths: ['a'.repeat(201)] })).toBe(false)
    expect(ok({ ...base, protectedPaths: ['a'.repeat(200)] })).toBe(true)
    expect(ok({ ...base, protectedPaths: ['a\0b'] })).toBe(false)
    expect(ok({ ...base, protectedPaths: [''] })).toBe(false)
    expect(ok({ ...base, protectedPaths: Array.from({ length: 101 }, () => 'x') })).toBe(false)
    expect(ok({ ...base, protectedPaths: Array.from({ length: 100 }, () => 'x') })).toBe(true)
    expect(ok({ ...base, allowGitRead: 'yes' })).toBe(false)
    expect(ok({ ...base, allowPlanWrites: 1 })).toBe(false)
  })
})

describe('parseSettingsOrDefaults', () => {
  it('returns defaults for undefined, non-JSON and schema failures with a flag', () => {
    const defaults = defaultSettings()
    expect(defaults.model).toBe('auto')
    expect(defaults.protectedPaths).toEqual([...DEFAULT_PROTECTED_PATHS])
    expect(defaults.allowGitRead).toBe(false)
    expect(defaults.allowPlanWrites).toBe(false)

    expect(parseSettingsOrDefaults(undefined)).toEqual({ settings: defaults, case: 'missing' })
    expect(parseSettingsOrDefaults('{nope')).toEqual({ settings: defaults, case: 'invalid-json' })
    expect(parseSettingsOrDefaults('{"version":2}')).toEqual({
      settings: defaults,
      case: 'invalid-schema'
    })
  })

  it('parses a valid stored value', () => {
    const stored = { ...defaultSettings(), model: 'haiku' as const, allowPlanWrites: true }
    expect(parseSettingsOrDefaults(JSON.stringify(stored))).toEqual({ settings: stored, case: 'ok' })
  })

  it('returns a fresh copy of the default list', () => {
    const a = parseSettingsOrDefaults(undefined).settings
    a.protectedPaths.push('x')
    expect(parseSettingsOrDefaults(undefined).settings.protectedPaths).toEqual([
      ...DEFAULT_PROTECTED_PATHS
    ])
  })
})

describe('needsSessionReset', () => {
  const base = defaultSettings()

  it('is false when only protectedPaths changed', () => {
    expect(needsSessionReset(base, { ...base, protectedPaths: ['x'] })).toBe(false)
  })

  it('is false when model, allowGitRead or allowPlanWrites changed', () => {
    expect(needsSessionReset(base, { ...base, model: 'opus' })).toBe(false)
    expect(needsSessionReset(base, { ...base, allowGitRead: true })).toBe(false)
    expect(needsSessionReset(base, { ...base, allowPlanWrites: true })).toBe(false)
  })

  it('would be true for those options with a non-empty table', () => {
    const table = ['model', 'allowGitRead', 'allowPlanWrites'] as const
    expect(needsSessionReset(base, { ...base, model: 'opus' }, table)).toBe(true)
    expect(needsSessionReset(base, { ...base, allowGitRead: true }, table)).toBe(true)
    expect(needsSessionReset(base, { ...base, allowPlanWrites: true }, table)).toBe(true)
  })

  it('honours a custom option table', () => {
    expect(needsSessionReset(base, { ...base, model: 'opus' }, ['allowGitRead'])).toBe(false)
  })
})
