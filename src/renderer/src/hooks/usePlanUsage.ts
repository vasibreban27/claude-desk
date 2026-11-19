import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlanUsage } from '@shared/ipc'

export interface UsePlanUsage {
  usage: PlanUsage | null
  loading: boolean
  error: string | null
  /** Asks for a fresh check (bypasses the main-process cache). */
  refresh: () => void
}

/**
 * Plan limits from Claude Code's `/usage`. Loads once, again when `refreshSignal` changes (the main process
 * answers from its cache within a few minutes), and on demand with `refresh`.
 */
export function usePlanUsage(refreshSignal: number = 0): UsePlanUsage {
  const [usage, setUsage] = useState<PlanUsage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)

  const load = useCallback((refresh: boolean) => {
    const api = window.api
    const mine = ++seq.current
    if (!api || typeof api.usagePlan !== 'function') {
      queueMicrotask(() => {
        if (mine !== seq.current) return
        setLoading(false)
        setError('The desktop bridge is unavailable.')
      })
      return
    }
    queueMicrotask(() => {
      if (mine === seq.current) setLoading(true)
    })
    api
      .usagePlan({ refresh })
      .then((res) => {
        if (mine !== seq.current) return
        if (res.ok) {
          setUsage(res.usage)
          setError(null)
        } else {
          setError(res.message ? `Could not read your plan usage: ${res.message}` : 'Could not read your plan usage.')
        }
      })
      .catch(() => {
        if (mine === seq.current) setError('Could not read your plan usage.')
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false)
      })
  }, [])

  useEffect(() => {
    load(false)
  }, [load, refreshSignal])

  const refresh = useCallback(() => load(true), [load])
  return { usage, loading, error, refresh }
}
