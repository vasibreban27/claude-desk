import { useCallback, useState } from 'react'
import type { Project } from '@shared/ipc'
import { BRIDGE_UNAVAILABLE } from './useProjects'
import { numbered, projectNameFrom } from './projectName'

const MAX_ATTEMPTS = 9

const ERRORS: Record<string, string> = {
  'invalid-name': 'Could not name the project from that message. Try describing the app in a few words.',
  exists: 'Folders for that name already exist. Describe the app with different words.',
  escape: 'The folder would be outside the projects folder.',
  'git-failed': 'Could not initialise git.',
  'register-failed': 'Could not register the project.'
}

export interface UseStartProject {
  starting: boolean
  error: string | null
  /** Creates a project named from the message; resolves the project or null (the error is set). */
  start: (text: string) => Promise<Project | null>
}

/**
 * Starts a new project from the first chat message: no form and no model call. The name comes from the message;
 * an existing folder gets a numbered name. Without a projects folder the user picks one once.
 */
export function useStartProject(): UseStartProject {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = useCallback(async (text: string): Promise<Project | null> => {
    const api = window.api
    if (!api) {
      setError(BRIDGE_UNAVAILABLE)
      return null
    }
    setStarting(true)
    setError(null)
    try {
      const base = projectNameFrom(text)
      let pickedRoot = false
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const r = await api.createProject({ name: numbered(base, attempt), enableCommands: true })
        if (r.ok) return r.project
        if (r.error === 'exists') continue
        if (r.error === 'no-root' && !pickedRoot) {
          pickedRoot = true
          const picked = await api.projectsRootPick()
          if (picked.root === null) {
            setError('Choose a projects folder to create the project in.')
            return null
          }
          attempt -= 1
          continue
        }
        setError(r.error === 'no-root' ? 'Choose a projects folder to create the project in.' : (ERRORS[r.error] ?? 'Could not create the project.'))
        return null
      }
      setError(ERRORS['exists'] as string)
      return null
    } catch {
      setError('Could not create the project.')
      return null
    } finally {
      setStarting(false)
    }
  }, [])

  return { starting, error, start }
}
