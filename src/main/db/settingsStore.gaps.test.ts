import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultSettings, type ProjectSettings } from '../../shared/settings'
import { migrate } from './migrations'
import { createSettingsStore } from './settingsStore'

const P = '11111111-1111-4111-8111-111111111111'
const Q = '22222222-2222-4222-8222-222222222222'

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
})

const custom = (): ProjectSettings => ({
  ...defaultSettings(),
  model: 'sonnet',
  protectedPaths: ['a/', '!a/keep'],
  allowPlanWrites: true
})
const rawRow = (id = P): unknown =>
  (db.prepare('SELECT settings FROM project_settings WHERE project_id = ?').get(id) as
    | { settings: unknown }
    | undefined)?.settings
const defaultsApplied = { settings: defaultSettings(), notice: 'defaults-applied' }

describe('SettingsStore gaps: closed database', () => {
  it('get and set do not throw after the database is closed', () => {
    const store = createSettingsStore(db)
    db.close()
    expect(store.get(P)).toEqual({ settings: defaultSettings(), notice: 'storage-unavailable' })
    expect(store.set(P, custom())).toEqual({ ok: false, error: 'storage-unavailable' })
  })

  it('an invalid value is still reported as invalid (not storage) on a closed database', () => {
    const store = createSettingsStore(db)
    db.close()
    expect(store.set(P, { nope: true })).toEqual({ ok: false, error: 'invalid' })
  })

  it('a failing clock yields storage-unavailable and leaves the previous row', () => {
    const good = createSettingsStore(db)
    good.set(P, custom())
    const before = rawRow()
    const bad = createSettingsStore(db, () => {
      throw new Error('clock')
    })
    expect(() => bad.set(P, defaultSettings())).not.toThrow()
    expect(rawRow()).toBe(before)
  })
})

describe('SettingsStore gaps: corrupt stored rows', () => {
  const tooMany = JSON.stringify({ ...defaultSettings(), protectedPaths: Array(101).fill('x') })
  const tooLong = JSON.stringify({ ...defaultSettings(), protectedPaths: ['x'.repeat(201)] })
  const nulPath = JSON.stringify({ ...defaultSettings(), protectedPaths: ['a\0b'] })
  const emptyPath = JSON.stringify({ ...defaultSettings(), protectedPaths: [''] })
  const strVersion = JSON.stringify({ ...defaultSettings(), version: '1' })
  const strBool = JSON.stringify({ ...defaultSettings(), allowGitRead: 'true' })
  const missingField: Partial<ProjectSettings> = defaultSettings()
  delete missingField.allowPlanWrites

  it.each([
    ['empty string', ''],
    ['whitespace', '   '],
    ['json null', 'null'],
    ['json array', '[]'],
    ['json string', '"x"'],
    ['json number', '42'],
    ['truncated json', JSON.stringify(custom()).slice(0, 20)],
    ['too many patterns', tooMany],
    ['too-long pattern', tooLong],
    ['NUL in pattern', nulPath],
    ['empty pattern', emptyPath],
    ['string version', strVersion],
    ['string boolean', strBool],
    ['missing field', JSON.stringify(missingField)]
  ])('falls back to defaults for %s and keeps the row', (_n, bad) => {
    db.prepare('INSERT INTO project_settings VALUES (?, ?, 0)').run(P, bad)
    expect(createSettingsStore(db).get(P)).toEqual(defaultsApplied)
    expect(rawRow()).toBe(bad)
  })

  it('treats a BLOB value as corrupt', () => {
    db.prepare('INSERT INTO project_settings VALUES (?, ?, 0)').run(P, Buffer.from(JSON.stringify(custom())))
    expect(createSettingsStore(db).get(P)).toEqual(defaultsApplied)
  })

  it('a corrupt row for one project does not affect another', () => {
    const store = createSettingsStore(db)
    store.set(Q, custom())
    db.prepare('INSERT INTO project_settings VALUES (?, ?, 0)').run(P, '{bad')
    expect(store.get(P)).toEqual(defaultsApplied)
    expect(store.get(Q)).toEqual({ settings: custom(), notice: null })
  })

  it('a valid save repairs a corrupt row', () => {
    db.prepare('INSERT INTO project_settings VALUES (?, ?, 0)').run(P, '{bad')
    const store = createSettingsStore(db)
    expect(store.set(P, custom()).ok).toBe(true)
    expect(store.get(P)).toEqual({ settings: custom(), notice: null })
  })
})

describe('SettingsStore gaps: set input', () => {
  it.each([[null], [undefined], ['str'], [5], [[]], [{}]])('rejects non-settings input %j', (input) => {
    const store = createSettingsStore(db)
    expect(store.set(P, input)).toEqual({ ok: false, error: 'invalid' })
    expect(rawRow()).toBeUndefined()
  })

  it('strips unknown keys instead of persisting them', () => {
    const store = createSettingsStore(db)
    const res = store.set(P, { ...custom(), extra: 'x', __proto__: { polluted: 1 } })
    expect(res).toEqual({ ok: true, settings: custom() })
    expect(JSON.parse(rawRow() as string)).toEqual(custom())
    expect(rawRow()).not.toContain('extra')
  })

  it('boundary lengths: 100 patterns of 200 chars are accepted, 101 are rejected', () => {
    const store = createSettingsStore(db)
    const ok = { ...defaultSettings(), protectedPaths: Array(100).fill('x'.repeat(200)) }
    expect(store.set(P, ok).ok).toBe(true)
    const before = rawRow()
    expect(store.set(P, { ...ok, protectedPaths: Array(101).fill('x') })).toEqual({ ok: false, error: 'invalid' })
    expect(rawRow()).toBe(before)
  })

  it('stores unusual project ids as opaque keys, isolated from each other', () => {
    const store = createSettingsStore(db)
    store.set("a'; DROP TABLE project_settings; --", custom())
    store.set('', defaultSettings())
    expect(store.get("a'; DROP TABLE project_settings; --").settings).toEqual(custom())
    expect(store.get('').settings).toEqual(defaultSettings())
    expect(store.get('other')).toEqual({ settings: defaultSettings(), notice: null })
  })

  it('records the clock value, rounded, as updated_at', () => {
    createSettingsStore(db, () => 1234.6).set(P, custom())
    const row = db.prepare('SELECT updated_at FROM project_settings').get() as { updated_at: number }
    expect(row.updated_at).toBe(1235)
  })

  it('concurrent sets: the last one wins and exactly one row remains', async () => {
    const store = createSettingsStore(db)
    const a = { ...custom(), model: 'haiku' as const }
    const b = { ...custom(), model: 'opus' as const }
    const results = await Promise.all([
      Promise.resolve().then(() => store.set(P, a)),
      Promise.resolve().then(() => store.set(P, b)),
      Promise.resolve().then(() => store.set(P, a))
    ])
    expect(results.every((r) => r.ok)).toBe(true)
    expect(store.get(P).settings).toEqual(a)
    expect((db.prepare('SELECT COUNT(*) AS c FROM project_settings').get() as { c: number }).c).toBe(1)
  })

  it('two stores on the same database see each other writes', () => {
    const s1 = createSettingsStore(db)
    const s2 = createSettingsStore(db)
    s1.set(P, custom())
    expect(s2.get(P).settings).toEqual(custom())
  })
})
