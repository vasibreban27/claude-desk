import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '@shared/ipc'
import { buildTree, filterOptions, filterTree, formatDuration, formatTokens, NO_FILTER, type Session } from './traceTree'

let seq = 0
const meta = (over: Partial<TraceEvent> = {}) => ({
  projectId: 'p',
  runId: 'r',
  seq: seq++,
  at: '2026-11-20T10:00:00.000Z',
  taskId: 'T1' as string | null,
  role: 'worker' as const,
  session: 'worker',
  agent: 'node-developer',
  parentId: null as string | null,
  ...over
})
const tool = (id: string, over: Partial<TraceEvent> = {}): TraceEvent =>
  ({ ...meta(over), kind: 'tool', toolUseId: id, tool: 'Read', summary: id, input: '', diff: null, added: 0, removed: 0 }) as TraceEvent
const result = (id: string, ok = true, over: Partial<TraceEvent> = {}): TraceEvent =>
  ({ ...meta(over), kind: 'result', toolUseId: id, ok, denied: false, output: '', durationMs: 5 }) as TraceEvent
const note = (text: string, tone: 'info' | 'error' = 'info', taskId: string | null = 'T1'): TraceEvent =>
  ({ ...meta({ taskId, role: 'pipeline', session: 'pipeline', agent: 'pipeline' }), kind: 'note', text, tone }) as TraceEvent

describe('buildTree', () => {
  it('groups by task and session, pairs results and nests subagent steps', () => {
    seq = 0
    const events = [
      note('wave 1 started', 'info', null),
      tool('a'),
      tool('ag', { ...{}, }),
      tool('g', { parentId: 'ag', agent: 'flow:test-writer' }),
      result('g', true, { parentId: 'ag', agent: 'flow:test-writer' }),
      result('a', false),
      note('checks failed', 'error'),
      tool('f', { role: 'fix', session: 'fix round 1' }),
      tool('t2', { taskId: 'T2' })
    ]
    const groups = buildTree(events)
    expect(groups.map((g) => g.taskId)).toEqual([null, 'T1', 'T2'])
    const t1 = groups[1]!
    expect(t1.items.map((i) => (i.type === 'note' ? `note:${i.event.text}` : `session:${i.label}`))).toEqual([
      'session:worker',
      'note:checks failed',
      'session:fix round 1'
    ])
    const worker = t1.items[0] as Session
    expect(worker.steps).toHaveLength(2)
    const [a, ag] = worker.steps
    expect(a).toMatchObject({ type: 'tool', result: { ok: false } })
    expect(ag?.type === 'tool' ? ag.children.map((c) => c.type === 'tool' && c.call.toolUseId) : []).toEqual(['g'])
  })
})

describe('filterTree', () => {
  seq = 0
  const events = [
    tool('a'),
    result('a', true),
    tool('b'),
    result('b', false),
    tool('ag'),
    tool('g', { parentId: 'ag', agent: 'sub' }),
    result('g', false, { parentId: 'ag', agent: 'sub' }),
    note('merged', 'info'),
    note('failed', 'error'),
    tool('x', { taskId: 'T2' })
  ]
  const tree = buildTree(events)

  it('returns everything without filters', () => {
    expect(filterTree(tree, NO_FILTER)).toEqual(tree)
  })

  it('keeps only errors, with the Agent call that holds a failing subagent step', () => {
    const out = filterTree(tree, { ...NO_FILTER, errorsOnly: true })
    expect(out.map((g) => g.taskId)).toEqual(['T1'])
    const items = out[0]!.items
    const s = items[0] as Session
    expect(s.steps.map((st) => (st.type === 'tool' ? st.call.toolUseId : st.type))).toEqual(['b', 'ag'])
    expect(items.filter((i) => i.type === 'note').map((i) => i.type === 'note' && i.event.text)).toEqual(['failed'])
  })

  it('filters by task and by agent', () => {
    expect(filterTree(tree, { ...NO_FILTER, taskId: 'T2' }).map((g) => g.taskId)).toEqual(['T2'])
    const sub = filterTree(tree, { ...NO_FILTER, agent: 'sub' })
    const s = sub[0]!.items[0] as Session
    expect(s.steps).toHaveLength(1)
    expect(s.steps[0]?.type === 'tool' ? s.steps[0].children.length : 0).toBe(1)
    expect(sub[0]!.items.some((i) => i.type === 'note')).toBe(false)
  })

  it('lists tasks and agents for the menus', () => {
    expect(filterOptions(events)).toEqual({ tasks: ['T1', 'T2'], agents: ['node-developer', 'sub'] })
  })
})

describe('formatting', () => {
  it('formats durations and tokens', () => {
    expect(formatDuration(null)).toBe('')
    expect(formatDuration(850)).toBe('850ms')
    expect(formatDuration(12_400)).toBe('12s')
    expect(formatDuration(63_000)).toBe('1m 03s')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(4_520)).toBe('4.5k')
    expect(formatTokens(45_200)).toBe('45k')
    expect(formatTokens(2_300_000)).toBe('2.3M')
  })
})
