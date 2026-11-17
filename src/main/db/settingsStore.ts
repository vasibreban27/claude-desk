import type Database from 'better-sqlite3'
import {
  parseSettingsOrDefaults,
  projectSettingsSchema,
  defaultSettings,
  type ProjectSettings
} from '../../shared/settings'

export type SettingsNotice = null | 'defaults-applied' | 'storage-unavailable'

export interface SettingsGetResult {
  settings: ProjectSettings
  notice: SettingsNotice
}

export type SettingsSetResult =
  | { ok: true; settings: ProjectSettings }
  | { ok: false; error: 'invalid' | 'storage-unavailable' }

export interface SettingsStore {
  /** Never throws and never loosens: any failure yields the defaults plus a notice. */
  get(projectId: string): SettingsGetResult
  /** Never throws; an invalid value leaves the stored row untouched. */
  set(projectId: string, settings: unknown): SettingsSetResult
}

/** `db` is null when opening the database failed. */
export function createSettingsStore(
  db: Database.Database | null,
  now: () => number = Date.now
): SettingsStore {
  if (db === null) {
    return {
      get: () => ({ settings: defaultSettings(), notice: 'storage-unavailable' }),
      set: () => ({ ok: false, error: 'storage-unavailable' })
    }
  }
  const selectStmt = db.prepare('SELECT settings FROM project_settings WHERE project_id = ?')
  const upsertStmt = db.prepare(
    `INSERT INTO project_settings (project_id, settings, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (project_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`
  )
  const write = db.transaction((projectId: string, json: string, at: number) => {
    upsertStmt.run(projectId, json, at)
  })

  return {
    get(projectId) {
      let row: { settings: unknown } | undefined
      try {
        row = selectStmt.get(projectId) as { settings: unknown } | undefined
      } catch {
        return { settings: defaultSettings(), notice: 'storage-unavailable' }
      }
      if (row === undefined) return { settings: defaultSettings(), notice: null }
      const raw = typeof row.settings === 'string' ? row.settings : '\0invalid'
      const parsed = parseSettingsOrDefaults(raw)
      return {
        settings: parsed.settings,
        notice: parsed.case === 'ok' ? null : 'defaults-applied'
      }
    },
    set(projectId, settings) {
      const parsed = projectSettingsSchema.safeParse(settings)
      if (!parsed.success) return { ok: false, error: 'invalid' }
      try {
        write(projectId, JSON.stringify(parsed.data), Math.round(now()))
      } catch {
        return { ok: false, error: 'storage-unavailable' }
      }
      return { ok: true, settings: parsed.data }
    }
  }
}
