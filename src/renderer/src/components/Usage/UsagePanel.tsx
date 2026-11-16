import { USAGE_RANGES, type UseUsage } from '../../hooks/useUsage'
import './usage.css'

export function formatCost(usd: number): string {
  return `~$${usd.toFixed(4)}`
}

const nf = new Intl.NumberFormat('en-US')
const n = (v: number): string => nf.format(v)

export interface UsagePanelProps extends UseUsage {
  /** Project id to display name, for the per-project table. */
  projectNames?: Record<string, string>
}

export function UsagePanel({
  summary,
  loading,
  error,
  days,
  scope,
  hasProject,
  setDays,
  setScope,
  projectNames = {}
}: UsagePanelProps) {
  const empty = summary !== null && summary.totals.runs === 0
  return (
    <section className="usage" aria-label="Usage">
      <div className="usage__controls">
        <fieldset className="usage__group">
          <legend>Range</legend>
          {USAGE_RANGES.map((d) => (
            <button key={d} type="button" className="usage__opt" aria-pressed={d === days} onClick={() => setDays(d)}>
              {d} days
            </button>
          ))}
        </fieldset>
        <fieldset className="usage__group">
          <legend>Scope</legend>
          <button
            type="button"
            className="usage__opt"
            aria-pressed={scope === 'project'}
            disabled={!hasProject}
            onClick={() => setScope('project')}
          >
            This project
          </button>
          <button type="button" className="usage__opt" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            All projects
          </button>
        </fieldset>
      </div>
      {error && (
        <p role="alert" className="usage__error">
          {error}
        </p>
      )}
      {loading && !summary && <p className="usage__status">Loading usage…</p>}
      {empty && <p className="usage__status">No runs in this period.</p>}
      {summary && !empty && (
        <>
          <dl className="usage__totals">
            <div className="usage__total">
              <dt>Runs</dt>
              <dd>{n(summary.totals.runs)}</dd>
            </div>
            <div className="usage__total">
              <dt>Cost</dt>
              <dd>{formatCost(summary.totals.costUsd)}</dd>
            </div>
            <div className="usage__total">
              <dt>Input tokens</dt>
              <dd>{n(summary.totals.inputTokens)}</dd>
            </div>
            <div className="usage__total">
              <dt>Output tokens</dt>
              <dd>{n(summary.totals.outputTokens)}</dd>
            </div>
            <div className="usage__total">
              <dt>Cache read</dt>
              <dd>{n(summary.totals.cacheReadTokens)}</dd>
            </div>
            <div className="usage__total">
              <dt>Cache write</dt>
              <dd>{n(summary.totals.cacheCreationTokens)}</dd>
            </div>
          </dl>
          <table className="usage__table">
            <caption>By day</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Runs</th>
                <th scope="col">Cost</th>
                <th scope="col">Input</th>
                <th scope="col">Output</th>
              </tr>
            </thead>
            <tbody>
              {summary.byDay.map((d) => (
                <tr key={d.day}>
                  <td>{d.day}</td>
                  <td>{n(d.runs)}</td>
                  <td>{formatCost(d.costUsd)}</td>
                  <td>{n(d.inputTokens)}</td>
                  <td>{n(d.outputTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="usage__table">
            <caption>By agent</caption>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Steps</th>
                <th scope="col">Input</th>
                <th scope="col">Output</th>
                <th scope="col">Cache read</th>
                <th scope="col">Cache write</th>
              </tr>
            </thead>
            <tbody>
              {summary.byAgent.map((a) => (
                <tr key={a.agent}>
                  <td>{a.agent}</td>
                  <td>{n(a.steps)}</td>
                  <td>{n(a.inputTokens)}</td>
                  <td>
                    {a.approximate ? (
                      <span title="Approximate: split from a shared total">
                        <span aria-hidden="true">~</span>
                        <span className="usage__sr">approximately </span>
                        {n(a.outputTokens)}
                      </span>
                    ) : (
                      n(a.outputTokens)
                    )}
                  </td>
                  <td>{n(a.cacheReadTokens)}</td>
                  <td>{n(a.cacheCreationTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {scope === 'all' && summary.byProject.length > 0 && (
            <table className="usage__table">
              <caption>By project</caption>
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">Runs</th>
                  <th scope="col">Cost</th>
                </tr>
              </thead>
              <tbody>
                {summary.byProject.map((p) => (
                  <tr key={p.projectId}>
                    <td>{projectNames[p.projectId] ?? p.projectId}</td>
                    <td>{n(p.runs)}</td>
                    <td>{formatCost(p.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <p className="usage__note">Costs are estimates, not billing figures.</p>
    </section>
  )
}
