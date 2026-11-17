import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

describe('better-sqlite3 under Node', () => {
  it('opens an in-memory database', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    db.prepare('INSERT INTO t (v) VALUES (?)').run('x')
    expect(db.prepare('SELECT v FROM t').get()).toEqual({ v: 'x' })
    db.close()
  })
})
