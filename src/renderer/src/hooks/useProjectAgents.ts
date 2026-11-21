import { useCallback, useEffect, useState } from 'react'
import type { AgentOverride, AgentPreviewResult, AgentsSaveResult, ProjectAgentsView } from '@shared/ipc'

const LOAD_ERRORS: Record<string, string> = {
  'no-toolkit': 'No toolkit is set up. Point CLAUDE_TOOLKIT_PATH at your claude-toolkit clone and restart the app.',
  'not-found': 'This project was not found.',
  unreadable: 'The toolkit could not be read.'
}

const SAVE_ERRORS: Record<string, string> = {
  invalid: 'That could not be saved: check the text length.',
  'not-found': 'This project was not found.',
  'storage-unavailable': 'Saving is unavailable: the app database could not be opened.'
}

export interface UseProjectAgents {
  view: ProjectAgentsView | null
  loading: boolean
  error: string | null
  /** Saves (null removes) the override for one agent; resolves to an error message or null. */
  saveOverride: (agent: string, override: AgentOverride | null) => Promise<string | null>
  saveHouseRules: (text: string) => Promise<string | null>
  preview: (agent: string) => Promise<AgentPreviewResult>
}

export function useProjectAgents(projectId: string): UseProjectAgents {
  const [state, setState] = useState<{ for: string; view: ProjectAgentsView | null; error: string | null; loading: boolean }>({
    for: projectId,
    view: null,
    error: null,
    loading: true
  })
  if (state.for !== projectId) setState({ for: projectId, view: null, error: null, loading: true })
  const [reloads, setReloads] = useState(0)

  useEffect(() => {
    let live = true
    const api = window.api
    if (!api || typeof api.agentsView !== 'function') return
    api
      .agentsView({ projectId })
      .then((r) => {
        if (!live) return
        setState(
          r.ok
            ? { for: projectId, view: r.view, error: null, loading: false }
            : { for: projectId, view: null, error: LOAD_ERRORS[r.error] ?? 'Could not load the toolkit.', loading: false }
        )
      })
      .catch(() => {
        if (live) setState({ for: projectId, view: null, error: 'Could not load the toolkit.', loading: false })
      })
    return () => {
      live = false
    }
  }, [projectId, reloads])

  const settle = useCallback(async (call: () => Promise<AgentsSaveResult>): Promise<string | null> => {
    try {
      const r = await call()
      if (!r.ok) return SAVE_ERRORS[r.error] ?? 'Could not save.'
      setReloads((n) => n + 1)
      return null
    } catch {
      return 'Could not save.'
    }
  }, [])

  const saveOverride = useCallback(
    (agent: string, override: AgentOverride | null) => settle(() => window.api.agentsSave({ projectId, agent, override })),
    [projectId, settle]
  )
  const saveHouseRules = useCallback(
    (text: string) => settle(() => window.api.agentsRules({ projectId, houseRules: text })),
    [projectId, settle]
  )
  const preview = useCallback(
    async (agent: string): Promise<AgentPreviewResult> => {
      try {
        return await window.api.agentsPreview({ projectId, agent })
      } catch {
        return { ok: false, error: 'unreadable' }
      }
    },
    [projectId]
  )

  const own = state.for === projectId
  return {
    view: own ? state.view : null,
    loading: own ? state.loading : true,
    error: own ? state.error : null,
    saveOverride,
    saveHouseRules,
    preview
  }
}
