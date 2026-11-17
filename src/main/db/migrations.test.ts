import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS, migrate } from './migrations'

describe('migration 2: project_settings', () => {
  it('upgrades a version 1 database, keeps runs data, and is idempotent', () => {
    const db = new Database(':memory:')
    expect(migrate(db, MIGRATIONS.slice(0, 1))).toBe(1)
    db.prepare(
      `INSERT INTO runs (id, project_id, started_at, day, status, cost_usd, duration_ms,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
       VALUES ('r1', 'p', 1, '2026-01-01', 'success', 0.1, 5, 1, 2, 3, 4)`
    ).run()

    expect(migrate(db)).toBe(MIGRATIONS.length - 1)
    expect(db.pragma('user_version', { simple: true })).toBe(2)
    const cols = db.prepare('PRAGMA table_info(project_settings)').all() as { name: string }[]
    expect(cols.map((c) => c.name)).toEqual(['project_id', 'settings', 'updated_at'])
    expect((db.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number }).c).toBe(1)

    expect(migrate(db)).toBe(0)
    expect(db.pragma('user_version', { simple: true })).toBe(2)
  })
})
