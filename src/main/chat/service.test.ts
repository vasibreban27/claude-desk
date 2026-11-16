import { describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '../../shared/ipc'
import { ConfigError } from '../config'
import { extractSessionId, extractTextDelta, type ChatRunner, type RunnerItem } from './runner'
import { ChatService } from './service'

const TOOLKIT = '/toolkit'
const paths: Record<string, string> = { p1: '/work/one', p2: '/work/two' }

function setup(runner: ChatRunner, cfg?: () => ReturnType<NonNullable<ConstructorParameters<typeof ChatService>[0]['loadConfig']>>) {
  const events: ChatEvent[] = []
  let resolveEnd: () => void = () => {}
  let ended = new Promise<void>((r) => (resolveEnd = r))
  const service = new ChatService({
    resolveProjectPath: (id) => paths[id],
    runner,
    emit: (e) => {
      events.push(e)
      if (e.type !== 'text-delta') {
        resolveEnd()
        ended = new Promise<void>((r) => (resolveEnd = r))
      }
    },
    loadConfig: cfg ?? (() => ({ ok: true, config: { toolkitPath: TOOLKIT } }))
  })
  return { service, events, waitEnd: () => ended }
}

function streamOf(items: RunnerItem[]): ChatRunner {
  return async function* () {
    for (const i of items) yield i
  }
}

describe('ChatService', () => {
  it('passes cwd and the toolkit plugin path to the runner', async () => {
    const runner = vi.fn(streamOf([{ kind: 'text', text: 'hi' }]))
    const { service, waitEnd } = setup(runner)
    const end = waitEnd()
    service.send('p1', 'hello')
    await end
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'hello', cwd: '/work/one', pluginPath: TOOLKIT })
    )
  })

  it('emits text-delta in order then one done, and stores history', async () => {
    const { service, events, waitEnd } = setup(
      streamOf([
        { kind: 'text', text: 'a' },
        { kind: 'text', text: 'b' }
      ])
    )
    const end = waitEnd()
    const r = service.send('p1', 'q')
    expect(r.ok).toBe(true)
    await end
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'text-delta', 'done'])
    expect(events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text)).toEqual(['a', 'b'])
    const h = service.getHistory('p1')
    expect(h.map((m) => [m.role, m.text])).toEqual([
      ['user', 'q'],
      ['assistant', 'ab']
    ])
  })

  it('emits a sanitized error and can be used again', async () => {
    let calls = 0
    const runner: ChatRunner = async function* () {
      calls++
      if (calls === 1) throw new Error('boom ANTHROPIC_API_KEY=sk-secret')
      yield { kind: 'text', text: 'ok' }
    }
    const { service, events, waitEnd } = setup(runner)
    let end = waitEnd()
    service.send('p1', 'x')
    await end
    const err = events.find((e) => e.type === 'error')
    expect(err && 'message' in err ? err.message : '').not.toContain('sk-secret')
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1)

    end = waitEnd()
    expect(service.send('p1', 'again').ok).toBe(true)
    await end
    expect(events.at(-1)?.type).toBe('done')
  })

  it('reports a config error without env values', async () => {
    const runner = vi.fn(streamOf([]))
    const { service, events, waitEnd } = setup(runner, () => ({
      ok: false,
      error: new ConfigError('toolkit-path-unset', 'CLAUDE_TOOLKIT_PATH is not set. Point it at your claude-toolkit clone.')
    }))
    const end = waitEnd()
    service.send('p1', 'x')
    await end
    expect(runner).not.toHaveBeenCalled()
    expect(events[0]).toMatchObject({ type: 'error', message: expect.stringContaining('CLAUDE_TOOLKIT_PATH') })
  })

  it('returns busy for a second send while a turn runs, and not-found for unknown projects', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const runner: ChatRunner = async function* () {
      await gate
      yield { kind: 'text', text: 'x' }
    }
    const { service, waitEnd } = setup(runner)
    const end = waitEnd()
    expect(service.send('p1', 'one').ok).toBe(true)
    expect(service.send('p1', 'two')).toEqual({ ok: false, error: 'busy' })
    expect(service.send('p2', 'other').ok).toBe(true)
    expect(service.send('nope', 'x')).toEqual({ ok: false, error: 'not-found' })
    release()
    await end
  })

  it('keeps history per project and starts empty on a new instance', async () => {
    const { service, waitEnd } = setup(streamOf([{ kind: 'text', text: 'r' }]))
    const end = waitEnd()
    service.send('p1', 'for one')
    await end
    expect(service.getHistory('p1')).toHaveLength(2)
    expect(service.getHistory('p2')).toEqual([])
    const fresh = setup(streamOf([])).service
    expect(fresh.getHistory('p1')).toEqual([])
  })

  it('resumes the session id on the next turn', async () => {
    const runner = vi.fn(
      streamOf([
        { kind: 'session', sessionId: 's-1' },
        { kind: 'text', text: 't' }
      ])
    )
    const { service, waitEnd } = setup(runner)
    let end = waitEnd()
    service.send('p1', 'a')
    await end
    end = waitEnd()
    service.send('p1', 'b')
    await end
    expect(runner.mock.calls[1]?.[0].resume).toBe('s-1')
  })
})

describe('sdk message extraction', () => {
  it('extracts text deltas only from text_delta stream events', () => {
    expect(
      extractTextDelta({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } })
    ).toBe('hi')
    expect(extractTextDelta({ type: 'assistant' })).toBeNull()
    expect(extractTextDelta({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta' } } })).toBeNull()
    expect(extractTextDelta(null)).toBeNull()
  })

  it('extracts session ids', () => {
    expect(extractSessionId({ session_id: 'abc' })).toBe('abc')
    expect(extractSessionId({ session_id: 5 })).toBeNull()
  })
})
