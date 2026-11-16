import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { migrate } from './migrations'

/** Opens (creating if needed) the database, enables WAL and applies migrations. */
export function openDatabase(file: string): Database.Database {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    migrate(db)
    return db
  } catch (err) {
    db.close()
    throw err
  }
}
