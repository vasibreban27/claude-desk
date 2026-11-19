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
  api = { pipelinePr: vi.fn(), openUrl: vi.fn().mockResolvedValue(true), pipelineMerge: vi.fn() }
  ;(window as unknown as { api: unknown }).api = api
})

describe('RunFinished: Open pull request', () => {
  it('shows automatic PR progress and the resulting link', () => {
    const pending = { ...run('auto'), delivery: { policy: 'open-pr' as const, status: 'working' as const } }
    const { rerender } = render(<RunFinished projectId="p1" run={pending} onMerged={vi.fn()} />)
    expect(screen.getByText(/Opening the pull request automatically/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open pull request' })).toBeNull()
    rerender(<RunFinished projectId="p1" run={{ ...pending, delivery: { policy: 'open-pr', status: 'done', url: 'https://example.test/pr/1' } }} onMerged={vi.fn()} />)
    expect(screen.getByRole('link', { name: 'https://example.test/pr/1' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open pull request' })).toBeNull()
  })

  it('asks first, then pushes, shows the link and opens it in the browser', async () => {
    api['pipelinePr']?.mockResolvedValue({ ok: true, url: 'https://github.com/o/greet-cli/pull/3', branch: 'desk/greet-cli-r1', host: 'github' })
    render(<RunFinished projectId="p1" run={run('r1')} onMerged={vi.fn()} />)
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
    expect(screen.getByRole('button', { name: 'Merge into main' })).toBeInTheDocument()
  })

  it('shows the reason when the PR cannot be opened', async () => {
    api['pipelinePr']?.mockResolvedValue({ ok: false, error: 'base-not-on-remote', message: 'origin has no main branch yet. Push it once.' })
    render(<RunFinished projectId="p1" run={run('r2')} onMerged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open pull request' }))
    fireEvent.click(screen.getByRole('button', { name: 'Push and open pull request' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('origin has no main branch yet')
    expect(screen.getByRole('button', { name: 'Open pull request' })).toBeInTheDocument()
  })
})
