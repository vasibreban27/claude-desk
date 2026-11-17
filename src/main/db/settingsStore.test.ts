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

  it('without a database: defaults and storage-unavailable', () => {
    const store = createSettingsStore(null)
    expect(store.get(P)).toEqual({ settings: defaultSettings(), notice: 'storage-unavailable' })
    expect(store.set(P, custom())).toEqual({ ok: false, error: 'storage-unavailable' })
  })
})
