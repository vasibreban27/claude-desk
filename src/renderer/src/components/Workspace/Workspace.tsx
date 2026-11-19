import { useRef, useState, type KeyboardEvent } from 'react'
import { ActivityFeed, PipelineLogFeed } from '../Activity'
import { usePipelineLog } from '../../hooks/usePipelineLog'
import { UsagePanel } from '../Usage'
import { usePlanUsage } from '../../hooks/usePlanUsage'
import type { UseUsage } from '../../hooks/useUsage'

/** Mounted only while the Usage tab is open, so the plan check (`/usage`) runs only when someone looks. */
function UsageTab({
  usage,
  projectNames,
  refreshSignal
}: {
  usage: UseUsage
  projectNames: Record<string, string> | undefined
  refreshSignal: number
}) {
  const plan = usePlanUsage(refreshSignal)
  return <UsagePanel {...usage} {...(projectNames ? { projectNames } : {})} plan={plan} />
}
import { SettingsPanel } from '../Settings'
import { PipelinePanel } from '../Pipeline'
import { ToolkitPanel } from '../Toolkit'
import { usePipeline } from '../../hooks/usePipeline'
import { useActivity } from '../../hooks/useActivity'
import { useUsage } from '../../hooks/useUsage'
import './workspace.css'

export type WorkspaceTab = 'activity' | 'pipeline' | 'usage' | 'toolkit' | 'settings'

export const WORKSPACE_TAB_KEY = 'claude-desk:workspace-tab'

const TABS: { id: WorkspaceTab; label: string }[] = [
  { id: 'activity', label: 'Activity' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'usage', label: 'Usage' },
  { id: 'toolkit', label: 'Toolkit' },
  { id: 'settings', label: 'Settings' }
]

export function readStoredTab(): WorkspaceTab {
  try {
    const raw = localStorage.getItem(WORKSPACE_TAB_KEY)
    return raw === 'usage' || raw === 'toolkit' || raw === 'activity' || raw === 'settings' || raw === 'pipeline' ? raw : 'activity'
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
  const [refresh, setRefresh] = useState<{
    baselineFor: string | null
    seenRunId: string | null
    signal: number
  }>({ baselineFor: null, seenRunId: null, signal: 0 })
  const tabRefs = useRef<Record<WorkspaceTab, HTMLButtonElement | null>>({
    activity: null,
    pipeline: null,
    usage: null,
    toolkit: null,
    settings: null
  })

  const activity = useActivity(projectId)

  // A run that finishes while the project is open changes the usage totals: refetch once per run id.
  // The baseline is the finished run in the loaded history only; a live run-finished that arrived
  // while history was loading differs from it and therefore counts as new.
  if (activity.projectId === projectId && activity.historyLoaded) {
    const liveFinishedRunId = activity.events.find((ev) => ev.type === 'run-finished')?.runId ?? null
    if (refresh.baselineFor !== projectId) {
      const seen = activity.historyFinishedRunId
      const isNew = liveFinishedRunId !== null && liveFinishedRunId !== seen
      setRefresh({
        baselineFor: projectId,
        seenRunId: isNew ? liveFinishedRunId : seen,
        signal: refresh.signal + (isNew ? 1 : 0)
      })
    } else if (liveFinishedRunId !== null && liveFinishedRunId !== refresh.seenRunId) {
      setRefresh({ ...refresh, seenRunId: liveFinishedRunId, signal: refresh.signal + 1 })
    }
  }
  const usage = useUsage(projectId, refresh.signal)
  // Subscribe only while the tab is open so existing Workspace tests need no pipeline bridge.
  const pipeline = usePipeline(tab === 'pipeline' ? projectId : null)
  const pipelineLog = usePipelineLog(tab === 'activity' || tab === 'pipeline' ? projectId : null)
  /** Activity shows chat runs or the pipeline log; Pipeline is the default once a run has logged something. */
  const [activityView, setActivityView] = useState<'chat' | 'pipeline' | null>(null)
  const view = activityView ?? (pipelineLog.entries.length > 0 ? 'pipeline' : 'chat')

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
            aria-controls="workspace-panel"
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
        id="workspace-panel"
        aria-labelledby={`workspace-tab-${tab}`}
        tabIndex={0}
        className="workspace__panel"
      >
        {tab === 'activity' ? (
          <>
            <div className="activity__views" role="radiogroup" aria-label="Activity source">
              {(['chat', 'pipeline'] as const).map((v) => (
                <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setActivityView(v)}>
                  {v === 'chat' ? 'Chat' : 'Pipeline'}
                </button>
              ))}
            </div>
            {view === 'pipeline' ? (
              <PipelineLogFeed entries={pipelineLog.entries} />
            ) : (
              <ActivityFeed events={activity.events} loading={activity.loading} error={activity.error} hasProject />
            )}
          </>
        ) : tab === 'pipeline' ? (
          <PipelinePanel {...pipeline} latestByTask={pipelineLog.latestByTask} />
        ) : tab === 'usage' ? (
          <UsageTab usage={usage} projectNames={projectNames} refreshSignal={refresh.signal} />
        ) : tab === 'toolkit' ? (
          <ToolkitPanel />
        ) : (
          <SettingsPanel projectId={projectId} />
        )}
      </div>
    </div>
  )
}
