// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ActivityEvent, DeskApi } from '@shared/ipc'
import { useActivity } from './useActivity'

afterEach(() => {
  cleanup()
  // @ts-expect-error reset the mocked bridge
  delete window.api
})

const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'

const ev = (seq: number, projectId = P1, runId = 'r1'): ActivityEvent => ({
  projectId,
  runId,
  seq,
  at: '2026-01-01T10:00:00.000+00:00',
  agent: 'main',
  agentId: null,
  type: 'tool-started',
  toolUseId: `t${seq}`,
  tool: 'Read',
  summary: ''
})

function setup(history: ActivityEvent[] | Error = []) {
  let listener: (e: ActivityEvent) => void = () => {}
  const unsubscribe = vi.fn()
  const activityHistory = vi.fn(() => (history instanceof Error ? Promise.reject(history) : Promise.resolve(history)))
  const onActivityEvent = vi.fn((l: (e: ActivityEvent) => void) => {
    listener = l
    return unsubscribe
  })
  window.api = { activityHistory, onActivityEvent } as unknown as DeskApi
  return { activityHistory, unsubscribe, emit: (e: ActivityEvent) => act(() => listener(e)) }
}

describe('useActivity', () => {
  it('loads history, then appends live events in seq order and ignores other projects', async () => {
    const { activityHistory, emit } = setup([ev(0), ev(1)])
    const { result } = renderHook(() => useActivity(P1))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(activityHistory).toHaveBeenCalledWith({ projectId: P1 })
    emit(ev(3))
    emit(ev(2))
    emit(ev(9, P2))
    emit(ev(2)) // duplicate
    expect(result.current.events.map((e) => e.seq)).toEqual([0, 1, 2, 3])
  })

  it('keeps live events that arrive before history resolves, without duplicates', async () => {
    const { emit } = setup([ev(0), ev(1)])
    const { result } = renderHook(() => useActivity(P1))
    emit(ev(1))
    emit(ev(2))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.events.map((e) => e.seq)).toEqual([0, 1, 2])
  })

  it('shows only the newest run when a new run starts', async () => {
    const { emit } = setup([ev(0), ev(1)])
    const { result } = renderHook(() => useActivity(P1))
    await waitFor(() => expect(result.current.loading).toBe(false))
    emit(ev(0, P1, 'r2'))
    expect(result.current.events.map((e) => e.runId)).toEqual(['r2'])
  })

  it('unsubscribes on unmount', async () => {
    const { unsubscribe } = setup()
    const { unmount } = renderHook(() => useActivity(P1))
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('reports an error when history fails to load', async () => {
    setup(new Error('boom'))
    const { result } = renderHook(() => useActivity(P1))
    await waitFor(() => expect(result.current.error).toBe('Could not load the activity.'))
    expect(result.current.loading).toBe(false)
  })

  it('does nothing without a project', () => {
    const { activityHistory } = setup()
    const { result } = renderHook(() => useActivity(null))
    expect(activityHistory).not.toHaveBeenCalled()
    expect(result.current).toEqual({ events: [], loading: false, error: null })
  })
})
