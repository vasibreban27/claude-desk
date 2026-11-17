import { useCallback, useEffect, useState } from 'react'
import type { AppInfo, ProjectSettings, SettingsNotice, SettingsSetError } from '@shared/ipc'

export type SaveError = SettingsSetError | 'unavailable'

export interface UseSettings {
  settings: ProjectSettings | null
  notice: SettingsNotice | null
  loading: boolean
  loadError: string | null
  saving: boolean
  saveError: SaveError | null
  saveOk: boolean
  sessionReset: boolean
  /** Bumps whenever loaded or saved values replace the form's starting values. */
  revision: number
  save: (settings: ProjectSettings) => Promise<void>
  appInfo: AppInfo | null
  appInfoError: boolean
}

interface Loaded {
  owner: string
  settings: ProjectSettings
  notice: SettingsNotice | null
  revision: number
}

interface SaveState {
  owner: string
  error: SaveError | null
  sessionReset: boolean
}

/** Loads and saves one project's settings. Data from another project is never returned. */
export function useSettings(projectId: string | null): UseSettings {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failure, setFailure] = useState<{ owner: string; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<SaveState | null>(null)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [appInfoError, setAppInfoError] = useState(false)

  const owner = projectId ?? ''
  const current = projectId !== null && loaded?.owner === owner ? loaded : null
  const loadError = projectId !== null && failure?.owner === owner ? failure.message : null
  const loading = projectId !== null && current === null && loadError === null
  const outcome = saveState?.owner === owner ? saveState : null

  useEffect(() => {
    if (projectId === null) return
    let cancelled = false
    const api = window.api
    const request = api ? api.settingsGet({ projectId }) : Promise.reject(new Error('no bridge'))
    request
      .then((res) => {
        if (cancelled) return
        if (res.ok) {
          setLoaded((prev) => ({
            owner: projectId,
            settings: res.settings,
            notice: res.notice,
            revision: (prev?.revision ?? 0) + 1
          }))
          setFailure(null)
        } else {
          setFailure({ owner: projectId, message: 'This project was not found.' })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailure({
            owner: projectId,
            message: api ? 'Could not load settings.' : 'The desktop bridge is unavailable.'
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    const api = window.api
    const request = api ? api.appInfo() : Promise.reject(new Error('no bridge'))
    request
      .then((info) => {
        if (!cancelled) setAppInfo(info)
      })
      .catch(() => {
        if (!cancelled) setAppInfoError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(
    async (settings: ProjectSettings) => {
      if (projectId === null || saving) return
      const api = window.api
      setSaving(true)
      setSaveState(null)
      try {
        if (!api) throw new Error('no bridge')
        const res = await api.settingsSet({ projectId, settings })
        if (res.ok) {
          setLoaded((prev) => ({
            owner: projectId,
            settings: res.settings,
            notice: null,
            revision: (prev?.revision ?? 0) + 1
          }))
          setSaveState({ owner: projectId, error: null, sessionReset: res.sessionReset })
        } else {
          setSaveState({ owner: projectId, error: res.error, sessionReset: false })
        }
      } catch {
        setSaveState({ owner: projectId, error: 'unavailable', sessionReset: false })
      } finally {
        setSaving(false)
      }
    },
    [projectId, saving]
  )

  return {
    settings: current?.settings ?? null,
    notice: current?.notice ?? null,
    loading,
    loadError,
    saving,
    saveError: outcome?.error ?? null,
    saveOk: outcome !== null && outcome.error === null,
    sessionReset: outcome?.sessionReset ?? false,
    revision: current?.revision ?? 0,
    save,
    appInfo,
    appInfoError
  }
}
