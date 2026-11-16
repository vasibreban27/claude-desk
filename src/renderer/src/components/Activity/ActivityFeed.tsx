import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { UseActivity } from '../../hooks/useActivity'
import { isNearBottom } from '../Chat/stickToBottom'
import { buildRows, formatCost, formatDuration, formatTime, type ActivityRow } from './rows'
import './activity.css'

export interface ActivityFeedProps extends UseActivity {
  hasProject: boolean
}

const STATE_LABEL = { running: 'running', denied: 'Denied', ended: 'ended', done: '' } as const

function Row({ row }: { row: ActivityRow }) {
  if (row.kind === 'run-started') {
    return (
      <li className="activity__row activity__row--meta">
        <time dateTime={row.at}>{formatTime(row.at)}</time>
        <span>Run started</span>
      </li>
    )
  }
  if (row.kind === 'run-finished') {
    const ok = row.status === 'success'
    return (
      <li className={`activity__row activity__row--footer${ok ? '' : ' activity__row--error'}`}>
        <time dateTime={row.at}>{formatTime(row.at)}</time>
        <span className="activity__status">{ok ? 'Run finished' : 'Run failed'}</span>
        <span>{formatCost(row.costUsd)} (estimated)</span>
        {row.durationMs !== null && <span>{formatDuration(row.durationMs)}</span>}
      </li>
    )
  }
  const cls = `activity__row${row.subagent ? ' activity__row--sub' : ''}`
  return (
    <li className={cls}>
      <time dateTime={row.at}>{formatTime(row.at)}</time>
      <span className="activity__agent">
        {row.subagent && <span className="activity__badge">Subagent</span>}
        {row.agent}
      </span>
      {row.kind === 'tool' ? (
        <>
          <span className="activity__tool">{row.tool}</span>
          {row.summary && <span className="activity__summary">{row.summary}</span>}
          {row.durationMs !== null && <span className="activity__duration">{formatDuration(row.durationMs)}</span>}
          {STATE_LABEL[row.state] && (
            <span className={`activity__badge activity__badge--${row.state}`}>{STATE_LABEL[row.state]}</span>
          )}
        </>
      ) : (
        <>
          <span className="activity__tool">Finished</span>
          {row.summary && <span className="activity__summary">{row.summary}</span>}
        </>
      )}
    </li>
  )
}

export function ActivityFeed({ hasProject, events, loading, error }: ActivityFeedProps) {
  const rows = useMemo(() => buildRows(events), [events])
  const listRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [pinned, setPinned] = useState(true)

  const scrollToBottom = () => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // Follow new rows only while the reader is at the bottom; never move a scrolled-up view.
  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToBottom()
  }, [rows])

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    const near = isNearBottom(el)
    pinnedRef.current = near
    setPinned(near)
  }

  const jump = () => {
    pinnedRef.current = true
    setPinned(true)
    scrollToBottom()
  }

  return (
    <div className="activity">
      <div className="activity__scroller">
        <div
          ref={listRef}
          className="activity__list"
          role="log"
          aria-live="polite"
          aria-label="Activity"
          onScroll={onScroll}
        >
          {!hasProject && <p className="activity__empty">Add or select a project to see its activity.</p>}
          {hasProject && loading && <p className="activity__empty">Loading activity…</p>}
          {hasProject && !loading && error && (
            <p role="alert" className="activity__error">
              {error}
            </p>
          )}
          {hasProject && !loading && !error && rows.length === 0 && (
            <p className="activity__empty">No activity yet. Start a chat run.</p>
          )}
          {rows.length > 0 && (
            <ul className="activity__rows">
              {rows.map((row) => (
                <Row key={row.key} row={row} />
              ))}
            </ul>
          )}
        </div>
        {!pinned && rows.length > 0 && (
          <button type="button" className="activity__jump" onClick={jump}>
            Jump to latest
          </button>
        )}
      </div>
    </div>
  )
}
