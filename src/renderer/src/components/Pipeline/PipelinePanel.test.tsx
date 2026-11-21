// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
      durationMs: 65000,
      stage: null,
      fixRounds: null,
      findings: null
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
      durationMs: null,
      stage: null,
      fixRounds: null,
      findings: null
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
    discarding: false,
    discardError: null,
    discard: vi.fn(async () => true),
    ...over
  }
}

const finished = () => run({ status: 'done', active: false })

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
    expect(screen.getByText('Merged, not reviewed')).toBeInTheDocument()
  })

  it('labels a done task with review findings as reviewed', () => {
    const base = run()
    const tasks = base.tasks.map((t) =>
      t.status === 'done' ? { ...t, findings: { blocking: 0, minor: 1, items: [] } } : t
    )
    render(<PipelinePanel {...props({ run: { ...base, tasks } })} />)
    expect(screen.getByText('Reviewed and merged')).toBeInTheDocument()
    expect(screen.queryByText('Merged, not reviewed')).toBeNull()
  })

  it('says work is only merged into the run branch while a run is not finished', () => {
    render(<PipelinePanel {...props({ run: run({ status: 'failed', active: false }) })} />)
    expect(screen.getByRole('status')).toHaveTextContent(/merged into run\/r1 only/)
    expect(screen.getByRole('status')).toHaveTextContent(/Nothing is merged into main or pushed/)
    expect(screen.queryByRole('region', { name: 'Run finished' })).toBeNull()
  })

  it('saves a done run as a feature branch and shows where it went', async () => {
    const pipelineBranch = vi.fn().mockResolvedValue({ ok: true, branch: 'feature/x', head: 'def5678', created: true, cleanedUp: true })
    ;(window as unknown as { api: unknown }).api = { pipelineBranch }
    const done = run({ status: 'done', active: false })
    render(<PipelinePanel {...props({ run: done })} projectId="p1" />)
    expect(screen.queryByRole('button', { name: 'Merge into main' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save as branch…' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Save as branch' })
    fireEvent.change(within(dialog).getByLabelText('Branch name'), { target: { value: 'feature/x' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save branch' }))
    expect(await screen.findByRole('status', { name: 'Saved as branch' })).toHaveTextContent(/Saved as new branch feature\/x at def5678/)
    expect(pipelineBranch).toHaveBeenCalledWith({ projectId: 'p1', runId: done.runId, branch: 'feature/x' })
    expect(screen.queryByRole('region', { name: 'Run finished' })).toBeNull()
  })

  it('shows Run finished for a done run and merges into main only after confirming', async () => {
    const pipelineMerge = vi.fn().mockResolvedValue({ ok: true, baseBranch: 'main', head: 'abc1234', planCommitted: true, cleanedUp: true })
    ;(window as unknown as { api: unknown }).api = { pipelineMerge }
    const done = { ...run({ status: 'done', active: false }), allowBaseMerge: true }
    render(<PipelinePanel {...props({ run: done })} projectId="p1" />)
    expect(screen.getByRole('region', { name: 'Run finished' })).toHaveTextContent(/Run finished/)
    fireEvent.click(screen.getByRole('button', { name: 'Merge into main' }))
    expect(pipelineMerge).not.toHaveBeenCalled()
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm merge' })
    expect(dialog).toHaveTextContent(/Nothing is pushed/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge into main' }))
    expect(await screen.findByRole('status', { name: 'Merged' })).toHaveTextContent(/Merged into main at abc1234, plan committed/)
    expect(pipelineMerge).toHaveBeenCalledWith({ projectId: 'p1', runId: done.runId })
    expect(screen.queryByRole('region', { name: 'Run finished' })).toBeNull()
  })

  it('shows why a merge was refused and keeps the run', async () => {
    const pipelineMerge = vi.fn().mockResolvedValue({ ok: false, error: 'dirty' })
    ;(window as unknown as { api: unknown }).api = { pipelineMerge }
    render(<PipelinePanel {...props({ run: { ...run({ status: 'done', active: false }), allowBaseMerge: true } })} projectId="p1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Merge into main' }))
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Confirm merge' })).getByRole('button', { name: 'Merge into main' }))
    expect(await screen.findByText('The project has uncommitted changes.')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Run finished' })).toBeInTheDocument()
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

  it('offers Resume on a stopped run with unfinished tasks and says what it keeps', () => {
    const resume = vi.fn(async () => {})
    const { rerender } = render(<PipelinePanel {...props({ run: run(), resume })} />)
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
    rerender(<PipelinePanel {...props({ run: run({ status: 'failed', active: false }), resume })} />)
    expect(screen.getByText(/keeps the 1 task already merged into/)).toHaveTextContent('runs only the other 1')
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(resume).toHaveBeenCalledOnce()
    rerender(<PipelinePanel {...props({ run: run({ status: 'failed', active: false }), resume, starting: true })} />)
    expect(screen.getByRole('button', { name: 'Resuming...' })).toBeDisabled()
    rerender(<PipelinePanel {...props({ run: finished(), resume })} />)
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
    rerender(<PipelinePanel {...props({ run: run({ status: 'cancelled', active: false }) })} />)
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  })

  it('shows Discard only when the run is not active', () => {
    const { rerender } = render(<PipelinePanel {...props({ run: run() })} />)
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
    rerender(<PipelinePanel {...props({ run: finished() })} />)
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
  })

  it('confirms with the branches named and Cancel does not call the API', () => {
    const p = props({ run: finished() })
    render(<PipelinePanel {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('run/r1')
    expect(dialog).toHaveTextContent('task/r1-t1')
    expect(dialog).toHaveTextContent('task/r1-t2')
    expect(dialog).toHaveTextContent(/Commits on these branches are lost/)
    expect(dialog).toHaveTextContent(/main is not touched/)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(p.discard).not.toHaveBeenCalled()
  })

  it('discards on confirm and focuses the plans heading', async () => {
    const p = props({ run: finished() })
    render(<PipelinePanel {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard' }))
    expect(p.discard).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Plans' })).toHaveFocus())
  })

  it('disables the buttons while discarding so a double click calls once', () => {
    const p = props({ run: finished(), discarding: true })
    const { rerender } = render(<PipelinePanel {...props({ run: finished() })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    rerender(<PipelinePanel {...p} />)
    const btn = screen.getByRole('button', { name: 'Discarding...' })
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(p.discard).not.toHaveBeenCalled()
  })

  it('shows a discard error in an alert and keeps the run visible', () => {
    render(<PipelinePanel {...props({ run: finished(), discardError: 'Some worktrees could not be removed.' })} />)
    expect(screen.getByRole('alert')).toHaveTextContent('could not be removed')
    expect(screen.getByRole('region', { name: 'Latest run' })).toBeInTheDocument()
  })

  it('disables Start while a run is active', () => {
    render(<PipelinePanel {...props({ run: run() })} />)
    expect(screen.getByRole('button', { name: 'Start a.md' })).toBeDisabled()
  })

  it('summarizes task states and total cost, with parallel running tasks', () => {
    const base = run().tasks[0]!
    const t = (
      taskId: string,
      status: PipelineRunView['tasks'][number]['status'],
      costUsd: number | null
    ): PipelineRunView['tasks'][number] => ({
      ...base,
      taskId,
      title: `Title ${taskId}`,
      status,
      costUsd
    })
    const tasks = [t('T1', 'done', 0.5), t('T2', 'running', 0.25), t('T3', 'running', null), t('T4', 'queued', null)]
    render(<PipelinePanel {...props({ run: run({ tasks: tasks.map((x) => ({ ...x, wave: 1 })) }) })} />)
    expect(screen.getByLabelText('Run summary')).toHaveTextContent('2 running, 1 queued, 1 done · ~$0.7500 total')
    expect(screen.getAllByText('running', { selector: '.pipeline__task .pipeline__status' })).toHaveLength(2)
  })

  it('shows the stage and round next to the status of a running task', () => {
    const base = run().tasks[0]!
    const task = { ...base, status: 'running' as const, stage: 'fixing' as const, fixRounds: 1 }
    render(<PipelinePanel {...props({ run: run({ tasks: [task] }) })} />)
    expect(screen.getByText('fixing, round 1')).toBeInTheDocument()
  })

  it('shows fix rounds of a finished task whose stage is null', () => {
    const base = run().tasks[0]!
    const task = { ...base, status: 'done' as const, stage: null, fixRounds: 1 }
    render(<PipelinePanel {...props({ run: run({ tasks: [task] }) })} />)
    expect(screen.getByText('fix rounds: 1')).toBeInTheDocument()
  })

  it('shows fix rounds and findings of a failed task', () => {
    const base = run().tasks[0]!
    const task = {
      ...base,
      status: 'failed' as const,
      reason: 'review: blocking findings',
      stage: null,
      fixRounds: 2,
      findings: { blocking: 1, minor: 0, items: [] }
    }
    render(<PipelinePanel {...props({ run: run({ tasks: [task] }) })} />)
    expect(screen.getByText('fix rounds: 2')).toBeInTheDocument()
    expect(screen.getByText('1 blocking, 0 minor')).toBeInTheDocument()
  })

  it('does not show the round number twice for a running task', () => {
    const base = run().tasks[0]!
    const task = { ...base, status: 'running' as const, stage: 'fixing' as const, fixRounds: 2 }
    render(<PipelinePanel {...props({ run: run({ tasks: [task] }) })} />)
    expect(screen.getByText('fixing, round 2')).toBeInTheDocument()
    expect(screen.queryByText(/fix rounds/)).toBeNull()
  })

  it('shows findings of a failed task as plain text', () => {
    const base = run().tasks[0]!
    const items = Array.from({ length: 20 }, (_, i) => ({
      reviewer: 'reviewer' as const,
      severity: i === 0 ? ('blocker' as const) : ('nit' as const),
      file: `src/f${i}.ts`,
      line: i === 0 ? 7 : null,
      text: i === 0 ? '<img src=x onerror=alert(1)>' : `note ${i}`
    }))
    const task = {
      ...base,
      status: 'failed' as const,
      reason: 'review: blocking findings',
      findings: { blocking: 1, minor: 19, items }
    }
    const { container } = render(<PipelinePanel {...props({ run: run({ tasks: [task] }) })} />)
    expect(screen.getByText('1 blocking, 19 minor')).toBeInTheDocument()
    expect(screen.getByText(/blocker · reviewer · src\/f0\.ts:7: <img src=x onerror=alert\(1\)>/)).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelectorAll('.pipeline__findings li')).toHaveLength(20)
  })

  it('shows no stage or findings for a task without them', () => {
    render(<PipelinePanel {...props({ run: run() })} />)
    expect(screen.queryByText(/blocking,/)).toBeNull()
    expect(screen.queryByText(/round/)).toBeNull()
  })

  it('does not render Discard while the status is running, even if not active', () => {
    render(<PipelinePanel {...props({ run: run({ active: false, status: 'running' }) })} />)
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()
  })
})
