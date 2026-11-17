// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { PipelineRunView, PlanEntry } from '@shared/ipc'
import { PipelinePanel, type PipelinePanelProps } from './PipelinePanel'

afterEach(cleanup)

const plan = (over: Partial<PlanEntry> = {}): PlanEntry => ({
  file: 'a.md',
  title: 'Alpha',
  format: 'flow-plan/1',
  ok: true,
  taskCount: 3,
  waveCount: 2,
  errorCount: 0,
  errors: [],
  ...over
})

const run = (over: Partial<PipelineRunView> = {}): PipelineRunView => ({
  runId: 'r1',
  planFile: 'a.md',
  status: 'running',
  active: true,
  baseBranch: 'main',
  integrationBranch: 'run/r1',
  createdAt: '2026-01-01T10:00:00.000Z',
  finishedAt: null,
  tasks: [
    {
      taskId: 'T1',
      title: 'First',
      worker: 'w',
      wave: 1,
      dependsOn: [],
      status: 'done',
      reason: null,
      commit: 'abc1234',
      checks: 'passed',
      turns: 3,
      costUsd: 0.5,
      durationMs: 65000
    },
    {
      taskId: 'T2',
      title: 'Second',
      worker: 'w',
      wave: 2,
      dependsOn: ['T1'],
      status: 'failed',
      reason: 'tests failed',
      commit: null,
      checks: null,
      turns: null,
      costUsd: null,
      durationMs: null
    }
  ],
  ...over
})

function props(over: Partial<PipelinePanelProps> = {}): PipelinePanelProps {
  return {
    plans: [plan()],
    plansLoading: false,
    plansError: null,
    run: null,
    runLoading: false,
    runError: null,
    starting: false,
    startError: null,
    cancelling: false,
    cancelError: null,
    start: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    ...over
  }
}

describe('PipelinePanel', () => {
  it('shows plan name, badge and counts, and starts with the file name', () => {
    const p = props()
    render(<PipelinePanel {...p} />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('flow-plan/1')).toBeInTheDocument()
    expect(screen.getByText(/3 tasks/)).toBeInTheDocument()
    expect(screen.getByText(/2 waves/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start a.md' }))
    expect(p.start).toHaveBeenCalledWith('a.md')
  })

  it('falls back to the file name and shows the legacy badge', () => {
    render(<PipelinePanel {...props({ plans: [plan({ title: null, format: 'legacy' })] })} />)
    expect(screen.getAllByText(/a\.md/).length).toBeGreaterThan(0)
    expect(screen.getByText('legacy')).toBeInTheDocument()
  })

  it('lists errors and disables Start for an invalid plan', () => {
    const errors = [{ line: 7, message: 'bad size' }]
    render(<PipelinePanel {...props({ plans: [plan({ ok: false, errorCount: 1, errors })] })} />)
    expect(screen.getByText('1 error')).toBeInTheDocument()
    expect(screen.getByText('line 7: bad size')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start a.md' })).toBeDisabled()
  })

  it('shows loading, empty and error states for plans', () => {
    const { rerender } = render(<PipelinePanel {...props({ plans: null, plansLoading: true })} />)
    expect(screen.getByText(/Loading plans/)).toBeInTheDocument()
    rerender(<PipelinePanel {...props({ plans: [] })} />)
    expect(screen.getByText(/No plans found/)).toBeInTheDocument()
    rerender(<PipelinePanel {...props({ plans: null, plansError: 'The plans folder could not be read.' })} />)
    expect(screen.getByRole('alert')).toHaveTextContent('could not be read')
  })

  it('shows start errors in an alert', () => {
    render(<PipelinePanel {...props({ startError: 'A run is already active for this project.' })} />)
    expect(screen.getByRole('alert')).toHaveTextContent('already active')
  })

  it('shows tasks by wave with details and the honest label', () => {
    render(<PipelinePanel {...props({ run: run() })} />)
    expect(screen.getByText('Wave 1')).toBeInTheDocument()
    expect(screen.getByText('Wave 2')).toBeInTheDocument()
    expect(screen.getByText('commit abc1234')).toBeInTheDocument()
    expect(screen.getByText('checks passed')).toBeInTheDocument()
    expect(screen.getByText('1 min 5 s')).toBeInTheDocument()
    expect(screen.getByText('~$0.5000')).toBeInTheDocument()
    expect(screen.getByText('tests failed')).toBeInTheDocument()
    expect(screen.getByText('Committed, not reviewed')).toBeInTheDocument()
  })

  it('says work is only merged into the run branch and does not call a done run finished', () => {
    render(<PipelinePanel {...props({ run: run({ status: 'done', active: false }) })} />)
    expect(screen.getByRole('status')).toHaveTextContent(/merged into run\/r1 only/)
    expect(screen.getByRole('status')).toHaveTextContent(/Nothing is merged into main or pushed/)
    expect(screen.getByText('tasks committed, not reviewed')).toBeInTheDocument()
    expect(screen.queryByText(/reviewed and|finished/i)).toBeNull()
  })

  it('cancels an active run and shows Cancelling...', () => {
    const p = props({ run: run() })
    const { rerender } = render(<PipelinePanel {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }))
    expect(p.cancel).toHaveBeenCalled()
    rerender(<PipelinePanel {...p} cancelling />)
    expect(screen.getByRole('button', { name: 'Cancelling...' })).toBeDisabled()
  })

  it('hides Cancel when the run is not active and shows cancel errors', () => {
    const { rerender } = render(<PipelinePanel {...props({ run: run({ status: 'done', active: false }) })} />)
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull()
    rerender(<PipelinePanel {...props({ run: run(), cancelError: 'The run is no longer active.' })} />)
    expect(screen.getByRole('alert')).toHaveTextContent('no longer active')
  })

  it('disables Start while a run is active', () => {
    render(<PipelinePanel {...props({ run: run() })} />)
    expect(screen.getByRole('button', { name: 'Start a.md' })).toBeDisabled()
  })
})
