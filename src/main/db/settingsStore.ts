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

/** Optional fields a caller may omit; the stored value is kept (closes the 4c review follow-up). */
const OPTIONAL_KEYS = ['checks', 'maxParallel', 'maxTurns', 'taskTimeoutMinutes', 'autoFixRounds', 'reviewers'] as const

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
      let next: ProjectSettings = parsed.data
      try {
        if (OPTIONAL_KEYS.some((k) => next[k] === undefined)) {
          // Callers that do not know a field (older Settings tabs) must not wipe what is stored.
          const row = selectStmt.get(projectId) as { settings: unknown } | undefined
          const stored =
            row !== undefined && typeof row.settings === 'string'
              ? parseSettingsOrDefaults(row.settings)
              : null
          const old = stored !== null && stored.case === 'ok' ? stored.settings : null
          const merged: Record<string, unknown> = { ...next }
          for (const k of OPTIONAL_KEYS) {
            if (next[k] === undefined) {
              if (old !== null && old[k] !== undefined) merged[k] = old[k]
              else if (k === 'checks') merged[k] = []
              else delete merged[k]
            }
          }
          next = merged as ProjectSettings
        }
        write(projectId, JSON.stringify(next), Math.round(now()))
      } catch {
        return { ok: false, error: 'storage-unavailable' }
      }
      return { ok: true, settings: next }
    }
  }
}
