// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { DeskApi, UsageSummary } from '@shared/ipc'
import { useUsage } from './useUsage'

const PID = '11111111-1111-4111-8111-111111111111'

function summary(runs = 1): UsageSummary {
  return {
    days: 30,
    estimated: true,
    totals: { runs, costUsd: 0.5, inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
    byDay: [],
    byAgent: [],
    byKind: [],
    byProject: []
  }
}

function mockApi(fn: ReturnType<typeof vi.fn>): void {
  window.api = { usageSummary: fn } as unknown as DeskApi
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useUsage', () => {
  it('fetches 7 days for the project on mount', async () => {
    const fn = vi.fn().mockResolvedValue(summary())
    mockApi(fn)
    const { result } = renderHook(() => useUsage(PID))
    await waitFor(() => expect(result.current.summary).not.toBeNull())
    expect(fn).toHaveBeenCalledWith({ projectId: PID, days: 7 })
  })

  it('refetches when the range or scope changes', async () => {
    const fn = vi.fn().mockResolvedValue(summary())
    mockApi(fn)
    const { result } = renderHook(() => useUsage(PID))
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1))
    act(() => result.current.setDays(30))
    await waitFor(() => expect(fn).toHaveBeenLastCalledWith({ projectId: PID, days: 30 }))
    act(() => result.current.setScope('all'))
    await waitFor(() => expect(fn).toHaveBeenLastCalledWith({ projectId: null, days: 30 }))
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('uses all projects when none is selected', async () => {
    const fn = vi.fn().mockResolvedValue(summary())
    mockApi(fn)
    const { result } = renderHook(() => useUsage(null))
    await waitFor(() => expect(fn).toHaveBeenCalledWith({ projectId: null, days: 7 }))
    expect(result.current.scope).toBe('all')
  })

  it('refetches when the refresh signal changes', async () => {
    const fn = vi.fn().mockResolvedValue(summary())
    mockApi(fn)
    const { rerender } = renderHook(({ s }) => useUsage(PID, s), { initialProps: { s: 0 } })
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1))
    rerender({ s: 1 })
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2))
  })

  it('keeps previous data and sets an error when a refetch rejects', async () => {
    const fn = vi.fn().mockResolvedValueOnce(summary(3)).mockRejectedValueOnce(new Error('x'))
    mockApi(fn)
    const { result, rerender } = renderHook(({ s }) => useUsage(PID, s), { initialProps: { s: 0 } })
    await waitFor(() => expect(result.current.summary?.totals.runs).toBe(3))
    rerender({ s: 1 })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.summary?.totals.runs).toBe(3)
  })

  const PID2 = '22222222-2222-4222-8222-222222222222'

  it('hides the previous project summary while the new project loads', async () => {
    let resolveSecond: (s: UsageSummary) => void = () => {}
    const fn = vi
      .fn()
      .mockResolvedValueOnce(summary(3))
      .mockImplementationOnce(() => new Promise<UsageSummary>((r) => (resolveSecond = r)))
    mockApi(fn)
    const { result, rerender } = renderHook(({ p }) => useUsage(p), { initialProps: { p: PID } })
    await waitFor(() => expect(result.current.summary?.totals.runs).toBe(3))
    rerender({ p: PID2 })
    expect(result.current.summary).toBeNull()
    expect(result.current.loading).toBe(true)
    await act(async () => resolveSecond(summary(7)))
    expect(result.current.summary?.totals.runs).toBe(7)
    expect(result.current.loading).toBe(false)
  })

  it('shows only the error, not the old summary, when the new project fails to load', async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(summary(3))
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValue(summary(3))
    mockApi(fn)
    const { result, rerender } = renderHook(({ p }) => useUsage(p), { initialProps: { p: PID } })
    await waitFor(() => expect(result.current.summary?.totals.runs).toBe(3))
    rerender({ p: PID2 })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.summary).toBeNull()
    rerender({ p: PID })
    expect(result.current.error).toBeNull()
  })
})
