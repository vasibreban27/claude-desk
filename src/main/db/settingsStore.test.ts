import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultSettings, type ProjectSettings } from '../../shared/settings'
import { migrate } from './migrations'
import { createSettingsStore } from './settingsStore'

const P = '11111111-1111-4111-8111-111111111111'

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
})

const custom = (): ProjectSettings => ({
  ...defaultSettings(),
  model: 'opus',
  protectedPaths: ['secrets/'],
  allowGitRead: true
})
const rawRow = (): string | undefined =>
  (db.prepare('SELECT settings FROM project_settings WHERE project_id = ?').get(P) as
    | { settings: string }
    | undefined)?.settings

describe('SettingsStore', () => {
  it('returns defaults with no notice when no row exists', () => {
    expect(createSettingsStore(db).get(P)).toEqual({ settings: defaultSettings(), notice: null })
  })

  it('round-trips and upserts', () => {
    const store = createSettingsStore(db)
    expect(store.set(P, custom())).toEqual({ ok: true, settings: custom() })
    expect(store.get(P)).toEqual({ settings: custom(), notice: null })
    store.set(P, defaultSettings())
    expect(store.get(P).settings).toEqual(defaultSettings())
    expect((db.prepare('SELECT COUNT(*) AS c FROM project_settings').get() as { c: number }).c).toBe(1)
  })

  it.each(['{not json', '{"version":2}', JSON.stringify({ ...custom(), model: 'gpt' })])(
    'falls back to defaults on bad stored data and leaves the row unchanged: %s',
    (bad) => {
      db.prepare('INSERT INTO project_settings VALUES (?, ?, 0)').run(P, bad)
      expect(createSettingsStore(db).get(P)).toEqual({
        settings: defaultSettings(),
        notice: 'defaults-applied'
      })
      expect(rawRow()).toBe(bad)
    }
  )

  it('rejects an invalid value without touching the row', () => {
    const store = createSettingsStore(db)
    store.set(P, custom())
    const before = rawRow()
    expect(store.set(P, { ...custom(), model: 'x' })).toEqual({ ok: false, error: 'invalid' })
    expect(rawRow()).toBe(before)
  })

  it('returns storage-unavailable instead of throwing on SQLite errors', () => {
    const store = createSettingsStore(db)
    db.exec('DROP TABLE project_settings')
    expect(store.set(P, custom())).toEqual({ ok: false, error: 'storage-unavailable' })
    expect(store.get(P)).toEqual({ settings: defaultSettings(), notice: 'storage-unavailable' })
  })

  describe('checks', () => {
    const check = { name: 'unit', executable: 'node', args: ['t.js'], timeoutMs: 5000 }

    it('preserves stored checks when the incoming object has none, clears on [], replaces on a list', () => {
      const store = createSettingsStore(db)
      store.set(P, { ...custom(), checks: [check] })
      const { checks: _omit, ...withoutChecks } = custom()
      void _omit
      const res = store.set(P, withoutChecks)
      expect(res).toMatchObject({ ok: true })
      expect(store.get(P).settings.checks).toEqual([check])
      store.set(P, { ...custom(), checks: [] })
      expect(store.get(P).settings.checks).toEqual([])
      store.set(P, { ...custom(), checks: [check] })
      const other = { ...check, name: 'other' }
      store.set(P, { ...custom(), checks: [other] })
      expect(store.get(P).settings.checks).toEqual([other])
    })

    it('stored v1 rows without checks stay valid', () => {
      const { checks: _omit, ...legacy } = custom()
      void _omit
      db.prepare('INSERT INTO project_settings VALUES (?, ?, 0)').run(P, JSON.stringify(legacy))
      expect(createSettingsStore(db).get(P)).toEqual({ settings: custom(), notice: null })
    })

    it('ignores package.json scripts in the project folder', () => {
      // the store has no project path input at all; checks only come from the database
      expect(createSettingsStore(db).get(P).settings.checks).toEqual([])
    })
  })

  it('keeps stored autoFixRounds, reviewers and the three limits when a caller omits them', () => {
    const store = createSettingsStore(db)
    store.set(P, {
      ...custom(),
      autoFixRounds: 4,
      reviewers: ['reviewer', 'security-auditor'],
      maxParallel: 3,
      maxTurns: 60,
      taskTimeoutMinutes: 30
    })
    const { autoFixRounds, reviewers, maxParallel, maxTurns, taskTimeoutMinutes, ...legacy } = custom()
    void [autoFixRounds, reviewers, maxParallel, maxTurns, taskTimeoutMinutes]
    const r = store.set(P, legacy)
    expect(r.ok).toBe(true)
    expect(store.get(P).settings).toMatchObject({
      autoFixRounds: 4,
      reviewers: ['reviewer', 'security-auditor'],
      maxParallel: 3,
      maxTurns: 60,
      taskTimeoutMinutes: 30
    })
    store.set(P, { ...legacy, autoFixRounds: 0, reviewers: [] })
    expect(store.get(P).settings).toMatchObject({ autoFixRounds: 0, reviewers: [], maxParallel: 3 })
  })

  it('without a database: defaults and storage-unavailable', () => {
    const store = createSettingsStore(null)
    expect(store.get(P)).toEqual({ settings: defaultSettings(), notice: 'storage-unavailable' })
    expect(store.set(P, custom())).toEqual({ ok: false, error: 'storage-unavailable' })
  })
})
