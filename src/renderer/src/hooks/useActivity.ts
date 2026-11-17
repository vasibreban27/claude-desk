import { useEffect, useState } from 'react'
import type { ActivityEvent } from '@shared/ipc'

export interface UseActivity {
  /** Project the returned state belongs to (lags `projectId` for one render after a switch). */
  projectId: string | null
  events: ActivityEvent[]
  loading: boolean
  error: string | null
  /** True once the history request settled (success or failure) for this project. */
  historyLoaded: boolean
  /** Run id of the finished run found in the loaded history only (never from live events). */
  historyFinishedRunId: string | null
}

interface ActivityState {
  projectId: string | null
  events: ActivityEvent[]
  loading: boolean
  error: string | null
  historyLoaded: boolean
  historyFinishedRunId: string | null
}

const empty = (projectId: string | null): ActivityState => ({
  projectId,
  events: [],
  loading: projectId !== null,
  error: null,
  historyLoaded: false,
  historyFinishedRunId: null
})

/**
 * Adds one event to a feed that shows a single run. An event of a different run replaces the feed
 * (it is a newer run); duplicates (history overlapping live events) are dropped; order is by `seq`.
 */
export function addEvent(events: ActivityEvent[], event: ActivityEvent): ActivityEvent[] {
  const last = events[events.length - 1]
  if (!last || last.runId !== event.runId) return [event]
  if (events.some((e) => e.seq === event.seq)) return events
  if (event.seq > last.seq) return [...events, event]
  return [...events, event].sort((a, b) => a.seq - b.seq)
}

export function useActivity(projectId: string | null): UseActivity {
  const [state, setState] = useState<ActivityState>(() => empty(projectId))

  // Reset during render when the selected project changes.
  if (state.projectId !== projectId) setState(empty(projectId))

  useEffect(() => {
    const api = window.api
    if (!api || projectId === null) return
    let cancelled = false
    // Subscribe before loading history so no event is missed; overlaps are deduplicated.
    const unsubscribe = api.onActivityEvent((event) => {
      if (event.projectId !== projectId) return
      setState((s) => (s.projectId === projectId ? { ...s, events: addEvent(s.events, event), error: null } : s))
    })
    api
      .activityHistory({ projectId })
      .then((history) => {
        if (cancelled) return
        setState((s) => {
          if (s.projectId !== projectId) return s
          const own = history.filter((e) => e.projectId === projectId)
          const merged = s.events.reduce(addEvent, own)
          const historyFinishedRunId = own.find((e) => e.type === 'run-finished')?.runId ?? null
          return { ...s, events: merged, loading: false, historyLoaded: true, historyFinishedRunId }
        })
      })
      .catch(() => {
        if (cancelled) return
        setState((s) =>
          s.projectId === projectId
            ? { ...s, loading: false, historyLoaded: true, error: 'Could not load the activity.' }
            : s
        )
      })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [projectId])

  return {
    projectId: state.projectId,
    events: state.events,
    loading: state.loading,
    error: state.error,
    historyLoaded: state.historyLoaded,
    historyFinishedRunId: state.historyFinishedRunId
  }
}
