import { describe, expect, it } from 'vitest'
import * as ipc from './ipc'
import {
  DEFAULT_PROTECTED_PATHS,
  defaultSettings,
  effectiveLimits,
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

describe('checks', () => {
  const base = defaultSettings()
  const c = { name: 'unit', executable: 'node', args: ['a'], timeoutMs: 1000 }
  const withChecks = (checks: unknown): boolean => ok({ ...base, checks })

  it('defaults to [] and parses when absent', () => {
    expect(base.checks).toEqual([])
    const { checks: _omit, ...legacy } = base
    void _omit
    expect(ok(legacy)).toBe(true)
    expect(parseSettingsOrDefaults(JSON.stringify(legacy))).toMatchObject({ case: 'ok' })
    expect(parseSettingsOrDefaults(JSON.stringify(legacy)).settings.checks).toEqual([])
  })

  it('accepts valid and rejects each violation', () => {
    expect(withChecks([c, { ...c, name: 'b', acceptsTestPath: true, timeoutMs: 600000 }])).toBe(true)
    expect(withChecks([{ ...c, name: 'Bad' }])).toBe(false)
    expect(withChecks([{ ...c, name: 'a'.repeat(33) }])).toBe(false)
    expect(withChecks([c, c])).toBe(false)
    expect(withChecks([{ ...c, executable: '' }])).toBe(false)
    expect(withChecks([{ ...c, executable: 'a'.repeat(261) }])).toBe(false)
    expect(withChecks([{ ...c, executable: 'a\0' }])).toBe(false)
    expect(withChecks([{ ...c, args: Array.from({ length: 17 }, () => 'x') }])).toBe(false)
    expect(withChecks([{ ...c, args: [''] }])).toBe(false)
    expect(withChecks([{ ...c, args: ['a'.repeat(501)] }])).toBe(false)
    expect(withChecks([{ ...c, args: ['a\0'] }])).toBe(false)
    expect(withChecks([{ ...c, timeoutMs: 999 }])).toBe(false)
    expect(withChecks([{ ...c, timeoutMs: 600001 }])).toBe(false)
    expect(withChecks(Array.from({ length: 9 }, (_, i) => ({ ...c, name: `n${i}` })))).toBe(false)
    expect(withChecks(Array.from({ length: 8 }, (_, i) => ({ ...c, name: `n${i}` })))).toBe(true)
  })
})

describe('limits', () => {
  const base = defaultSettings()
  const bad = [0, 4.5, '2', NaN, Infinity, 1000]

  it('accepts values in range and rejects the rest', () => {
    for (const v of [1, 2, 4]) expect(ok({ ...base, maxParallel: v })).toBe(true)
    for (const v of [...bad, 5]) expect(ok({ ...base, maxParallel: v })).toBe(false)
    for (const v of [5, 40, 100]) expect(ok({ ...base, maxTurns: v })).toBe(true)
    for (const v of [...bad.filter((x) => x !== 1000), 4, 101]) {
      expect(ok({ ...base, maxTurns: v })).toBe(false)
    }
    for (const v of [1, 20, 120]) expect(ok({ ...base, taskTimeoutMinutes: v })).toBe(true)
    for (const v of [...bad.filter((x) => x !== 1000), 121, 1000]) {
      expect(ok({ ...base, taskTimeoutMinutes: v })).toBe(false)
    }
  })

  it('fills defaults for stored settings without the fields', () => {
    const { maxParallel: _a, maxTurns: _b, taskTimeoutMinutes: _c, ...legacy } = base
    void [_a, _b, _c]
    const r = parseSettingsOrDefaults(JSON.stringify(legacy))
    expect(r.case).toBe('ok')
    expect(r.settings).toMatchObject({ maxParallel: 2, maxTurns: 40, taskTimeoutMinutes: 20 })
    expect(base).toMatchObject({ maxParallel: 2, maxTurns: 40, taskTimeoutMinutes: 20 })
  })

  it('effectiveLimits applies the defaults', () => {
    expect(effectiveLimits({})).toEqual({ maxParallel: 2, maxTurns: 40, timeCapMs: 1200000 })
    expect(
      effectiveLimits({ maxParallel: 3, maxTurns: 10, taskTimeoutMinutes: 5, })
    ).toEqual({ maxParallel: 3, maxTurns: 10, timeCapMs: 300000 })
    expect(effectiveLimits({ maxParallel: undefined })).toMatchObject({ maxParallel: 2 })
  })

  it('exports the constants through @shared/ipc', () => {
    expect(ipc.MAX_PARALLEL_LIMIT).toBe(4)
    expect(ipc.DEFAULT_MAX_PARALLEL).toBe(2)
    expect(ipc.MAX_TURNS_RANGE.max).toBe(100)
    expect(ipc.TIME_LIMIT_MINUTES_RANGE.max).toBe(120)
  })

  it('rejects 1000 workers in a settings:set payload', () => {
    const r = ipc.settingsSetRequestSchema.safeParse({
      projectId: crypto.randomUUID(),
      settings: { ...base, maxParallel: 1000 }
    })
    expect(r.success).toBe(false)
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

describe('review settings', () => {
  const base = defaultSettings()
  const parse = (patch: Record<string, unknown>) =>
    projectSettingsSchema.safeParse({ ...base, ...patch }).success

  it.each([0, 1, 5])('accepts autoFixRounds %s', (n) => {
    expect(parse({ autoFixRounds: n })).toBe(true)
  })
  it.each([-1, 6, 1.5, '2', NaN, 1000])('rejects autoFixRounds %s', (n) => {
    expect(parse({ autoFixRounds: n })).toBe(false)
  })
  it.each([[[]], [['reviewer']], [['security-auditor']], [['reviewer', 'security-auditor']]])(
    'accepts reviewers %j',
    (list) => {
      expect(parse({ reviewers: list })).toBe(true)
    }
  )
  it.each([
    [['other']],
    [['reviewer', 'reviewer']],
    [['reviewer', 'security-auditor', 'reviewer']]
  ])('rejects reviewers %j', (list) => {
    expect(parse({ reviewers: list })).toBe(false)
  })

  it('applies defaults when the fields are absent', () => {
    const legacy: Record<string, unknown> = { ...base }
    delete legacy.autoFixRounds
    delete legacy.reviewers
    const result = parseSettingsOrDefaults(JSON.stringify(legacy))
    expect(result.case).toBe('ok')
    expect(result.settings.autoFixRounds).toBe(2)
    expect(result.settings.reviewers).toEqual(['reviewer'])
    expect(defaultSettings().autoFixRounds).toBe(2)
    expect(defaultSettings().reviewers).toEqual(['reviewer'])
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
