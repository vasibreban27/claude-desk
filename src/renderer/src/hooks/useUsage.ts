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
  const [result, setResult] = useState<{ key: string; summary: UsageSummary } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const [fetching, setFetching] = useState(false)
  const [days, setDays] = useState<UsageRange>(30)
  const [chosenScope, setScope] = useState<UsageScope>('project')

  const scope: UsageScope = projectId === null ? 'all' : chosenScope
  const requestProjectId = scope === 'project' ? projectId : null
  // Data and errors belong to the request that produced them; others are not shown.
  const key = `${requestProjectId ?? 'all'}|${days}|${scope}`
  const summary = result?.key === key ? result.summary : null
  const error = failure?.key === key ? failure.message : null
  const loading = fetching || (summary === null && error === null)

  useEffect(() => {
    let cancelled = false
    const api = window.api
    const request = api
      ? api.usageSummary({ projectId: requestProjectId, days })
      : Promise.reject(new Error('no bridge'))
    Promise.resolve().then(() => {
      if (!cancelled) setFetching(true)
    })
    request
      .then((res) => {
        if (cancelled) return
        setResult({ key, summary: res })
        setFailure(null)
      })
      .catch(() => {
        if (!cancelled) {
          setFailure({ key, message: api ? 'Could not load usage.' : 'The desktop bridge is unavailable.' })
        }
      })
      .finally(() => {
        if (!cancelled) setFetching(false)
      })
    return () => {
      cancelled = true
    }
  }, [key, requestProjectId, days, refreshSignal])

  return { summary, loading, error, days, scope, hasProject: projectId !== null, setDays, setScope }
}
