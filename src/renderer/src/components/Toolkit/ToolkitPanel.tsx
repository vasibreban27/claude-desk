import { useEffect, useMemo, useState } from 'react'
import type { ToolkitAgent, ToolkitHook, ToolkitListResult, ToolkitListing, ToolkitSkill } from '../../../../shared/ipc'
import { Markdown } from '../Markdown'
import './toolkit.css'

type Selected =
  | { kind: 'agent'; item: ToolkitAgent }
  | { kind: 'skill'; item: ToolkitSkill }
  | { kind: 'hook'; item: ToolkitHook }
  | null

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; listing: ToolkitListing }

const ERRORS: Record<string, string> = {
  unset: 'No toolkit configured. Set CLAUDE_TOOLKIT_PATH to your claude-toolkit clone.',
  unreadable: 'The toolkit folder could not be read.'
}
const GENERIC = 'Could not load the toolkit.'

export function ToolkitPanel() {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Selected>(null)

  useEffect(() => {
    let live = true
    window.api
      .toolkitList()
      .then((r: ToolkitListResult) => {
        if (!live) return
        setState(r.ok ? { status: 'ok', listing: r.listing } : { status: 'error', message: ERRORS[r.error] ?? GENERIC })
      })
      .catch(() => {
        if (live) setState({ status: 'error', message: GENERIC })
      })
    return () => {
      live = false
    }
  }, [])

  const q = filter.trim().toLowerCase()
  const view = useMemo(() => {
    if (state.status !== 'ok') return null
    const match = (...parts: (string | null)[]): boolean => q === '' || parts.some((p) => (p ?? '').toLowerCase().includes(q))
    const l = state.listing
    return {
      agents: l.agents.filter((a) => match(a.name, a.description)),
      skills: l.skills.filter((s) => match(s.name, s.description)),
      hooks: l.hooks.filter((h) => match(h.event, h.matcher, h.command))
    }
  }, [state, q])

  if (state.status === 'loading') {
    return (
      <p className="toolkit" role="status">
        Loading toolkit...
      </p>
    )
  }
  if (state.status === 'error' || view === null) {
    return (
      <p className="toolkit" role="alert">
        {state.status === 'error' ? state.message : GENERIC}
      </p>
    )
  }
  const { listing } = state

  return (
    <section className="toolkit" aria-label="Toolkit">
      <div className="toolkit__meta">
        {listing.plugin ? `${listing.plugin.name} ${listing.plugin.version ?? ''}`.trim() : 'Unknown plugin'}
        {listing.plugin?.description ? ` - ${listing.plugin.description}` : ''}
      </div>
      {listing.problems.length > 0 ? (
        <ul className="toolkit__problems" aria-label="Problems">
          {listing.problems.map((p) => (
            <li key={p.file}>{`${p.file}: ${p.reason}`}</li>
          ))}
        </ul>
      ) : null}
      <input
        className="toolkit__filter"
        type="search"
        placeholder="Filter"
        aria-label="Filter toolkit"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="toolkit__body">
        <div className="toolkit__list">
          <h3>Agents ({view.agents.length})</h3>
          {view.agents.map((a) => (
            <button key={a.source} className="toolkit__item" aria-pressed={selected?.item === a} onClick={() => setSelected({ kind: 'agent', item: a })}>
              {a.name}
            </button>
          ))}
          <h3>Skills ({view.skills.length})</h3>
          {view.skills.map((s) => (
            <button key={s.source} className="toolkit__item" aria-pressed={selected?.item === s} onClick={() => setSelected({ kind: 'skill', item: s })}>
              {s.name}
            </button>
          ))}
          <h3>Hooks ({view.hooks.length})</h3>
          {view.hooks.map((h, i) => (
            <button key={`${h.event}-${i}`} className="toolkit__item" aria-pressed={selected?.item === h} onClick={() => setSelected({ kind: 'hook', item: h })}>
              {h.event}
              {h.matcher ? ` (${h.matcher})` : ''}
            </button>
          ))}
        </div>
        <div className="toolkit__detail" aria-live="polite">
          {selected === null ? (
            <p className="toolkit__meta">Select an item to see its details.</p>
          ) : selected.kind === 'hook' ? (
            <>
              <h3>{selected.item.event}</h3>
              <p className="toolkit__meta">
                Matcher: {selected.item.matcher ?? 'any'} | Source: {selected.item.source}
              </p>
              <pre>{selected.item.command}</pre>
            </>
          ) : (
            <>
              <h3>{selected.item.name}</h3>
              <p>{selected.item.description}</p>
              <p className="toolkit__meta">
                {selected.kind === 'agent'
                  ? `Model: ${selected.item.model ?? 'default'} | Tools: ${selected.item.tools.join(', ') || 'all'} | `
                  : ''}
                Source: {selected.item.source}
              </p>
              <Markdown text={selected.item.body} />
            </>
          )}
        </div>
      </div>
    </section>
  )
}
