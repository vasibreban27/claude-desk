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
  it('fetches 30 days for the project on mount', async () => {
    const fn = vi.fn().mockResolvedValue(summary())
    mockApi(fn)
    const { result } = renderHook(() => useUsage(PID))
    await waitFor(() => expect(result.current.summary).not.toBeNull())
    expect(fn).toHaveBeenCalledWith({ projectId: PID, days: 30 })
  })

  it('refetches when the range or scope changes', async () => {
    const fn = vi.fn().mockResolvedValue(summary())
    mockApi(fn)
    const { result } = renderHook(() => useUsage(PID))
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1))
    act(() => result.current.setDays(7))
    await waitFor(() => expect(fn).toHaveBeenLastCalledWith({ projectId: PID, days: 7 }))
    act(() => result.current.setScope('all'))
    await waitFor(() => expect(fn).toHaveBeenLastCalledWith({ projectId: null, days: 7 }))
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('uses all projects when none is selected', async () => {
    const fn = vi.fn().mockResolvedValue(summary())
    mockApi(fn)
    const { result } = renderHook(() => useUsage(null))
    await waitFor(() => expect(fn).toHaveBeenCalledWith({ projectId: null, days: 30 }))
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
})
