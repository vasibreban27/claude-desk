import { useEffect, useState } from 'react'
import type { ActivityEvent } from '@shared/ipc'

export interface UseActivity {
  events: ActivityEvent[]
  loading: boolean
  error: string | null
}

interface ActivityState {
  projectId: string | null
  events: ActivityEvent[]
  loading: boolean
  error: string | null
}

const empty = (projectId: string | null): ActivityState => ({
  projectId,
  events: [],
  loading: projectId !== null,
  error: null
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
      setState((s) => (s.projectId === projectId ? { ...s, events: addEvent(s.events, event) } : s))
    })
    api
      .activityHistory({ projectId })
      .then((history) => {
        if (cancelled) return
        setState((s) => {
          if (s.projectId !== projectId) return s
          const merged = s.events.reduce(addEvent, history.filter((e) => e.projectId === projectId))
          return { ...s, events: merged, loading: false }
        })
      })
      .catch(() => {
        if (cancelled) return
        setState((s) =>
          s.projectId === projectId ? { ...s, loading: false, error: 'Could not load the activity.' } : s
        )
      })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [projectId])

  return { events: state.events, loading: state.loading, error: state.error }
}
