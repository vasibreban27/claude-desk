// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { UsageSummary } from '@shared/ipc'
import type { UseUsage } from '../../hooks/useUsage'
import { UsagePanel } from './UsagePanel'

afterEach(cleanup)

const full: UsageSummary = {
  days: 30,
  estimated: true,
  totals: { runs: 4, costUsd: 0.01234, inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 5, cacheCreationTokens: 6 },
  byDay: [{ day: '2026-11-15', runs: 4, costUsd: 0.01234, inputTokens: 1000, outputTokens: 2000 }],
  byAgent: [
    { agent: 'main', steps: 3, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, approximate: false },
    { agent: 'reviewer', steps: 1, inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0, approximate: true }
  ],
  byProject: [{ projectId: 'p1', runs: 4, costUsd: 0.01234 }]
}

function props(over: Partial<UseUsage> = {}): UseUsage {
  return {
    summary: full,
    loading: false,
    error: null,
    days: 30,
    scope: 'project',
    hasProject: true,
    setDays: vi.fn(),
    setScope: vi.fn(),
    ...over
  }
}

describe('UsagePanel', () => {
  it('shows totals, tables, formatted costs and the estimate note', () => {
    render(<UsagePanel {...props()} />)
    expect(screen.getAllByText('~$0.0123').length).toBeGreaterThan(0)
    expect(screen.getByRole('table', { name: 'By day' })).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'By agent' })).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'By project' })).not.toBeInTheDocument()
    expect(screen.getByText(/estimates/i)).toBeInTheDocument()
  })

  it('shows the per-project table in all-projects scope', () => {
    render(<UsagePanel {...props({ scope: 'all' })} projectNames={{ p1: 'alpha' }} />)
    expect(screen.getByRole('table', { name: 'By project' })).toBeInTheDocument()
    expect(screen.getByText('alpha')).toBeInTheDocument()
  })

  it('marks approximate output tokens with an accessible description', () => {
    render(<UsagePanel {...props()} />)
    const cell = screen.getByText('approximately', { exact: false }).closest('td')
    expect(cell).toHaveTextContent('~approximately 7')
    expect(screen.getByTitle(/approximate/i)).toBeInTheDocument()
  })

  it('shows the empty state', () => {
    render(<UsagePanel {...props({ summary: { ...full, totals: { ...full.totals, runs: 0 } } })} />)
    expect(screen.getByText('No runs in this period.')).toBeInTheDocument()
  })

  it('shows an alert on error and keeps previous data', () => {
    render(<UsagePanel {...props({ error: 'Could not load usage.' })} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load usage.')
    expect(screen.getByRole('table', { name: 'By day' })).toBeInTheDocument()
  })

  it('shows loading when there is no data yet', () => {
    render(<UsagePanel {...props({ summary: null, loading: true })} />)
    expect(screen.getByText(/Loading usage/)).toBeInTheDocument()
  })

  it('shows a Refreshing indicator while loading with data', () => {
    render(<UsagePanel {...props({ loading: true })} />)
    expect(screen.getByText(/Refreshing/)).toBeInTheDocument()
    expect(screen.queryByText(/Loading usage/)).toBeNull()
  })

  it('changes range and scope through the controls', () => {
    const p = props()
    render(<UsagePanel {...p} />)
    expect(screen.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '7 days' }))
    expect(p.setDays).toHaveBeenCalledWith(7)
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }))
    expect(p.setScope).toHaveBeenCalledWith('all')
  })

  it('disables the project scope without a selected project', () => {
    render(<UsagePanel {...props({ hasProject: false, scope: 'all' })} />)
    expect(screen.getByRole('button', { name: 'This project' })).toBeDisabled()
  })
})
