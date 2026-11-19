import type { PlanLimit, PlanUsage, UsageKind, UsageSummary } from '@shared/ipc'
import { USAGE_RANGES, type UseUsage, type UsageRange } from '../../hooks/useUsage'
import type { UsePlanUsage } from '../../hooks/usePlanUsage'
import './usage.css'

const nf = new Intl.NumberFormat('en-US')
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
/** Full number, e.g. 1,234,567. */
export const n = (v: number): string => nf.format(v)
/** Short number, e.g. 1.2M. */
export const short = (v: number): string => compact.format(v)

export function formatCost(usd: number): string {
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(usd >= 0.01 ? 2 : 4)}`
}

const RANGE_LABELS: Record<UsageRange, string> = { 1: 'Today', 7: '7 days', 30: '30 days' }

export const KIND_LABELS: Record<UsageKind, { label: string; hint: string }> = {
  chat: { label: 'Chat', hint: 'Questions in the read-only chat' },
  plan: { label: 'Planner', hint: 'Plan mode: the Opus planner writing plans' },
  worker: { label: 'Pipeline workers', hint: 'Agents writing code for plan tasks, including fix rounds' },
  reviewer: { label: 'Reviewers', hint: 'Agents reviewing each task before it is merged' }
}

/** "in 2 h 10 min", "in 3 days", "now". */
export function formatResetIn(iso: string, now: number): string {
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms) || ms <= 0) return 'now'
  const min = Math.round(ms / 60000)
  if (min < 60) return `in ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `in ${h} h${min % 60 ? ` ${min % 60} min` : ''}`
  const d = Math.round(h / 24)
  return `in ${d} ${d === 1 ? 'day' : 'days'}`
}

/** "just now", "3 min ago", "2 h ago". */
export function formatAgo(iso: string, now: number): string {
  const min = Math.floor((now - Date.parse(iso)) / 60000)
  if (Number.isNaN(min) || min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  return `${Math.floor(min / 60)} h ago`
}

const level = (percent: number): 'ok' | 'warn' | 'high' => (percent >= 90 ? 'high' : percent >= 70 ? 'warn' : 'ok')

function Meter({ label, percent, tone }: { label: string; percent: number; tone?: 'ok' | 'warn' | 'high' | 'neutral' }) {
  const p = Math.max(0, Math.min(100, percent))
  return (
    <div
      className="usage__meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p)}
      data-level={tone ?? level(p)}
    >
      <span className="usage__meter-fill" style={{ width: `${p}%` }} />
    </div>
  )
}

function LimitRow({ limit, now }: { limit: PlanLimit; now: number }) {
  const resets =
    limit.resetsAt !== null
      ? `resets ${formatResetIn(limit.resetsAt, now)} (${new Date(limit.resetsAt).toLocaleString(undefined, {
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit'
        })})`
      : null
  return (
    <li className="usage__limit">
      <div className="usage__limit-head">
        <span className="usage__limit-label">{limit.label}</span>
        <span className="usage__limit-value">{Math.round(limit.percent)}% used</span>
      </div>
      <Meter label={limit.label} percent={limit.percent} />
      {resets && <p className="usage__hint">{resets}</p>}
    </li>
  )
}

function money(minor: number, currency: string | null): string {
  const value = minor / 100
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency ?? 'USD' }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency ?? ''}`.trim()
  }
}

function PlanSection({ plan, now }: { plan: UsePlanUsage; now: number }) {
  const u: PlanUsage | null = plan.usage
  return (
    <section className="usage__card" aria-labelledby="usage-plan-title">
      <div className="usage__card-head">
        <div>
          <h3 id="usage-plan-title">Your Claude plan</h3>
          <p className="usage__hint">
            Same numbers as <code>/usage</code> in Claude Code. They cover your whole account, not only this app.
          </p>
        </div>
        <div className="usage__card-actions">
          {u && <span className="usage__hint">Checked {formatAgo(u.fetchedAt, now)}</span>}
          <button type="button" className="usage__opt" onClick={plan.refresh} disabled={plan.loading}>
            {plan.loading ? 'Checking…' : 'Refresh'}
          </button>
        </div>
      </div>
      {plan.error && (
        <p role="alert" className="usage__error">
          {plan.error}
        </p>
      )}
      {!u && plan.loading && <p className="usage__status">Checking your plan…</p>}
      {u?.status === 'ok' && (
        <>
          {u.limits.length > 0 ? (
            <ul className="usage__limits">
              {u.limits.map((l) => (
                <LimitRow key={`${l.kind}:${l.label}`} limit={l} now={now} />
              ))}
            </ul>
          ) : (
            <p className="usage__status">Your plan reports no usage limits.</p>
          )}
          {u.extraUsage?.enabled && (
            <div className="usage__limit">
              <div className="usage__limit-head">
                <span className="usage__limit-label">Extra usage this month</span>
                <span className="usage__limit-value">
                  {u.extraUsage.usedCredits !== null ? money(u.extraUsage.usedCredits, u.extraUsage.currency) : '—'}
                  {u.extraUsage.monthlyLimit !== null ? ` of ${money(u.extraUsage.monthlyLimit, u.extraUsage.currency)}` : ''}
                </span>
              </div>
              {u.extraUsage.percent !== null && <Meter label="Extra usage this month" percent={u.extraUsage.percent} />}
              <p className="usage__hint">Paid usage beyond your plan, charged to your account.</p>
            </div>
          )}
        </>
      )}
      {u?.status === 'text-only' && <pre className="usage__text">{u.text}</pre>}
      {u?.status === 'unavailable' && (
        <p className="usage__status">
          No plan limits for this login. They show for Claude Pro and Max logins; an API-key login is billed per token in
          the Anthropic Console instead.
        </p>
      )}
    </section>
  )
}

function Bars({ rows, label }: { rows: { key: string; name: string; hint?: string; value: number; extra?: string }[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  const total = rows.reduce((a, r) => a + r.value, 0)
  return (
    <ul className="usage__bars" aria-label={label}>
      {rows.map((r) => {
        const share = total > 0 ? Math.round((r.value / total) * 100) : 0
        return (
          <li key={r.key} className="usage__bar-row">
            <span className="usage__bar-name" title={r.hint}>
              {r.name}
            </span>
            <span className="usage__bar-track" aria-hidden="true">
              <span className="usage__bar-fill" style={{ width: `${(r.value / max) * 100}%` }} />
            </span>
            <span className="usage__bar-value">
              {short(r.value)} <span className="usage__hint">({share}%{r.extra ? `, ${r.extra}` : ''})</span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function shortDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  if (!y || !m || !d) return day
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
}

function Details({ summary, projectNames, scope }: { summary: UsageSummary; projectNames: Record<string, string>; scope: string }) {
  const t = summary.totals
  return (
    <details className="usage__details">
      <summary>Details for this period</summary>
      <dl className="usage__glossary">
        <div>
          <dt>New input</dt>
          <dd>
            {n(t.inputTokens)} <span className="usage__hint">text sent to the model for the first time</span>
          </dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd>
            {n(t.outputTokens)} <span className="usage__hint">text the model wrote (the most expensive kind)</span>
          </dd>
        </div>
        <div>
          <dt>Cache reads</dt>
          <dd>
            {n(t.cacheReadTokens)} <span className="usage__hint">context re-read from cache, about 10% of the input price</span>
          </dd>
        </div>
        <div>
          <dt>Cache writes</dt>
          <dd>
            {n(t.cacheCreationTokens)} <span className="usage__hint">context saved to the cache for later turns</span>
          </dd>
        </div>
      </dl>
      {summary.byAgent.length > 0 && (
        <table className="usage__table">
          <caption>By agent</caption>
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Sessions</th>
              <th scope="col">Input</th>
              <th scope="col">Output</th>
              <th scope="col">Cache reads</th>
            </tr>
          </thead>
          <tbody>
            {summary.byAgent.map((a) => (
              <tr key={a.agent}>
                <td>{a.agent}</td>
                <td>{n(a.steps)}</td>
                <td>{short(a.inputTokens)}</td>
                <td>{a.approximate ? `~${short(a.outputTokens)}` : short(a.outputTokens)}</td>
                <td>{short(a.cacheReadTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {scope === 'all' && summary.byProject.length > 0 && (
        <table className="usage__table">
          <caption>By project</caption>
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Sessions</th>
              <th scope="col">API-price value</th>
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
    </details>
  )
}

export interface UsagePanelProps extends UseUsage {
  /** Project id to display name, for the per-project table. */
  projectNames?: Record<string, string>
  /** Plan limits; the plan card is hidden without it. */
  plan?: UsePlanUsage
  now?: () => number
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
  projectNames = {},
  plan,
  now = Date.now
}: UsagePanelProps) {
  const t = now()
  const empty = summary !== null && summary.totals.runs === 0
  const totals = summary?.totals
  const totalTokens = totals ? totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens : 0
  return (
    <section className="usage" aria-label="Usage">
      {plan && <PlanSection plan={plan} now={t} />}

      <section className="usage__card" aria-labelledby="usage-app-title">
        <div className="usage__card-head">
          <div>
            <h3 id="usage-app-title">In claude-desk</h3>
            <p className="usage__hint">Work this app ran for you: chats, the planner and pipeline runs.</p>
          </div>
        </div>
        <div className="usage__controls">
          <div className="usage__group" role="group" aria-label="Period">
            {USAGE_RANGES.map((d) => (
              <button key={d} type="button" className="usage__opt" aria-pressed={d === days} onClick={() => setDays(d)}>
                {RANGE_LABELS[d]}
              </button>
            ))}
          </div>
          <div className="usage__group" role="group" aria-label="Projects">
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
          </div>
        </div>
        {error && (
          <p role="alert" className="usage__error">
            {error}
          </p>
        )}
        {loading && !summary && <p className="usage__status">Loading usage…</p>}
        {empty && <p className="usage__status">Nothing ran in this period.</p>}
        {summary && totals && !empty && (
          <>
            <dl className="usage__totals">
              <div className="usage__total">
                <dt>Tokens used</dt>
                <dd title={n(totalTokens)}>{short(totalTokens)}</dd>
              </div>
              <div className="usage__total">
                <dt>Agent sessions</dt>
                <dd>{n(totals.runs)}</dd>
              </div>
              <div className="usage__total">
                <dt>API-price value</dt>
                <dd>{formatCost(totals.costUsd)}</dd>
                <p className="usage__hint">What these tokens would cost on the API. Not charged on a Pro/Max plan.</p>
              </div>
            </dl>

            {summary.byKind.length > 0 && (
              <div>
                <h4 className="usage__subhead">Where the tokens went</h4>
                <Bars
                  label="Tokens by kind of work"
                  rows={summary.byKind.map((k) => ({
                    key: k.kind,
                    name: KIND_LABELS[k.kind].label,
                    hint: KIND_LABELS[k.kind].hint,
                    value: k.tokens,
                    extra: `${n(k.runs)} ${k.runs === 1 ? 'session' : 'sessions'}`
                  }))}
                />
              </div>
            )}

            {summary.byDay.length > 1 && (
              <div>
                <h4 className="usage__subhead">By day</h4>
                <Bars
                  label="Tokens by day"
                  rows={summary.byDay.map((d) => ({ key: d.day, name: shortDay(d.day), value: d.tokens }))}
                />
              </div>
            )}

            <Details summary={summary} projectNames={projectNames} scope={scope} />
          </>
        )}
        {loading && summary && (
          <p role="status" className="usage__status">
            Refreshing…
          </p>
        )}
      </section>
    </section>
  )
}
