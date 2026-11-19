import { useCallback, useEffect, useState } from 'react'
import type { PickAndAddError, Project } from '@shared/ipc'

export const ADD_ERROR_MESSAGES: Record<Exclude<PickAndAddError, 'cancelled'>, string> = {
  'not-a-git-repo': 'That folder is not a git repository.',
  duplicate: 'That project has already been added.',
  unreadable: 'That folder could not be read.'
}

export const BRIDGE_UNAVAILABLE = 'The desktop bridge is unavailable.'

const RESTART_NEEDED = 'The app is running older background code than its window: restart claude-desk and try again.'
const REMOVE_ERRORS: Record<string, string> = {
  'not-found': 'The project is no longer registered: restart claude-desk to refresh the list.',
  busy: 'A pipeline run is active: cancel it first.',
  unreadable: 'Could not remove the project: the project list could not be saved.',
  'trash-failed': 'Could not move the folder to the Recycle Bin.',
  'unsafe-path': 'This folder cannot be deleted from the app.'
}

export interface UseProjects {
  projects: Project[]
  selectedId: string | null
  loading: boolean
  loadError: string | null
  addError: string | null
  adding: boolean
  add: () => Promise<void>
  select: (id: string) => Promise<void>
  /** Adds a project created in the app (New project) to the list and selects it. */
  adopt: (project: Project) => void
  /** Unregisters a project; with deleteFolder also moves its folder to the Recycle Bin. Resolves an error text or null. */
  remove: (id: string, deleteFolder: boolean) => Promise<string | null>
}

export function useProjects(): UseProjects {
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    let cancelled = false
    const api = window.api
    const request = api ? api.listProjects() : Promise.reject(new Error('no bridge'))
    request
      .then((list) => {
        if (!cancelled) setProjects(list)
      })
      .catch(() => {
        if (!cancelled) setLoadError(api ? 'Could not load projects.' : BRIDGE_UNAVAILABLE)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const add = useCallback(async () => {
    const api = window.api
    if (!api) {
      setAddError(BRIDGE_UNAVAILABLE)
      return
    }
    setAdding(true)
    setAddError(null)
    try {
      const result = await api.pickAndAddProject()
      if (result.ok) {
        setProjects((prev) => [...prev.filter((p) => p.id !== result.project.id), result.project])
        setSelectedId(result.project.id)
      } else if (result.error !== 'cancelled') {
        setAddError(ADD_ERROR_MESSAGES[result.error])
      }
    } catch {
      setAddError('Could not add the project.')
    } finally {
      setAdding(false)
    }
  }, [])

  const select = useCallback(async (id: string) => {
    setSelectedId(id)
    const api = window.api
    if (!api) return
    try {
      const result = await api.refreshProject({ id })
      if (result.ok) {
        setProjects((prev) => prev.map((p) => (p.id === id ? result.project : p)))
      }
    } catch {
      // keep the last known status
    }
  }, [])

  const adopt = useCallback((project: Project) => {
    setProjects((prev) => [...prev.filter((p) => p.id !== project.id), project])
    setSelectedId(project.id)
  }, [])

  const remove = useCallback(async (id: string, deleteFolder: boolean): Promise<string | null> => {
    const api = window.api
    if (!api) return BRIDGE_UNAVAILABLE
    try {
      if (typeof api.removeProject !== 'function') return RESTART_NEEDED
      const r = await api.removeProject({ id, deleteFolder })
      if (!r.ok) {
        if (r.message) return r.message
        return REMOVE_ERRORS[r.error] ?? 'Could not remove the project.'
      }
      setProjects((prev) => prev.filter((p) => p.id !== id))
      setSelectedId((s) => (s === id ? null : s))
      return null
    } catch (e) {
      // An older main process has no handler for a channel the renderer already knows (dev without restart).
      if (e instanceof Error && /no handler registered/i.test(e.message)) return RESTART_NEEDED
      return `Could not remove the project${e instanceof Error && e.message ? `: ${e.message.slice(0, 200)}` : '.'}`
    }
  }, [])

  return { projects, selectedId, loading, loadError, addError, adding, add, select, adopt, remove }
}
