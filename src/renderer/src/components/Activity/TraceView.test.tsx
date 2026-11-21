// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { TraceEvent, TraceRun } from '@shared/ipc'
import { TraceView } from './TraceView'

afterEach(cleanup)

const RUN: TraceRun = { runId: 'r1', projectId: 'p', source: 'pipeline', title: 'todo.md', startedAt: 1, endedAt: null, status: 'running', events: 5 }
const OTHER: TraceRun = { ...RUN, runId: 'r0', source: 'chat', title: 'hello', status: 'ok' }

let seq = 0
const base = (over: Partial<TraceEvent> = {}) => ({
  projectId: 'p',
  runId: 'r1',
  seq: seq++,
  at: '2026-11-20T10:00:00.000Z',
  taskId: 'T1',
  role: 'worker' as const,
  session: 'worker',
  agent: 'node-developer',
  parentId: null,
  ...over
})

function events(): TraceEvent[] {
  seq = 0
  return [
    { ...base(), kind: 'text', text: 'Adding the endpoint.' },
    { ...base(), kind: 'tool', toolUseId: 'e', tool: 'Edit', summary: 'src/app.ts', input: 'file_path: src/app.ts', diff: '- old\n+ new', added: 1, removed: 1 },
    { ...base(), kind: 'result', toolUseId: 'e', ok: true, denied: false, output: 'updated', durationMs: 40 },
    { ...base(), kind: 'tool', toolUseId: 'c', tool: 'mcp__work__run_check', summary: 'npm test', input: 'npm test', diff: null, added: 0, removed: 0 },
    { ...base(), kind: 'result', toolUseId: 'c', ok: false, denied: false, output: '1 test failed', durationMs: 12_000 },
    { ...base(), kind: 'turn', ok: true, turns: 6, durationMs: 63_000, inputTokens: 1000, outputTokens: 500, cacheTokens: 3000, costUsd: 0.12 },
    { ...base({ role: 'pipeline', session: 'pipeline', agent: 'pipeline' }), kind: 'note', text: 'checks failed', tone: 'error' }
  ] as TraceEvent[]
}

function show(over: Partial<Parameters<typeof TraceView>[0]> = {}) {
  const select = vi.fn()
  render(<TraceView runs={[RUN, OTHER]} runId="r1" events={events()} loading={false} error={null} select={select} {...over} />)
  return { select }
}

describe('TraceView', () => {
  it('shows an empty state when there are no runs', () => {
    render(<TraceView runs={[]} runId={null} events={[]} loading={false} error={null} select={vi.fn()} />)
    expect(screen.getByText(/Nothing in the last 2 days/)).toBeInTheDocument()
  })

  it('shows one line per step like the CLI, with the session footer and pipeline notes', () => {
    show()
    expect(screen.getByRole('region', { name: 'Task T1' })).toBeInTheDocument()
    expect(screen.getByText('Adding the endpoint.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Edit src\/app\.ts/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /run_check npm test/ })).toBeInTheDocument()
    expect(screen.getByText('Finished · 6 turns · 1m 03s · 4.5k tokens · $0.12')).toBeInTheDocument()
    expect(screen.getByText('checks failed')).toBeInTheDocument()
    expect(screen.getByText('Live')).toBeInTheDocument()
  })

  it('expands a row to show the diff, or the input and output', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: /Edit src\/app\.ts/ }))
    expect(screen.getByLabelText('Changes')).toHaveTextContent('- old + new')
    fireEvent.click(screen.getByRole('button', { name: /run_check npm test/ }))
    expect(screen.getByLabelText('Input')).toHaveTextContent('npm test')
    expect(screen.getAllByLabelText('Output').map((el) => el.textContent)).toEqual(['updated', '1 test failed'])
  })

  it('filters to errors only', () => {
    show()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Errors only' }))
    expect(screen.queryByText('Adding the endpoint.')).toBeNull()
    expect(screen.queryByRole('button', { name: /Edit src/ })).toBeNull()
    expect(screen.getByRole('button', { name: /run_check/ })).toBeInTheDocument()
    expect(screen.getByText('checks failed')).toBeInTheDocument()
  })

  it('says when nothing matches the filters', () => {
    show({ events: events().filter((e) => e.kind !== 'result' && e.kind !== 'note') })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Errors only' }))
    expect(screen.getByText('Nothing matches these filters.')).toBeInTheDocument()
  })

  it('switches runs from the picker', () => {
    const { select } = show()
    const picker = screen.getByRole('combobox', { name: 'Run' })
    expect(within(picker).getAllByRole('option')).toHaveLength(2)
    fireEvent.change(picker, { target: { value: 'r0' } })
    expect(select).toHaveBeenCalledWith('r0')
  })

  it('shows a load error', () => {
    show({ error: 'Could not load the activity.' })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the activity.')
  })
})
