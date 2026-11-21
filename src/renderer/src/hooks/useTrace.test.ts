// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { DeskApi, TraceEvent, TracePush, TraceRun } from '@shared/ipc'
import { mergeEvents, upsertRun, useTrace } from './useTrace'

const P = '11111111-1111-4111-8111-111111111111'
const run = (runId: string, startedAt: number, over: Partial<TraceRun> = {}): TraceRun => ({
  runId,
  projectId: P,
  source: 'chat',
  title: runId,
  startedAt,
  endedAt: null,
  status: 'ok',
  events: 0,
  ...over
})
const ev = (runId: string, seq: number): TraceEvent => ({
  projectId: P,
  runId,
  seq,
  at: '2026-11-20T10:00:00.000Z',
  taskId: null,
  role: 'chat',
  session: 'chat',
  agent: 'main',
  parentId: null,
  kind: 'text',
  text: `${runId}-${seq}`
})

let push: (p: TracePush) => void = () => undefined
let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  api = {
    activityRuns: vi.fn().mockResolvedValue([run('new', 2), run('old', 1)]),
    activityEvents: vi.fn().mockImplementation(({ runId }: { runId: string }) => Promise.resolve([ev(runId, 0), ev(runId, 1)])),
    onActivityTrace: vi.fn().mockImplementation((l: (p: TracePush) => void) => {
      push = l
      return () => undefined
    }),
    onPipelineEvent: vi.fn().mockReturnValue(() => undefined)
  }
  window.api = api as unknown as DeskApi
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('helpers', () => {
  it('keeps runs newest first without duplicates', () => {
    expect(upsertRun([run('a', 1)], run('b', 2)).map((r) => r.runId)).toEqual(['b', 'a'])
    expect(upsertRun([run('a', 1)], run('a', 1, { status: 'error' }))).toEqual([run('a', 1, { status: 'error' })])
  })

  it('merges events by seq and drops duplicates', () => {
    const a = [ev('r', 0), ev('r', 2)]
    expect(mergeEvents(a, [ev('r', 2), ev('r', 3)]).map((e) => e.seq)).toEqual([0, 2, 3])
    expect(mergeEvents(a, [ev('r', 1)]).map((e) => e.seq)).toEqual([0, 1, 2])
    expect(mergeEvents(a, [ev('r', 0)])).toBe(a)
  })
})

describe('useTrace', () => {
  it('loads the newest run, appends live events and follows a new run', async () => {
    const { result } = renderHook(() => useTrace(P))
    await waitFor(() => expect(result.current.events).toHaveLength(2))
    expect(result.current.runId).toBe('new')
    expect(api['activityEvents']).toHaveBeenCalledWith({ projectId: P, runId: 'new' })

    act(() => push({ type: 'event', event: ev('new', 2) }))
    expect(result.current.events.map((e) => e.seq)).toEqual([0, 1, 2])

    act(() => push({ type: 'run', run: run('newer', 3, { status: 'running' }) }))
    expect(result.current.runId).toBe('newer')
    await waitFor(() => expect(result.current.events.map((e) => e.runId)).toEqual(['newer', 'newer']))
  })

  it('stays on a run the user picked', async () => {
    const { result } = renderHook(() => useTrace(P))
    await waitFor(() => expect(result.current.runId).toBe('new'))
    act(() => result.current.select('old'))
    await waitFor(() => expect(result.current.events[0]?.runId).toBe('old'))
    act(() => push({ type: 'run', run: run('newer', 3) }))
    expect(result.current.runId).toBe('old')
    expect(result.current.runs.map((r) => r.runId)).toEqual(['newer', 'new', 'old'])
  })

  it('ignores other projects and reports load errors', async () => {
    api['activityRuns']!.mockRejectedValue(new Error('x'))
    const { result } = renderHook(() => useTrace(P))
    await waitFor(() => expect(result.current.error).toBe('Could not load the activity.'))
    act(() => push({ type: 'run', run: { ...run('x', 9), projectId: 'other' } }))
    expect(result.current.runs).toEqual([])
  })

  it('does nothing without a project', () => {
    const { result } = renderHook(() => useTrace(null))
    expect(result.current).toMatchObject({ runs: [], runId: null, loading: false })
    expect(api['activityRuns']).not.toHaveBeenCalled()
  })
})
