import { useEffect, useMemo, useRef, useState } from 'react'
import type { PipelineLogEntry } from '@shared/ipc'

function time(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour12: false })
}

function who(e: PipelineLogEntry): string {
  if (e.role === 'reviewer') return e.agent ?? 'reviewer'
  return e.role
}

/** Short live lines of the latest pipeline run, filterable by task, newest at the bottom. */
export function PipelineLogFeed({ entries }: { entries: PipelineLogEntry[] }) {
  const [task, setTask] = useState<string>('all')
  const tasks = useMemo(() => [...new Set(entries.flatMap((e) => (e.taskId ? [e.taskId] : [])))].sort(), [entries])
  const shown = task === 'all' ? entries : entries.filter((e) => e.taskId === task || e.taskId === null)
  const endRef = useRef<HTMLLIElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [shown.length])

  if (entries.length === 0) {
    return <p className="activity__empty">No pipeline activity yet. Start a plan from the Pipeline tab.</p>
  }
  return (
    <div className="pipeline-log">
      <label className="pipeline-log__filter">
        Task{' '}
        <select value={task} onChange={(e) => setTask(e.target.value)} aria-label="Filter by task">
          <option value="all">All</option>
          {tasks.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <ol className="pipeline-log__list" aria-label="Pipeline activity" aria-live="polite">
        {shown.map((e) => (
          <li key={`${e.runId}:${e.seq}`} className={`pipeline-log__line pipeline-log__line--${e.tone}`}>
            <span className="pipeline-log__time">{time(e.at)}</span>
            <span className="pipeline-log__task">{e.taskId ?? 'run'}</span>
            <span className="pipeline-log__who">{who(e)}</span>
            <span className="pipeline-log__text">{e.text}</span>
            {e.tone === 'denied' && <span className="pipeline-log__badge">Denied</span>}
          </li>
        ))}
        <li ref={endRef} aria-hidden="true" />
      </ol>
    </div>
  )
}
