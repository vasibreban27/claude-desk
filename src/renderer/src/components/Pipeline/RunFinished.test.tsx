// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PipelineRunView } from '@shared/ipc'
import { RunFinished } from './RunFinished'

afterEach(cleanup)

const run = (runId: string): PipelineRunView => ({
  runId,
  planFile: 'greet-cli.md',
  status: 'done',
  active: false,
  baseBranch: 'main',
  integrationBranch: `run/${runId}`,
  createdAt: '2026-11-19T08:00:00.000Z',
  finishedAt: '2026-11-19T08:05:00.000Z',
  tasks: []
})
let api: Record<string, ReturnType<typeof vi.fn>>
beforeEach(() => {
  api = { pipelinePr: vi.fn(), openUrl: vi.fn().mockResolvedValue(true), pipelineMerge: vi.fn(), pipelineBranch: vi.fn() }
  ;(window as unknown as { api: unknown }).api = api
})

describe('RunFinished: Open pull request', () => {
  it('shows automatic PR progress and the resulting link', () => {
    const pending = { ...run('auto'), delivery: { policy: 'open-pr' as const, status: 'working' as const } }
    const { rerender } = render(<RunFinished projectId="p1" run={pending} onDone={vi.fn()} />)
    expect(screen.getByText(/Opening the pull request automatically/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open pull request' })).toBeNull()
    rerender(<RunFinished projectId="p1" run={{ ...pending, delivery: { policy: 'open-pr', status: 'done', url: 'https://example.test/pr/1' } }} onDone={vi.fn()} />)
    expect(screen.getByRole('link', { name: 'https://example.test/pr/1' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open pull request' })).toBeNull()
  })

  it('asks first, then pushes, shows the link and opens it in the browser', async () => {
    api['pipelinePr']?.mockResolvedValue({ ok: true, url: 'https://github.com/o/greet-cli/pull/3', branch: 'desk/greet-cli-r1', host: 'github' })
    render(<RunFinished projectId="p1" run={run('r1')} onDone={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open pull request' }))
    expect(api['pipelinePr']).not.toHaveBeenCalled()
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm pull request' })
    expect(dialog).toHaveTextContent(/Nothing is merged and main is not pushed/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Push and open pull request' }))
    const status = await screen.findByRole('status', { name: 'Pull request' })
    expect(status).toHaveTextContent('https://github.com/o/greet-cli/pull/3')
    expect(api['pipelinePr']).toHaveBeenCalledWith({ projectId: 'p1', runId: 'r1' })
    expect(api['openUrl']).toHaveBeenCalledWith({ url: 'https://github.com/o/greet-cli/pull/3' })
    expect(screen.queryByRole('button', { name: 'Open pull request' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save as branch…' })).toBeInTheDocument()
  })

  it('shows the reason when the PR cannot be opened', async () => {
    api['pipelinePr']?.mockResolvedValue({ ok: false, error: 'base-not-on-remote', message: 'origin has no main branch yet. Push it once.' })
    render(<RunFinished projectId="p1" run={run('r2')} onDone={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open pull request' }))
    fireEvent.click(screen.getByRole('button', { name: 'Push and open pull request' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('origin has no main branch yet')
    expect(screen.getByRole('button', { name: 'Open pull request' })).toBeInTheDocument()
  })
})

describe('RunFinished: Save as branch', () => {
  it('prefills feature/<plan>, saves only after confirming, and reports the branch', async () => {
    api['pipelineBranch']?.mockResolvedValue({ ok: true, branch: 'feature/greet-cli', head: 'abc1234', created: true, cleanedUp: true })
    const onDone = vi.fn()
    render(<RunFinished projectId="p1" run={run('r3')} onDone={onDone} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save as branch…' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Save as branch' })
    expect(within(dialog).getByLabelText('Branch name')).toHaveValue('feature/greet-cli')
    expect(dialog).toHaveTextContent(/stays as it is and nothing is pushed/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save branch' }))
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(api['pipelineBranch']).toHaveBeenCalledWith({ projectId: 'p1', runId: 'r3', branch: 'feature/greet-cli' })
    expect(onDone.mock.calls[0]?.[0]).toMatchObject({ kind: 'branch', branch: 'feature/greet-cli', runId: 'r3' })
  })

  it('refuses bad, reserved and base branch names before calling the app', () => {
    render(<RunFinished projectId="p1" run={run('r4')} onDone={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save as branch…' }))
    const input = screen.getByLabelText('Branch name')
    const save = screen.getByRole('button', { name: 'Save branch' })
    for (const [name, text] of [
      ['feature/a b', /Use letters/],
      ['run/x', /belong to the pipeline/],
      ['main', /main is the base branch/],
      ['', /Enter a branch name/]
    ] as const) {
      fireEvent.change(input, { target: { value: name } })
      expect(save).toBeDisabled()
      expect(screen.getByText(text)).toBeInTheDocument()
    }
    fireEvent.change(input, { target: { value: 'feature/api-contracts' } })
    expect(save).toBeEnabled()
    expect(api['pipelineBranch']).not.toHaveBeenCalled()
  })

  it('shows why git refused the branch and keeps the dialog closed', async () => {
    api['pipelineBranch']?.mockResolvedValue({ ok: false, error: 'not-fast-forward', message: 'feature/greet-cli has commits this run does not have.' })
    render(<RunFinished projectId="p1" run={run('r5')} onDone={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save as branch…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save branch' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('has commits this run does not have')
    expect(screen.getByRole('button', { name: 'Save as branch…' })).toBeInTheDocument()
  })

  it('offers Merge into main only when the project allows it', () => {
    const { rerender } = render(<RunFinished projectId="p1" run={run('r6')} onDone={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Merge into main' })).toBeNull()
    rerender(<RunFinished projectId="p1" run={{ ...run('r6'), allowBaseMerge: true }} onDone={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Merge into main' })).toBeInTheDocument()
  })

  it('shows an automatic save', () => {
    render(<RunFinished projectId="p1" run={{ ...run('r7'), delivery: { policy: 'save-branch', status: 'done', branch: 'feature/greet-cli' } }} onDone={vi.fn()} />)
    expect(screen.getByText(/Saved as branch/)).toHaveTextContent('feature/greet-cli')
    expect(screen.queryByRole('button', { name: 'Save as branch…' })).toBeNull()
  })
})
