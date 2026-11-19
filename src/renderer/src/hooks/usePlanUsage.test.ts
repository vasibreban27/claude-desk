// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { DeskApi, PlanUsage } from '@shared/ipc'
import { usePlanUsage } from './usePlanUsage'

const usage: PlanUsage = { status: 'unavailable', limits: [], extraUsage: null, text: null, fetchedAt: '2026-11-19T12:00:00.000Z' }

function mockApi(fn: ReturnType<typeof vi.fn> | undefined): void {
  window.api = (fn ? { usagePlan: fn } : {}) as unknown as DeskApi
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('usePlanUsage', () => {
  it('loads from the cache on mount and asks for a fresh check on refresh', async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, usage })
    mockApi(fn)
    const { result } = renderHook(() => usePlanUsage())
    await waitFor(() => expect(result.current.usage).toEqual(usage))
    expect(result.current.loading).toBe(false)
    expect(fn).toHaveBeenCalledWith({ refresh: false })
    act(() => result.current.refresh())
    await waitFor(() => expect(fn).toHaveBeenLastCalledWith({ refresh: true }))
  })

  it('reloads when the signal changes and keeps the last data on a failure', async () => {
    const fn = vi.fn().mockResolvedValueOnce({ ok: true, usage }).mockResolvedValueOnce({ ok: false, error: 'failed', message: 'timed out' })
    mockApi(fn)
    const { result, rerender } = renderHook(({ s }) => usePlanUsage(s), { initialProps: { s: 0 } })
    await waitFor(() => expect(result.current.usage).not.toBeNull())
    rerender({ s: 1 })
    await waitFor(() => expect(result.current.error).toBe('Could not read your plan usage: timed out'))
    expect(result.current.usage).toEqual(usage)
  })

  it('reports a missing bridge or a rejected call', async () => {
    mockApi(undefined)
    const { result } = renderHook(() => usePlanUsage())
    await waitFor(() => expect(result.current.error).toBe('The desktop bridge is unavailable.'))
    cleanup()
    mockApi(vi.fn().mockRejectedValue(new Error('x')))
    const second = renderHook(() => usePlanUsage())
    await waitFor(() => expect(second.result.current.error).toBe('Could not read your plan usage.'))
  })
})
