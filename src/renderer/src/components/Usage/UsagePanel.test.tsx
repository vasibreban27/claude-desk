// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { PlanUsage, UsageSummary } from '@shared/ipc'
import type { UseUsage } from '../../hooks/useUsage'
import type { UsePlanUsage } from '../../hooks/usePlanUsage'
import { UsagePanel, formatAgo, formatCost, formatResetIn } from './UsagePanel'

afterEach(cleanup)

const NOW = Date.parse('2026-11-19T12:00:00Z')

const full: UsageSummary = {
  days: 7,
  estimated: true,
  totals: { runs: 4, costUsd: 0.01234, inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 5000, cacheCreationTokens: 600 },
  byDay: [
    { day: '2026-11-15', runs: 3, costUsd: 0.01, inputTokens: 900, outputTokens: 1500, tokens: 7000 },
    { day: '2026-11-16', runs: 1, costUsd: 0.00234, inputTokens: 100, outputTokens: 500, tokens: 1600 }
  ],
  byAgent: [
    { agent: 'main', steps: 3, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, approximate: false },
    { agent: 'reviewer', steps: 1, inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0, approximate: true }
  ],
  byKind: [
    { kind: 'worker', runs: 2, costUsd: 0.01, tokens: 6000 },
    { kind: 'chat', runs: 2, costUsd: 0.00234, tokens: 2600 }
  ],
  byProject: [{ projectId: 'p1', runs: 4, costUsd: 0.01234 }]
}

function props(over: Partial<UseUsage> = {}): UseUsage {
  return {
    summary: full,
    loading: false,
    error: null,
    days: 7,
    scope: 'project',
    hasProject: true,
    setDays: vi.fn(),
    setScope: vi.fn(),
    ...over
  }
}

const planUsage: PlanUsage = {
  status: 'ok',
  limits: [
    { kind: 'session', label: 'Current session (5-hour window)', percent: 42, resetsAt: '2026-11-19T14:30:00Z', severity: null },
    { kind: 'weekly_all', label: 'This week, all models', percent: 93, resetsAt: '2026-11-22T12:00:00Z', severity: 'warning' }
  ],
  extraUsage: { enabled: true, usedCredits: 1250, monthlyLimit: 5000, percent: 25, currency: 'USD' },
  text: null,
  fetchedAt: '2026-11-19T11:57:00Z'
}

const plan = (over: Partial<UsePlanUsage> = {}): UsePlanUsage => ({ usage: planUsage, loading: false, error: null, refresh: vi.fn(), ...over })

describe('UsagePanel: plan card', () => {
  it('shows each plan meter with percent, level and reset time, plus extra usage', () => {
    render(<UsagePanel {...props()} plan={plan()} now={() => NOW} />)
    const card = screen.getByRole('region', { name: 'Your Claude plan' })
    const session = within(card).getByRole('meter', { name: 'Current session (5-hour window)' })
    expect(session).toHaveAttribute('aria-valuenow', '42')
    expect(session).toHaveAttribute('data-level', 'ok')
    expect(within(card).getByRole('meter', { name: 'This week, all models' })).toHaveAttribute('data-level', 'high')
    expect(within(card).getByText('42% used')).toBeInTheDocument()
    expect(within(card).getByText(/resets in 2 h 30 min/)).toBeInTheDocument()
    expect(within(card).getByText(/resets in 3 days/)).toBeInTheDocument()
    expect(within(card).getByText('$12.50 of $50.00')).toBeInTheDocument()
    expect(within(card).getByText('Checked 3 min ago')).toBeInTheDocument()
  })

  it('refreshes on click and shows checking state', () => {
    const p = plan()
    const { rerender } = render(<UsagePanel {...props()} plan={p} now={() => NOW} />)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(p.refresh).toHaveBeenCalledOnce()
    rerender(<UsagePanel {...props()} plan={plan({ loading: true })} now={() => NOW} />)
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled()
  })

  it('explains a login without plan limits, shows text-only reports and errors', () => {
    const { rerender } = render(
      <UsagePanel {...props()} plan={plan({ usage: { ...planUsage, status: 'unavailable', limits: [], extraUsage: null } })} now={() => NOW} />
    )
    expect(screen.getByText(/No plan limits for this login/)).toBeInTheDocument()
    rerender(
      <UsagePanel {...props()} plan={plan({ usage: { ...planUsage, status: 'text-only', limits: [], extraUsage: null, text: 'Session: 42%' } })} now={() => NOW} />
    )
    expect(screen.getByText('Session: 42%')).toBeInTheDocument()
    rerender(<UsagePanel {...props()} plan={plan({ usage: null, error: 'Could not read your plan usage.' })} now={() => NOW} />)
    expect(within(screen.getByRole('region', { name: 'Your Claude plan' })).getByRole('alert')).toHaveTextContent('Could not read')
  })

  it('has no plan card without plan data source', () => {
    render(<UsagePanel {...props()} />)
    expect(screen.queryByRole('region', { name: 'Your Claude plan' })).toBeNull()
  })
})

describe('UsagePanel: app usage', () => {
  it('shows plain totals, the API-price note and where the tokens went', () => {
    render(<UsagePanel {...props()} />)
    const app = screen.getByRole('region', { name: 'In claude-desk' })
    expect(within(app).getByText('8.6K')).toBeInTheDocument()
    expect(within(app).getByText('$0.01')).toBeInTheDocument()
    expect(within(app).getByText(/Not charged on a Pro\/Max plan/)).toBeInTheDocument()
    const kinds = within(app).getByRole('list', { name: 'Tokens by kind of work' })
    expect(kinds).toHaveTextContent('Pipeline workers')
    expect(kinds).toHaveTextContent('6K (70%, 2 sessions)')
    expect(kinds).toHaveTextContent('Chat')
    expect(within(app).getByRole('list', { name: 'Tokens by day' }).querySelectorAll('li')).toHaveLength(2)
  })

  it('keeps raw token numbers and tables in the details, with the project table for all projects', () => {
    const { rerender } = render(<UsagePanel {...props()} />)
    expect(screen.getByText('Details for this period')).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'By agent', hidden: true })).toBeInTheDocument()
    expect(screen.getByText('~7')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'By project', hidden: true })).toBeNull()
    rerender(<UsagePanel {...props({ scope: 'all' })} projectNames={{ p1: 'alpha' }} />)
    expect(screen.getByRole('table', { name: 'By project', hidden: true })).toHaveTextContent('alpha')
  })

  it('shows empty, error, loading and refreshing states', () => {
    const { rerender } = render(<UsagePanel {...props({ summary: { ...full, totals: { ...full.totals, runs: 0 } } })} />)
    expect(screen.getByText('Nothing ran in this period.')).toBeInTheDocument()
    rerender(<UsagePanel {...props({ error: 'Could not load usage.' })} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load usage.')
    rerender(<UsagePanel {...props({ summary: null, loading: true })} />)
    expect(screen.getByText(/Loading usage/)).toBeInTheDocument()
    rerender(<UsagePanel {...props({ loading: true })} />)
    expect(screen.getByText(/Refreshing/)).toBeInTheDocument()
  })

  it('changes period and scope; the project scope needs a project', () => {
    const p = props()
    const { rerender } = render(<UsagePanel {...p} />)
    expect(screen.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    expect(p.setDays).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }))
    expect(p.setScope).toHaveBeenCalledWith('all')
    rerender(<UsagePanel {...props({ hasProject: false, scope: 'all' })} />)
    expect(screen.getByRole('button', { name: 'This project' })).toBeDisabled()
  })
})

describe('formatters', () => {
  it('formats reset times, ages and costs', () => {
    expect(formatResetIn('2026-11-19T12:20:00Z', NOW)).toBe('in 20 min')
    expect(formatResetIn('2026-11-19T15:00:00Z', NOW)).toBe('in 3 h')
    expect(formatResetIn('2026-11-19T11:00:00Z', NOW)).toBe('now')
    expect(formatAgo('2026-11-19T11:59:40Z', NOW)).toBe('just now')
    expect(formatAgo('2026-11-19T09:00:00Z', NOW)).toBe('3 h ago')
    expect(formatCost(12.345)).toBe('$12.35')
    expect(formatCost(0.0012)).toBe('$0.0012')
  })
})
