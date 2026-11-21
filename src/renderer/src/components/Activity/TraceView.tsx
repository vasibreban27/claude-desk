import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TraceRun } from '@shared/ipc'
import type { UseTrace } from '../../hooks/useTrace'
import {
  NO_FILTER,
  buildTree,
  filterOptions,
  filterTree,
  formatDuration,
  formatTokens,
  shortTool,
  type Group,
  type NoteEvent,
  type Session,
  type Step,
  type TraceFilter
} from './traceTree'
import './trace.css'

const SOURCE_LABEL: Record<TraceRun['source'], string> = { chat: 'Chat', plan: 'Plan', pipeline: 'Pipeline' }
const STATUS_LABEL: Record<TraceRun['status'], string> = { running: 'running', ok: 'done', error: 'failed', cancelled: 'cancelled' }
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

function runLabel(run: TraceRun): string {
  const time = new Date(run.startedAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  return `${SOURCE_LABEL[run.source]} · ${run.title} · ${time} · ${STATUS_LABEL[run.status]}`
}

function ToolRow({ step }: { step: Extract<Step, { type: 'tool' }> }) {
  const isAgent = SUBAGENT_TOOLS.has(step.call.tool)
  const [open, setOpen] = useState(isAgent)
  const r = step.result
  const state = r === null ? 'running' : r.denied ? 'denied' : r.ok ? 'ok' : 'error'
  const icon = state === 'running' ? '…' : state === 'ok' ? '✓' : state === 'denied' ? '⊘' : '✗'
  const stateLabel = state === 'running' ? 'running' : state === 'ok' ? 'succeeded' : state === 'denied' ? 'denied' : 'failed'
  const name = shortTool(step.call.tool)
  return (
    <li className={`trace__step trace__step--tool trace__step--${state}`}>
      <button
        type="button"
        className="trace__line"
        aria-expanded={open}
        aria-label={`${name}${step.call.summary ? ` ${step.call.summary}` : ''}, ${stateLabel}${r?.durationMs != null ? `, ${formatDuration(r.durationMs)}` : ''}`}
        onClick={() => setOpen(!open)}
      >
        <span className="trace__icon" aria-hidden="true" title={stateLabel}>
          {icon}
        </span>
        <span className="trace__tool">{name}</span>
        {step.call.summary ? <span className="trace__summary">{step.call.summary}</span> : null}
        {step.call.diff !== null ? (
          <span className="trace__diffstat">
            <span className="trace__add">+{step.call.added}</span> <span className="trace__del">−{step.call.removed}</span>
          </span>
        ) : null}
        {isAgent && step.children.length > 0 ? <span className="trace__meta">{step.children.length} steps</span> : null}
        {r?.durationMs != null ? <span className="trace__meta">{formatDuration(r.durationMs)}</span> : null}
      </button>
      {open ? (
        <div className="trace__details">
          {step.call.diff !== null ? (
            <pre className="trace__pre trace__diff" aria-label="Changes">
              {step.call.diff.split('\n').map((line, i) => (
                <span key={i} className={line.startsWith('+ ') ? 'trace__add' : line.startsWith('- ') ? 'trace__del' : undefined}>
                  {line}
                  {'\n'}
                </span>
              ))}
            </pre>
          ) : step.call.input ? (
            <pre className="trace__pre" aria-label="Input">
              {step.call.input}
            </pre>
          ) : null}
          {isAgent && step.children.length > 0 ? <Steps steps={step.children} nested /> : null}
          {r !== null && r.output ? (
            <pre className={`trace__pre trace__output${r.ok ? '' : ' trace__output--error'}`} aria-label="Output">
              {r.output}
            </pre>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

function TextRow({ text, agent, showAgent }: { text: string; agent: string; showAgent: boolean }) {
  const long = text.split('\n').length > 4 || text.length > 400
  const [open, setOpen] = useState(false)
  return (
    <li className="trace__step trace__step--text">
      <span className="trace__icon" aria-hidden="true">
        ⏺
      </span>
      <div className="trace__text">
        {showAgent ? <span className="trace__agent">{agent}</span> : null}
        <p className={long && !open ? 'trace__clamp' : undefined}>{text}</p>
        {long ? (
          <button type="button" className="trace__more" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Show less' : 'Show more'}
          </button>
        ) : null}
      </div>
    </li>
  )
}

function TurnRow({ step }: { step: Extract<Step, { type: 'turn' }> }) {
  const e = step.event
  const tokens = e.inputTokens + e.outputTokens + e.cacheTokens
  const parts = [
    e.ok ? 'Finished' : 'Ended with an error',
    e.turns !== null ? `${e.turns} turns` : null,
    e.durationMs !== null ? formatDuration(e.durationMs) : null,
    tokens > 0 ? `${formatTokens(tokens)} tokens` : null,
    e.costUsd !== null ? `$${e.costUsd.toFixed(2)}` : null
  ].filter(Boolean)
  return <li className={`trace__step trace__turn${e.ok ? '' : ' trace__turn--error'}`}>{parts.join(' · ')}</li>
}

function Steps({ steps, nested = false, sessionAgent }: { steps: Step[]; nested?: boolean; sessionAgent?: string }) {
  return (
    <ul className={`trace__steps${nested ? ' trace__steps--nested' : ''}`}>
      {steps.map((s) =>
        s.type === 'tool' ? (
          <ToolRow key={s.key} step={s} />
        ) : s.type === 'text' ? (
          <TextRow key={s.key} text={s.event.text} agent={s.agent} showAgent={nested && s.agent !== sessionAgent} />
        ) : (
          <TurnRow key={s.key} step={s} />
        )
      )}
    </ul>
  )
}

function NoteRow({ event }: { event: NoteEvent }) {
  return <li className={`trace__note trace__note--${event.tone}`}>{event.text}</li>
}

function SessionBlock({ session, showHeader }: { session: Session; showHeader: boolean }) {
  return (
    <li className="trace__session">
      {showHeader ? (
        <div className="trace__session-head">
          <span className="trace__session-label">{session.label}</span>
          {session.agent !== 'main' && session.label !== session.agent ? <span className="trace__meta">{session.agent}</span> : null}
        </div>
      ) : null}
      <Steps steps={session.steps} sessionAgent={session.agent} />
    </li>
  )
}

function GroupBlock({ group, single }: { group: Group; single: boolean }) {
  const sessions = group.items.filter((i) => i.type === 'session').length
  return (
    <section className="trace__group" aria-label={group.taskId ? `Task ${group.taskId}` : 'Run'}>
      {group.taskId !== null ? <h3 className="trace__group-head">{group.taskId}</h3> : null}
      <ul className="trace__items">
        {group.items.map((item) =>
          item.type === 'note' ? (
            <NoteRow key={item.key} event={item.event} />
          ) : (
            <SessionBlock key={item.key} session={item} showHeader={!(single && sessions === 1 && group.taskId === null)} />
          )
        )}
      </ul>
    </section>
  )
}

export function TraceView({ runs, runId, events, loading, error, select }: UseTrace) {
  const [filter, setFilter] = useState<TraceFilter>(NO_FILTER)
  const [filterFor, setFilterFor] = useState(runId)
  if (filterFor !== runId) {
    setFilterFor(runId)
    setFilter(NO_FILTER)
  }
  const tree = useMemo(() => buildTree(events), [events])
  const shown = useMemo(() => filterTree(tree, filter), [tree, filter])
  const options = useMemo(() => filterOptions(events), [events])
  const run = runs.find((r) => r.runId === runId) ?? null

  // Follow the end of a live run unless the user scrolled up.
  const listRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [events.length, runId])

  if (runs.length === 0) {
    return (
      <div className="trace">
        {error ? <p className="trace__error" role="alert">{error}</p> : null}
        <p className="trace__empty">
          {loading ? 'Loading…' : 'Nothing in the last 2 days. Chat, Plan and Pipeline runs show up here as they happen.'}
        </p>
      </div>
    )
  }

  const filtered = filter.taskId !== null || filter.agent !== null || filter.errorsOnly
  return (
    <div className="trace">
      <div className="trace__bar">
        <label className="trace__field trace__field--run">
          <span>Run</span>
          <select value={runId ?? ''} onChange={(e) => select(e.target.value)}>
            {runs.map((r) => (
              <option key={r.runId} value={r.runId}>
                {runLabel(r)}
              </option>
            ))}
          </select>
        </label>
        {options.tasks.length > 0 ? (
          <label className="trace__field">
            <span>Task</span>
            <select value={filter.taskId ?? ''} onChange={(e) => setFilter({ ...filter, taskId: e.target.value || null })}>
              <option value="">All</option>
              {options.tasks.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {options.agents.length > 1 ? (
          <label className="trace__field">
            <span>Agent</span>
            <select value={filter.agent ?? ''} onChange={(e) => setFilter({ ...filter, agent: e.target.value || null })}>
              <option value="">All</option>
              {options.agents.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="trace__check">
          <input type="checkbox" checked={filter.errorsOnly} onChange={(e) => setFilter({ ...filter, errorsOnly: e.target.checked })} />
          Errors only
        </label>
        {run?.status === 'running' ? <span className="trace__live">Live</span> : null}
      </div>
      {error ? <p className="trace__error" role="alert">{error}</p> : null}
      <div
        ref={listRef}
        className="trace__list"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {loading && events.length === 0 ? (
          <p className="trace__empty">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="trace__empty">{filtered ? 'Nothing matches these filters.' : 'No steps recorded for this run yet.'}</p>
        ) : (
          shown.map((g) => <GroupBlock key={g.taskId ?? ''} group={g} single={shown.length === 1} />)
        )}
      </div>
    </div>
  )
}
