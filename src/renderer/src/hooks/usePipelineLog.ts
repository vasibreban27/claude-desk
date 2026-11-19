import { useEffect, useState } from 'react'
import type { PipelineLogEntry } from '@shared/ipc'

const MAX = 500

export interface UsePipelineLog {
  entries: PipelineLogEntry[]
  /** Latest line per task of the latest run, for the Pipeline tab. */
  latestByTask: Record<string, PipelineLogEntry>
}

/** Live pipeline log of a project: history once, then pushed lines. A new run replaces the previous run's lines. */
export function usePipelineLog(projectId: string | null): UsePipelineLog {
  const [state, setState] = useState<{ projectId: string | null; entries: PipelineLogEntry[] }>({ projectId, entries: [] })
  if (state.projectId !== projectId) setState({ projectId, entries: [] })

  useEffect(() => {
    const api = window.api
    if (!api || projectId === null || typeof api.pipelineLog !== 'function') return
    let cancelled = false
    const add = (incoming: PipelineLogEntry[]): void =>
      setState((s) => {
        if (s.projectId !== projectId) return s
        let entries = s.entries
        for (const e of incoming) {
          if (e.projectId !== projectId) continue
          const last = entries[entries.length - 1]
          if (last && last.runId !== e.runId) entries = []
          if (entries.some((x) => x.runId === e.runId && x.seq === e.seq)) continue
          entries = [...entries, e]
        }
        if (entries.length > MAX) entries = entries.slice(entries.length - MAX)
        return entries === s.entries ? s : { ...s, entries }
      })
    api
      .pipelineLog({ projectId })
      .then((h) => {
        if (!cancelled) add(h)
      })
      .catch(() => undefined)
    const off = api.onPipelineLog((e) => add([e]))
    return () => {
      cancelled = true
      off()
    }
  }, [projectId])

  const latestByTask: Record<string, PipelineLogEntry> = {}
  for (const e of state.entries) if (e.taskId !== null) latestByTask[e.taskId] = e
  return { entries: state.entries, latestByTask }
}
