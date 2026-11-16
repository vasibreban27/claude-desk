import { useRef, useState, type KeyboardEvent } from 'react'
import { ActivityFeed } from '../Activity'
import { UsagePanel } from '../Usage'
import { useActivity } from '../../hooks/useActivity'
import { useUsage } from '../../hooks/useUsage'
import './workspace.css'

export type WorkspaceTab = 'activity' | 'usage'

export const WORKSPACE_TAB_KEY = 'claude-desk:workspace-tab'

const TABS: { id: WorkspaceTab; label: string }[] = [
  { id: 'activity', label: 'Activity' },
  { id: 'usage', label: 'Usage' }
]

export function readStoredTab(): WorkspaceTab {
  try {
    const raw = localStorage.getItem(WORKSPACE_TAB_KEY)
    return raw === 'usage' || raw === 'activity' ? raw : 'activity'
  } catch {
    return 'activity'
  }
}

export interface WorkspaceProps {
  projectId: string
  /** Project id to display name, for the usage per-project table. */
  projectNames?: Record<string, string>
}

export function Workspace({ projectId, projectNames }: WorkspaceProps) {
  const [tab, setTab] = useState<WorkspaceTab>(readStoredTab)
  const [refresh, setRefresh] = useState<{ seenRunId: string | null; signal: number }>({
    seenRunId: null,
    signal: 0
  })
  const tabRefs = useRef<Record<WorkspaceTab, HTMLButtonElement | null>>({ activity: null, usage: null })

  const activity = useActivity(projectId)

  // A finished run (live or from history) changes the usage totals: refetch once per finished run.
  const finishedRunId = activity.events.find((ev) => ev.type === 'run-finished')?.runId ?? null
  if (finishedRunId !== null && finishedRunId !== refresh.seenRunId) {
    setRefresh({ seenRunId: finishedRunId, signal: refresh.signal + 1 })
  }
  const usage = useUsage(projectId, refresh.signal)

  function select(next: WorkspaceTab, focus = false) {
    setTab(next)
    try {
      localStorage.setItem(WORKSPACE_TAB_KEY, next)
    } catch {
      // storage unavailable: the choice is simply not remembered
    }
    if (focus) tabRefs.current[next]?.focus()
  }

  function onKeyDown(ev: KeyboardEvent<HTMLButtonElement>) {
    const i = TABS.findIndex((t) => t.id === tab)
    let next: number | null = null
    if (ev.key === 'ArrowRight') next = (i + 1) % TABS.length
    else if (ev.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length
    else if (ev.key === 'Home') next = 0
    else if (ev.key === 'End') next = TABS.length - 1
    if (next === null) return
    ev.preventDefault()
    select(TABS[next]!.id, true)
  }

  return (
    <div className="workspace">
      <div role="tablist" aria-label="Workspace views" className="workspace__tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el
            }}
            type="button"
            role="tab"
            id={`workspace-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`workspace-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className="workspace__tab"
            onClick={() => select(t.id)}
            onKeyDown={onKeyDown}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`workspace-panel-${tab}`}
        aria-labelledby={`workspace-tab-${tab}`}
        className="workspace__panel"
      >
        {tab === 'activity' ? (
          <ActivityFeed {...activity} hasProject />
        ) : (
          <UsagePanel {...usage} projectNames={projectNames} />
        )}
      </div>
    </div>
  )
}
