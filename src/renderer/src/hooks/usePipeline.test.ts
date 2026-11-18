// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { DeskApi, PipelineEvent, PipelineRunView } from '@shared/ipc'
import { usePipeline } from './usePipeline'

afterEach(() => {
  cleanup()
  // @ts-expect-error reset the mocked bridge
  delete window.api
})

const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'

const run = (status: PipelineRunView['status'] = 'running'): PipelineRunView => ({
  runId: 'r1',
  planFile: 'a.md',
  status,
  active: status === 'running',
  baseBranch: 'main',
  integrationBranch: 'run/r1',
  createdAt: '2026-01-01T10:00:00.000Z',
  finishedAt: null,
  tasks: []
})

function setup(overrides: Partial<Record<keyof DeskApi, unknown>> = {}) {
  let listener: (e: PipelineEvent) => void = () => {}
  const unsubscribe = vi.fn()
  const api = {
    pipelinePlans: vi.fn(async () => ({ ok: true, plans: [] })),
    pipelineStatus: vi.fn(async () => ({ ok: true, run: run() })),
    pipelineStart: vi.fn(async () => ({ ok: true, runId: 'r1' })),
    pipelineCancel: vi.fn(async () => ({ ok: true })),
    onPipelineEvent: vi.fn((l: (e: PipelineEvent) => void) => {
      listener = l
      return unsubscribe
    }),
    ...overrides
  }
  window.api = api as unknown as DeskApi
  return { api, unsubscribe, emit: (e: PipelineEvent) => act(() => listener(e)) }
}

describe('usePipeline', () => {
  it('restores a run in progress and loads plans on mount', async () => {
    const { api } = setup()
    const { result } = renderHook(() => usePipeline(P1))
    expect(result.current.runLoading).toBe(true)
    await waitFor(() => expect(result.current.run?.runId).toBe('r1'))
    await waitFor(() => expect(result.current.plans).toEqual([]))
    expect(api.pipelineStatus).toHaveBeenCalledWith({ projectId: P1 })
    expect(api.pipelinePlans).toHaveBeenCalledWith({ projectId: P1 })
  })

  it('re-fetches status on an event for this project and ignores other projects', async () => {
    const { api, emit } = setup()
    const { result } = renderHook(() => usePipeline(P1))
    await waitFor(() => expect(result.current.runLoading).toBe(false))
    expect(api.pipelineStatus).toHaveBeenCalledTimes(1)
    emit({ projectId: P2, runId: 'x' })
    expect(api.pipelineStatus).toHaveBeenCalledTimes(1)
    emit({ projectId: P1, runId: 'r1' })
    await waitFor(() => expect(api.pipelineStatus).toHaveBeenCalledTimes(2))
  })

  it('unsubscribes on unmount and on project change', async () => {
    const { unsubscribe } = setup()
    const { rerender, unmount } = renderHook(({ p }) => usePipeline(p), { initialProps: { p: P1 } })
    rerender({ p: P2 })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })

  it('reports status and plan errors', async () => {
    setup({
      pipelineStatus: vi.fn(async () => ({ ok: false, error: 'storage-unavailable' })),
      pipelinePlans: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    const { result } = renderHook(() => usePipeline(P1))
    await waitFor(() => expect(result.current.runError).toBe('Run storage is unavailable.'))
    await waitFor(() => expect(result.current.plansError).toBe('Could not load the plans.'))
  })

  it('starts with the project id and file name only', async () => {
    const { api } = setup()
    const { result } = renderHook(() => usePipeline(P1))
    await waitFor(() => expect(result.current.runLoading).toBe(false))
    await act(() => result.current.start('a.md'))
    expect(api.pipelineStart).toHaveBeenCalledWith({ projectId: P1, planFile: 'a.md' })
    expect(result.current.startError).toBeNull()
  })

  it.each([
    ['busy', /already active/],
    ['no-toolkit', /toolkit/],
    ['detached-head', /detached HEAD/],
    ['invalid-plan', /not valid/],
    ['not-found', /not found/],
    ['storage-unavailable', /storage/],
    ['start-failed', /could not be started/]
  ])('shows a message for start error %s', async (error, re) => {
    setup({ pipelineStart: vi.fn(async () => ({ ok: false, error })) })
    const { result } = renderHook(() => usePipeline(P1))
    await waitFor(() => expect(result.current.runLoading).toBe(false))
    await act(() => result.current.start('a.md'))
    expect(result.current.startError).toMatch(re)
  })

  it('keeps Cancelling until the next status and shows cancel errors', async () => {
    const pipelineCancel = vi.fn(async () => ({ ok: true }))
    const { emit } = setup({ pipelineCancel })
    const { result } = renderHook(() => usePipeline(P1))
    await waitFor(() => expect(result.current.run).not.toBeNull())
    await act(() => result.current.cancel())
    expect(pipelineCancel).toHaveBeenCalledWith({ projectId: P1, runId: 'r1' })
    expect(result.current.cancelling).toBe(true)
    emit({ projectId: P1, runId: 'r1' })
    await waitFor(() => expect(result.current.cancelling).toBe(false))
  })

  it('shows not-active without crashing', async () => {
    setup({ pipelineCancel: vi.fn(async () => ({ ok: false, error: 'not-active' })) })
    const { result } = renderHook(() => usePipeline(P1))
    await waitFor(() => expect(result.current.run).not.toBeNull())
    await act(() => result.current.cancel())
    expect(result.current.cancelError).toBe('The run is no longer active.')
    expect(result.current.cancelling).toBe(false)
  })

  it('does nothing without a project', () => {
    const { api } = setup()
    const { result } = renderHook(() => usePipeline(null))
    expect(api.pipelineStatus).not.toHaveBeenCalled()
    expect(result.current.runLoading).toBe(false)
  })
})
