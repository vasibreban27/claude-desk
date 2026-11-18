// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PipelineLogEntry } from '@shared/ipc'
import { PipelineLogFeed } from './PipelineLogFeed'

afterEach(cleanup)

const e = (seq: number, taskId: string | null, text: string, over: Partial<PipelineLogEntry> = {}): PipelineLogEntry => ({
  projectId: 'p',
  runId: 'r',
  seq,
  at: '2026-11-18T12:00:00.000Z',
  taskId,
  role: 'worker',
  agent: null,
  text,
  tone: 'info',
  ...over
})

describe('PipelineLogFeed', () => {
  it('shows an empty state', () => {
    render(<PipelineLogFeed entries={[]} />)
    expect(screen.getByText(/No pipeline activity yet/)).toBeInTheDocument()
  })

  it('lists lines with task and role, marks denials, and filters by task keeping run lines', () => {
    render(
      <PipelineLogFeed
        entries={[
          e(0, null, 'run started: 2 tasks in 1 wave', { role: 'pipeline' }),
          e(1, 'T1', 'Write app/db.py'),
          e(2, 'T2', 'Bash denied', { tone: 'denied' }),
          e(3, 'T1', 'review: 0 blocking, 1 minor', { role: 'reviewer', agent: 'reviewer' })
        ]}
      />
    )
    const list = screen.getByRole('list', { name: 'Pipeline activity' })
    expect(list).toHaveTextContent('Write app/db.py')
    expect(screen.getByText('Denied')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Filter by task'), { target: { value: 'T1' } })
    expect(list).not.toHaveTextContent('Bash denied')
    expect(list).toHaveTextContent('run started')
    expect(list).toHaveTextContent('review: 0 blocking, 1 minor')
  })
})
