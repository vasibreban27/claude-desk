import { useCallback, useEffect, useRef, useState } from 'react'
import type { TraceEvent, TracePush, TraceRun } from '@shared/ipc'

export interface UseTrace {
  runs: TraceRun[]
  /** The run shown; follows the newest run until the user picks one. */
  runId: string | null
  events: TraceEvent[]
  loading: boolean
  error: string | null
  select(runId: string): void
}

interface State {
  projectId: string | null
  runs: TraceRun[]
  runId: string | null
  /** True once the user picked a run: new runs no longer take over the view. */
  pinned: boolean
  events: TraceEvent[]
  /** The run whose history has been loaded (or failed to load). */
  eventsFor: string | null
  /** The runs list is loading. */
  loading: boolean
  error: string | null
}

const initial = (projectId: string | null): State => ({
  projectId,
  runs: [],
  runId: null,
  pinned: false,
  events: [],
  eventsFor: null,
  loading: projectId !== null && typeof window.api?.activityRuns === 'function',
  error: null
})

/** Adds or replaces a run, newest first. */
export function upsertRun(runs: TraceRun[], run: TraceRun): TraceRun[] {
  const rest = runs.filter((r) => r.runId !== run.runId)
  return [...rest, run].sort((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId))
}

/** Adds events of one run in seq order, dropping duplicates (history overlapping live events). */
export function mergeEvents(events: TraceEvent[], incoming: TraceEvent[]): TraceEvent[] {
  if (incoming.length === 0) return events
  const seen = new Set(events.map((e) => e.seq))
  const fresh = incoming.filter((e) => !seen.has(e.seq))
  if (fresh.length === 0) return events
  const last = events[events.length - 1]
  const inOrder = fresh.every((e, i) => (i === 0 ? last === undefined || e.seq > last.seq : e.seq > fresh[i - 1]!.seq))
  return inOrder ? [...events, ...fresh] : [...events, ...fresh].sort((a, b) => a.seq - b.seq)
}

/** Detailed Activity of a project: its recent runs, one run's events, and live updates. */
export function useTrace(projectId: string | null): UseTrace {
  const [state, setState] = useState<State>(() => initial(projectId))
  if (state.projectId !== projectId) setState(initial(projectId))
  const refetchRuns = useRef<() => void>(() => undefined)

  // Runs: on open, on a run push, and when a pipeline run changes status.
  useEffect(() => {
    const api = window.api
    if (!api || projectId === null || typeof api.activityRuns !== 'function') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = (): void => {
      api
        .activityRuns({ projectId })
        .then((runs) => {
          if (cancelled) return
          setState((s) => {
            if (s.projectId !== projectId) return s
            const own = runs.filter((r) => r.projectId === projectId)
            const keep = s.pinned && s.runId !== null && own.some((r) => r.runId === s.runId)
            const runId = keep ? s.runId : (own[0]?.runId ?? null)
            return runId !== s.runId
              ? { ...s, runs: own, runId, pinned: keep, events: [], eventsFor: null, loading: false, error: null }
              : { ...s, runs: own, pinned: keep, loading: false, error: null }
          })
        })
        .catch(() => {
          if (cancelled) return
          setState((s) => (s.projectId === projectId ? { ...s, loading: false, error: 'Could not load the activity.' } : s))
        })
    }
    refetchRuns.current = () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(load, 300)
    }
    load()

    const offTrace = api.onActivityTrace((push: TracePush) => {
      if (push.type === 'run') {
        if (push.run.projectId !== projectId) return
        setState((s) => {
          if (s.projectId !== projectId) return s
          const runs = upsertRun(s.runs, push.run)
          // A new run takes over the view unless the user picked one.
          const runId = s.pinned ? s.runId : (runs[0]?.runId ?? null)
          return runId !== s.runId ? { ...s, runs, runId, events: [], eventsFor: null } : { ...s, runs }
        })
        return
      }
      const ev = push.event
      if (ev.projectId !== projectId) return
      setState((s) => {
        if (s.projectId !== projectId) return s
        if (!s.runs.some((r) => r.runId === ev.runId)) {
          refetchRuns.current()
          return s
        }
        // Events of the shown run are kept even while its history loads; the two are merged by seq.
        if (ev.runId !== s.runId) return s
        return { ...s, events: mergeEvents(s.events, [ev]) }
      })
    })
    const offPipeline = typeof api.onPipelineEvent === 'function'
      ? api.onPipelineEvent((e) => {
          if (e.projectId === projectId) refetchRuns.current()
        })
      : () => undefined
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
      refetchRuns.current = () => undefined
      offTrace()
      offPipeline()
    }
  }, [projectId])

  // Events of the selected run.
  const runId = state.projectId === projectId ? state.runId : null
  useEffect(() => {
    const api = window.api
    if (!api || projectId === null || runId === null || typeof api.activityEvents !== 'function') return
    let cancelled = false
    api
      .activityEvents({ projectId, runId })
      .then((list) => {
        if (cancelled) return
        setState((s) => {
          if (s.projectId !== projectId || s.runId !== runId) return s
          const own = list.filter((e) => e.runId === runId)
          // Live events that arrived while loading are kept (s.events only ever holds this run's events).
          return { ...s, events: mergeEvents(mergeEvents([], own), s.events), eventsFor: runId, error: null }
        })
      })
      .catch(() => {
        if (cancelled) return
        setState((s) => (s.runId === runId ? { ...s, eventsFor: runId, error: 'Could not load the activity.' } : s))
      })
    return () => {
      cancelled = true
    }
  }, [projectId, runId])

  const select = useCallback((next: string) => {
    setState((s) => (s.runId === next ? { ...s, pinned: true } : { ...s, runId: next, pinned: true, events: [], eventsFor: null }))
  }, [])

  const own = state.projectId === projectId
  return {
    runs: own ? state.runs : [],
    runId: own ? state.runId : null,
    events: own ? state.events : [],
    loading: own ? state.loading || (state.runId !== null && state.eventsFor !== state.runId) : projectId !== null,
    error: own ? state.error : null,
    select
  }
}
