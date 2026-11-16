// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ActivityEvent, ActivityEventBody } from '@shared/ipc'
import { ActivityFeed } from './ActivityFeed'

afterEach(cleanup)

const P = '11111111-1111-4111-8111-111111111111'

let n = 0
const ev = (body: ActivityEventBody, agent = 'main'): ActivityEvent => ({
  projectId: P,
  runId: 'r1',
  seq: n++,
  at: '2026-01-01T10:00:00.000+00:00',
  agent,
  agentId: agent === 'main' ? null : 'a1',
  ...body
})

const started = (id: string, tool: string, summary: string, agent = 'main') =>
  ev({ type: 'tool-started', toolUseId: id, tool, summary }, agent)
const finished = (id: string, tool: string, durationMs: number | null, denied = false, agent = 'main') =>
  ev({ type: 'tool-finished', toolUseId: id, tool, durationMs, denied }, agent)

const renderFeed = (events: ActivityEvent[], extra: Partial<Parameters<typeof ActivityFeed>[0]> = {}) =>
  render(<ActivityFeed hasProject loading={false} error={null} events={events} {...extra} />)

function row(i: number): HTMLElement {
  const el = screen.getAllByRole('listitem')[i]
  if (!el) throw new Error(`no row ${i}`)
  return el
}

describe('ActivityFeed', () => {
  it('shows the empty state', () => {
    renderFeed([])
    expect(screen.getByText('No activity yet. Start a chat run.')).toBeInTheDocument()
  })

  it('shows loading, error and no-project states', () => {
    const { rerender } = renderFeed([], { loading: true })
    expect(screen.getByText('Loading activity…')).toBeInTheDocument()
    rerender(<ActivityFeed hasProject loading={false} error="Could not load the activity." events={[]} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the activity.')
    rerender(<ActivityFeed hasProject={false} loading={false} error={null} events={[]} />)
    expect(screen.getByText(/Add or select a project/)).toBeInTheDocument()
  })

  it('merges a tool start and finish into one row with duration', () => {
    renderFeed([started('t1', 'Read', 'src/a.ts'), finished('t1', 'Read', 1500)])
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(row(0)).toHaveTextContent('main')
    expect(row(0)).toHaveTextContent('Read')
    expect(row(0)).toHaveTextContent('src/a.ts')
    expect(row(0)).toHaveTextContent('1.5 s')
    expect(within(row(0)).queryByText('running')).toBeNull()
  })

  it('marks subagent rows with a Subagent badge and indent class', () => {
    renderFeed([started('t1', 'Grep', 'foo', 'reviewer'), started('t2', 'Read', 'bar')])
    const sub = row(0)
    const main = row(1)
    expect(within(sub).getByText('Subagent')).toBeInTheDocument()
    expect(sub).toHaveClass('activity__row--sub')
    expect(within(main).queryByText('Subagent')).toBeNull()
  })

  it('shows running for an unfinished tool and Denied for a denied one', () => {
    renderFeed([started('t1', 'Read', ''), started('t2', 'Bash', ''), finished('t2', 'Bash', null, true)])
    const a = row(0)
    const b = row(1)
    expect(within(a).getByText('running')).toBeInTheDocument()
    expect(within(b).getByText('Denied')).toBeInTheDocument()
  })

  it('shows a footer with status and estimated cost on run-finished', () => {
    renderFeed([
      ev({ type: 'run-started' }),
      ev({ type: 'run-finished', status: 'success', costUsd: 0.0123, durationMs: 2000 })
    ])
    const footer = row(1)
    expect(footer).toHaveTextContent('Run finished')
    expect(footer).toHaveTextContent('~$0.0123')
  })

  it('shows ended instead of running for tools left open at run-finished', () => {
    renderFeed([
      started('t1', 'Read', 'x'),
      ev({ type: 'run-finished', status: 'error', costUsd: null, durationMs: null })
    ])
    const tool = row(0)
    const footer = row(1)
    expect(within(tool).getByText('ended')).toBeInTheDocument()
    expect(within(tool).queryByText('running')).toBeNull()
    expect(footer).toHaveTextContent('Run failed')
    expect(footer).toHaveTextContent('cost unknown')
    expect(footer).not.toHaveTextContent('(estimated)')
  })

  it('appends (estimated) only for a known cost', () => {
    renderFeed([ev({ type: 'run-finished', status: 'success', costUsd: 0.5, durationMs: 1 })])
    expect(row(0)).toHaveTextContent('~$0.5000 (estimated)')
  })

  it('does not jump when scrolled up, and offers a way back', () => {
    const base = [started('t1', 'Read', 'a')]
    const { rerender } = renderFeed(base)
    const log = screen.getByRole('log', { name: 'Activity' })
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 100 })
    log.scrollTop = 0
    fireEvent.scroll(log)
    rerender(<ActivityFeed hasProject loading={false} error={null} events={[...base, started('t2', 'Read', 'b')]} />)
    expect(log.scrollTop).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    expect(log.scrollTop).toBe(1000)
  })

  it('follows new rows while at the bottom', () => {
    const base = [started('t1', 'Read', 'a')]
    const { rerender } = renderFeed(base)
    const log = screen.getByRole('log', { name: 'Activity' })
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 500 })
    rerender(<ActivityFeed hasProject loading={false} error={null} events={[...base, started('t2', 'Read', 'b')]} />)
    expect(log.scrollTop).toBe(500)
  })
})
