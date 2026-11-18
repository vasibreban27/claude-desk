// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanReadyCard } from './PlanReadyCard'

afterEach(cleanup)
const pipelineStart = vi.fn()
beforeEach(() => {
  pipelineStart.mockReset()
  ;(window as unknown as { api: unknown }).api = { pipelineStart }
})

describe('PlanReadyCard', () => {
  it('starts the pipeline with the plan only on click', async () => {
    pipelineStart.mockResolvedValue({ ok: true, runId: 'r' })
    const onStarted = vi.fn()
    render(<PlanReadyCard projectId="p" planFile="todo.md" problem={null} onStarted={onStarted} onDismiss={vi.fn()} />)
    expect(pipelineStart).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Start pipeline' }))
    await waitFor(() => expect(onStarted).toHaveBeenCalled())
    expect(pipelineStart).toHaveBeenCalledWith({ projectId: 'p', planFile: 'todo.md' })
  })

  it('blocks an invalid plan and shows start errors', async () => {
    const { rerender } = render(
      <PlanReadyCard projectId="p" planFile="x.md" problem="line 1: bad" onStarted={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: 'Start pipeline' })).toBeDisabled()
    pipelineStart.mockResolvedValue({ ok: false, error: 'busy' })
    rerender(<PlanReadyCard projectId="p" planFile="x.md" problem={null} onStarted={vi.fn()} onDismiss={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start pipeline' }))
    expect(await screen.findByText('A pipeline run is already active for this project.')).toBeInTheDocument()
  })
})
