import { useEffect, useState } from 'react'
import type { UsageSummary } from '@shared/ipc'

export type UsageScope = 'project' | 'all'
export const USAGE_RANGES = [7, 30, 90] as const
export type UsageRange = (typeof USAGE_RANGES)[number]

export interface UseUsage {
  summary: UsageSummary | null
  loading: boolean
  error: string | null
  days: UsageRange
  /** Effective scope: 'all' whenever no project is selected. */
  scope: UsageScope
  hasProject: boolean
  setDays: (days: UsageRange) => void
  setScope: (scope: UsageScope) => void
}

/**
 * Loads the usage summary. `refreshSignal` is any value that changes when the
 * view should refetch (for example a counter bumped on `run-finished`).
 */
export function useUsage(projectId: string | null, refreshSignal: number = 0): UseUsage {
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState<UsageRange>(30)
  const [chosenScope, setScope] = useState<UsageScope>('project')

  const scope: UsageScope = projectId === null ? 'all' : chosenScope
  const requestProjectId = scope === 'project' ? projectId : null

  useEffect(() => {
    let cancelled = false
    const api = window.api
    const request = api
      ? api.usageSummary({ projectId: requestProjectId, days })
      : Promise.reject(new Error('no bridge'))
    Promise.resolve().then(() => {
      if (!cancelled) setLoading(true)
    })
    request
      .then((result) => {
        if (cancelled) return
        setSummary(result)
        setError(null)
      })
      .catch(() => {
        if (!cancelled) setError(api ? 'Could not load usage.' : 'The desktop bridge is unavailable.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [requestProjectId, days, refreshSignal])

  return { summary, loading, error, days, scope, hasProject: projectId !== null, setDays, setScope }
}
