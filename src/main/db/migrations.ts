import type Database from 'better-sqlite3'

/** Ordered, append-only list. `PRAGMA user_version` equals the number applied. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    day TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('success', 'error')),
    cost_usd REAL,
    duration_ms INTEGER,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL
  );
  CREATE INDEX idx_runs_project_started ON runs (project_id, started_at);
  CREATE INDEX idx_runs_day ON runs (day);
  CREATE TABLE usage_models (
    run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    cost_usd REAL NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL
  );
  CREATE INDEX idx_usage_models_run ON usage_models (run_id);
  CREATE TABLE usage_agents (
    run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    agent TEXT NOT NULL,
    steps INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL,
    approximate INTEGER NOT NULL CHECK (approximate IN (0, 1))
  );
  CREATE INDEX idx_usage_agents_run ON usage_agents (run_id);
  `,
  `
  CREATE TABLE project_settings (
    project_id TEXT PRIMARY KEY,
    settings TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `
]

export class DatabaseVersionError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number
  ) {
    super(`Database schema version ${found} is newer than supported version ${supported}`)
    this.name = 'DatabaseVersionError'
  }
}

/** Applies pending migrations, one transaction each. Returns the number applied. */
export function migrate(db: Database.Database, migrations: readonly string[] = MIGRATIONS): number {
  const current = Number(db.pragma('user_version', { simple: true }))
  if (current > migrations.length) throw new DatabaseVersionError(current, migrations.length)
  let applied = 0
  for (let v = current; v < migrations.length; v++) {
    const sql = migrations[v] as string
    db.transaction(() => {
      db.exec(sql)
      db.pragma(`user_version = ${v + 1}`)
    })()
    applied++
  }
  return applied
}
