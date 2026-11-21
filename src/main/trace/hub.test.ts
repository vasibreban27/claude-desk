import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TRACE_EVENTS_PER_RUN_MAX, type TracePush } from '../../shared/trace'
import { migrate } from '../db/migrations'
import { createTraceStore, type TraceStore } from '../db/traceStore'
import { createTraceHub } from './hub'

function setup(store?: TraceStore) {
  const pushes: TracePush[] = []
  const hub = createTraceHub({ ...(store ? { store } : {}), emit: (p) => pushes.push(p), now: () => 1_000_000, flushMs: 10_000 })
  return { hub, pushes }
}

function realStore(): TraceStore {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return createTraceStore(db)
}

const say = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

afterEach(() => {
  vi.useRealTimers()
})

describe('trace hub', () => {
  it('numbers, pushes and stores the events of a chat run', () => {
    const store = realStore()
    const { hub, pushes } = setup(store)
    hub.startRun({ runId: 'r1', projectId: 'p1', source: 'chat', title: 'fix   the\nbug' })
    const s = hub.session({ projectId: 'p1', runId: 'r1', taskId: null, role: 'chat', session: 'chat', agent: 'main', cwd: null })
    s.message(say('one'))
    s.message(say('two'))
    expect(pushes[0]).toMatchObject({ type: 'run', run: { runId: 'r1', title: 'fix the bug', status: 'running' } })
    expect(pushes.slice(1).map((p) => (p.type === 'event' ? p.event.seq : -1))).toEqual([0, 1])
    // reading flushes pending writes
    expect(hub.events('p1', 'r1').map((e) => (e.kind === 'text' ? e.text : ''))).toEqual(['one', 'two'])
    hub.endRun('r1', 'ok')
    expect(hub.runs('p1')[0]).toMatchObject({ status: 'ok', events: 2 })
    expect(pushes.at(-1)).toMatchObject({ type: 'run', run: { status: 'ok' } })
  })

  it('creates a pipeline run on its first note and continues numbering after a restart', () => {
    const store = realStore()
    const first = setup(store)
    first.hub.note({ projectId: 'p1', runId: 'pr', taskId: 'T1', text: 'checks passed', tone: 'ok' })
    first.hub.flush()
    expect(first.pushes.some((p) => p.type === 'run' && p.run.source === 'pipeline')).toBe(true)
    const second = setup(store)
    second.hub.note({ projectId: 'p1', runId: 'pr', taskId: null, text: 'resumed' })
    expect(second.hub.events('p1', 'pr').map((e) => e.seq)).toEqual([0, 1])
  })

  it('hides secrets in notes', () => {
    const { hub, pushes } = setup()
    hub.note({ projectId: 'p', runId: 'r', taskId: null, text: 'token=abc123456 failed' })
    const ev = pushes.find((p) => p.type === 'event')
    expect(ev?.type === 'event' && ev.event.kind === 'note' ? ev.event.text : '').toBe('token=*** failed')
  })

  it('writes in batches after a delay', () => {
    vi.useFakeTimers()
    const store = realStore()
    const insert = vi.spyOn(store, 'insertEvents')
    const pushes: TracePush[] = []
    const hub = createTraceHub({ store, emit: (p) => pushes.push(p), flushMs: 50 })
    hub.startRun({ runId: 'r', projectId: 'p', source: 'chat', title: 't' })
    const s = hub.session({ projectId: 'p', runId: 'r', taskId: null, role: 'chat', session: 'chat', agent: 'main', cwd: null })
    s.message(say('a'))
    s.message(say('b'))
    expect(insert).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60)
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0]?.[0]).toHaveLength(2)
  })

  it('stops at the per-run limit with one note', () => {
    const { hub, pushes } = setup()
    const s = hub.session({ projectId: 'p', runId: 'r', taskId: null, role: 'worker', session: 'worker', agent: 'w', cwd: null })
    for (let i = 0; i < TRACE_EVENTS_PER_RUN_MAX + 20; i++) s.message(say(`m${i}`))
    const events = pushes.filter((p) => p.type === 'event')
    expect(events).toHaveLength(TRACE_EVENTS_PER_RUN_MAX + 1)
    expect(events.at(-1)).toMatchObject({ event: { kind: 'note' } })
  })

  it('never throws when the store or the window fails', () => {
    const broken: TraceStore = {
      ensureRun: () => {
        throw new Error('x')
      },
      endRun: () => {
        throw new Error('x')
      },
      insertEvents: () => {
        throw new Error('x')
      },
      runCounters: () => {
        throw new Error('x')
      },
      listRuns: () => {
        throw new Error('x')
      },
      listEvents: () => {
        throw new Error('x')
      },
      prune: () => {
        throw new Error('x')
      },
      markInterrupted: () => {
        throw new Error('x')
      }
    }
    const hub = createTraceHub({
      store: broken,
      emit: () => {
        throw new Error('closed')
      }
    })
    expect(() => {
      hub.startRun({ runId: 'r', projectId: 'p', source: 'chat', title: 't' })
      hub.session({ projectId: 'p', runId: 'r', taskId: null, role: 'chat', session: 'chat', agent: 'main', cwd: null }).message(say('a'))
      hub.note({ projectId: 'p', runId: 'q', taskId: null, text: 'n' })
      hub.endRun('r', 'error')
    }).not.toThrow()
    expect(hub.runs('p')).toEqual([])
    expect(hub.events('p', 'r')).toEqual([])
  })

  it('works without a store (live only)', () => {
    const { hub, pushes } = setup()
    hub.startRun({ runId: 'r', projectId: 'p', source: 'plan', title: 'plan it' })
    expect(pushes[0]).toMatchObject({ type: 'run', run: { source: 'plan', status: 'running' } })
    expect(hub.runs('p')).toEqual([])
  })
})
