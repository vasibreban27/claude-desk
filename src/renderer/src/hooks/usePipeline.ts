import { useCallback, useEffect, useRef, useState } from 'react'
import type { PipelineRunView, PipelineStartError, PlanEntry } from '@shared/ipc'

export const START_ERROR_MESSAGES: Record<PipelineStartError, string> = {
  busy: 'A run is already active for this project.',
  'no-toolkit': 'The toolkit is not set up. Configure it before starting a run.',
  'detached-head': 'The project is on a detached HEAD. Check out a branch and try again.',
  'invalid-plan': 'This plan is not valid. Fix the listed errors and try again.',
  'not-found': 'The project or the plan file was not found.',
  'storage-unavailable': 'Run storage is unavailable.',
  'start-failed': 'The run could not be started.'
}

export interface UsePipeline {
  /** Project the returned state belongs to (lags `projectId` for one render after a switch). */
  projectId: string | null
  plans: PlanEntry[] | null
  plansLoading: boolean
  plansError: string | null
  run: PipelineRunView | null
  runLoading: boolean
  runError: string | null
  starting: boolean
  startError: string | null
  cancelling: boolean
  cancelError: string | null
  discarding: boolean
  discardError: string | null
  start: (planFile: string) => Promise<void>
  cancel: () => Promise<void>
  /** Resolves true when the run was discarded. */
  discard: () => Promise<boolean>
  reloadPlans: () => void
}

export const DISCARD_ERROR_MESSAGES: Record<'active' | 'not-found' | 'cleanup-failed' | 'failed', string> = {
  active: 'The run is still active. Cancel it first, then discard it.',
  'not-found': 'The run was not found. It may already have been discarded.',
  'cleanup-failed':
    'Some worktrees or branches could not be removed. The run was kept; try Discard again.',
  failed: 'Could not discard the run.'
}

interface State {
  projectId: string | null
  plans: PlanEntry[] | null
  plansLoading: boolean
  plansError: string | null
  run: PipelineRunView | null
  runLoading: boolean
  runError: string | null
  starting: boolean
  startError: string | null
  cancelling: boolean
  cancelError: string | null
  discarding: boolean
  discardError: string | null
}

const empty = (projectId: string | null): State => ({
  projectId,
  plans: null,
  plansLoading: projectId !== null,
  plansError: null,
  run: null,
  runLoading: projectId !== null,
  runError: null,
  starting: false,
  startError: null,
  cancelling: false,
  cancelError: null,
  discarding: false,
  discardError: null
})

export function usePipeline(projectId: string | null): UsePipeline {
  const [state, setState] = useState<State>(() => empty(projectId))
  if (state.projectId !== projectId) setState(empty(projectId))

  const current = useRef<string | null>(projectId)
  useEffect(() => {
    current.current = projectId
  }, [projectId])
  const startingRef = useRef(false)
  const discardingRef = useRef(false)

  const fetchStatus = useCallback(async (pid: string): Promise<void> => {
    const api = window.api
    if (!api) return
    try {
      const res = await api.pipelineStatus({ projectId: pid })
      if (current.current !== pid) return
      setState((s) => {
        if (s.projectId !== pid) return s
        if (!res.ok) {
          return {
            ...s,
            runLoading: false,
            cancelling: false,
            runError:
              res.error === 'not-found' ? 'The project was not found.' : 'Run storage is unavailable.'
          }
        }
        return { ...s, run: res.run, runLoading: false, runError: null, cancelling: false }
      })
    } catch {
      if (current.current !== pid) return
      setState((s) =>
        s.projectId === pid ? { ...s, runLoading: false, runError: 'Could not load the run status.' } : s
      )
    }
  }, [])

  const fetchPlans = useCallback(async (pid: string): Promise<void> => {
    const api = window.api
    if (!api) return
    try {
      const res = await api.pipelinePlans({ projectId: pid })
      if (current.current !== pid) return
      setState((s) => {
        if (s.projectId !== pid) return s
        if (!res.ok) {
          return {
            ...s,
            plansLoading: false,
            plansError:
              res.error === 'not-found' ? 'The project was not found.' : 'The plans folder could not be read.'
          }
        }
        return { ...s, plans: res.plans, plansLoading: false, plansError: null }
      })
    } catch {
      if (current.current !== pid) return
      setState((s) =>
        s.projectId === pid ? { ...s, plansLoading: false, plansError: 'Could not load the plans.' } : s
      )
    }
  }, [])

  useEffect(() => {
    const api = window.api
    if (!api || projectId === null) return
    const unsubscribe = api.onPipelineEvent((event) => {
      if (event.projectId !== projectId) return
      void fetchStatus(projectId)
    })
    // Initial loads start from a microtask so no state is set synchronously in the effect body.
    queueMicrotask(() => {
      void fetchStatus(projectId)
      void fetchPlans(projectId)
    })
    return unsubscribe
  }, [projectId, fetchStatus, fetchPlans])

  const start = useCallback(
    async (planFile: string): Promise<void> => {
      const api = window.api
      const pid = current.current
      if (!api || pid === null || startingRef.current) return
      startingRef.current = true
      setState((s) => (s.projectId === pid ? { ...s, starting: true, startError: null } : s))
      let startError: string | null = null
      try {
        const res = await api.pipelineStart({ projectId: pid, planFile })
        if (!res.ok) startError = res.message ? `${START_ERROR_MESSAGES[res.error]} ${res.message}` : START_ERROR_MESSAGES[res.error]
      } catch {
        startError = START_ERROR_MESSAGES['start-failed']
      }
      startingRef.current = false
      if (current.current !== pid) return
      setState((s) => (s.projectId === pid ? { ...s, starting: false, startError } : s))
      if (startError === null) await fetchStatus(pid)
    },
    [fetchStatus]
  )

  const cancel = useCallback(async (): Promise<void> => {
    const api = window.api
    const pid = current.current
    const runId = state.run?.runId
    if (!api || pid === null || !runId) return
    setState((s) => (s.projectId === pid ? { ...s, cancelling: true, cancelError: null } : s))
    let cancelError: string | null = null
    try {
      const res = await api.pipelineCancel({ projectId: pid, runId })
      if (!res.ok) {
        cancelError = res.error === 'not-active' ? 'The run is no longer active.' : 'The run was not found.'
      }
    } catch {
      cancelError = 'Could not cancel the run.'
    }
    if (current.current !== pid) return
    if (cancelError !== null) {
      setState((s) => (s.projectId === pid ? { ...s, cancelling: false, cancelError } : s))
      await fetchStatus(pid)
    }
    // On success `cancelling` stays set until the next status arrives (fetchStatus clears it).
  }, [state.run?.runId, fetchStatus])

  const discard = useCallback(async (): Promise<boolean> => {
    const api = window.api
    const pid = current.current
    const runId = state.run?.runId
    if (!api || pid === null || !runId || discardingRef.current) return false
    discardingRef.current = true
    setState((s) => (s.projectId === pid ? { ...s, discarding: true, discardError: null } : s))
    let discardError: string | null = null
    try {
      const res = await api.pipelineDiscard({ projectId: pid, runId })
      if (!res.ok) discardError = DISCARD_ERROR_MESSAGES[res.error]
    } catch {
      discardError = DISCARD_ERROR_MESSAGES.failed
    }
    discardingRef.current = false
    if (current.current !== pid) return false
    setState((s) => (s.projectId === pid ? { ...s, discarding: false, discardError } : s))
    await fetchStatus(pid)
    return discardError === null
  }, [state.run?.runId, fetchStatus])

  const reloadPlans = useCallback(() => {
    const pid = current.current
    if (pid === null) return
    setState((s) => (s.projectId === pid ? { ...s, plansLoading: true } : s))
    void fetchPlans(pid)
  }, [fetchPlans])

  return { ...state, start, cancel, discard, reloadPlans }
}
