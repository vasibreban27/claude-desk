import { describe, expect, it, vi } from 'vitest'
import { ACTIVITY_BUFFER_MAX, type ActivityEvent, type ChatEvent } from '../../shared/ipc'
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

const usageItem = (isError = false): RunnerItem => ({
  kind: 'usage',
  usage: {
    costUsd: 0.01,
    durationMs: 1200,
    isError,
    models: [],
    mainTokens: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 }
  },
  agents: []
})
const toolStarted = (id: string): RunnerItem => ({
  kind: 'activity',
  draft: { agent: 'main', agentId: null, type: 'tool-started', toolUseId: id, tool: 'Read', summary: 'a.ts' }
})

function setupActivity(runner: ChatRunner, recordRun: (i: unknown) => void = () => {}) {
  const activity: ActivityEvent[] = []
  let done: () => void = () => {}
  let ended = new Promise<void>((r) => (done = r))
  const service = new ChatService({
    resolveProjectPath: (id) => paths[id],
    runner,
    emit: (e) => {
      if (e.type !== 'text-delta') done()
    },
    emitActivity: (e) => activity.push(e),
    runStore: { recordRun },
    loadConfig: () => ({ ok: true, config: { toolkitPath: TOOLKIT } })
  })
  const run = async (project = 'p1') => {
    ended = new Promise<void>((r) => (done = r))
    service.send(project, 'go')
    await ended
  }
  return { service, activity, run }
}

describe('ChatService activity and usage', () => {
  it('emits run-started (seq 0), increasing seq, then one run-finished with one runId', async () => {
    const { activity, run } = setupActivity(streamOf([toolStarted('t1'), { kind: 'text', text: 'x' }, usageItem()]))
    await run()
    expect(activity.map((e) => e.type)).toEqual(['run-started', 'tool-started', 'run-finished'])
    expect(activity.map((e) => e.seq)).toEqual([0, 1, 2])
    expect(new Set(activity.map((e) => e.runId)).size).toBe(1)
    expect(activity.at(-1)).toMatchObject({ status: 'success', costUsd: 0.01, durationMs: 1200 })
  })

  it('finishes with status error when the usage says is_error, and still records usage', async () => {
    const recordRun = vi.fn()
    const runner: ChatRunner = async function* () {
      yield usageItem(true)
      throw new Error('sdk-result-error')
    }
    const { activity, run } = setupActivity(runner, recordRun)
    await run()
    expect(activity.filter((e) => e.type === 'run-finished')).toHaveLength(1)
    expect(activity.at(-1)).toMatchObject({ type: 'run-finished', status: 'error' })
    expect(recordRun).toHaveBeenCalledTimes(1)
  })

  it('finishes with error and records nothing when the runner throws before any usage', async () => {
    const recordRun = vi.fn()
    const runner: ChatRunner = async function* () {
      yield toolStarted('t1')
      throw new Error('boom')
    }
    const { activity, run } = setupActivity(runner, recordRun)
    await run()
    expect(activity.at(-1)).toMatchObject({ type: 'run-finished', status: 'error', costUsd: null })
    expect(recordRun).not.toHaveBeenCalled()
  })

  it('keeps the newest ACTIVITY_BUFFER_MAX events in order and replaces the buffer on the next run', async () => {
    const many: RunnerItem[] = Array.from({ length: ACTIVITY_BUFFER_MAX + 20 }, (_, i) => toolStarted(`t${i}`))
    const { service, run } = setupActivity(streamOf(many))
    await run()
    const h = service.activityHistory('p1')
    expect(h).toHaveLength(ACTIVITY_BUFFER_MAX)
    expect(h.at(-1)?.type).toBe('run-finished')
    expect(h.map((e) => e.seq)).toEqual([...h.map((e) => e.seq)].sort((a, b) => a - b))
    expect(h[0]?.seq).toBeGreaterThan(0)
    await run()
    expect(service.activityHistory('p1').length).toBeGreaterThan(0)
    expect(service.activityHistory('p1')[0]?.seq).toBeGreaterThan(0)
    const second = setupActivity(streamOf([]))
    await second.run()
    expect(second.service.activityHistory('p1').map((e) => e.type)).toEqual(['run-started', 'run-finished'])
    expect(second.service.activityHistory('nope')).toEqual([])
  })

  it('records usage once per run via the store', async () => {
    const recordRun = vi.fn()
    const { run } = setupActivity(streamOf([usageItem()]), recordRun)
    await run()
    expect(recordRun).toHaveBeenCalledTimes(1)
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', runId: expect.any(String), startedAt: expect.any(Number) })
    )
  })

  it('still ends the turn with done when recordRun throws', async () => {
    const chat: ChatEvent[] = []
    let done: () => void = () => {}
    const ended = new Promise<void>((r) => (done = r))
    const service = new ChatService({
      resolveProjectPath: (id) => paths[id],
      runner: streamOf([usageItem()]),
      emit: (e) => {
        chat.push(e)
        if (e.type !== 'text-delta') done()
      },
      runStore: {
        recordRun: () => {
          throw new Error('disk full /secret/path')
        }
      },
      loadConfig: () => ({ ok: true, config: { toolkitPath: TOOLKIT } })
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    service.send('p1', 'x')
    await ended
    expect(chat.at(-1)?.type).toBe('done')
    expect(spy.mock.calls.flat().join(' ')).not.toContain('secret')
    spy.mockRestore()
  })

  it('does not break the run when the activity emitter throws', async () => {
    const chat: ChatEvent[] = []
    let done: () => void = () => {}
    const ended = new Promise<void>((r) => (done = r))
    const service = new ChatService({
      resolveProjectPath: (id) => paths[id],
      runner: streamOf([toolStarted('t')]),
      emit: (e) => {
        chat.push(e)
        if (e.type !== 'text-delta') done()
      },
      emitActivity: () => {
        throw new Error('window gone')
      },
      loadConfig: () => ({ ok: true, config: { toolkitPath: TOOLKIT } })
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    service.send('p1', 'x')
    await ended
    expect(chat.at(-1)?.type).toBe('done')
    spy.mockRestore()
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

describe('ChatService tool-finished dedupe', () => {
  it('emits at most one tool-finished per toolUseId', async () => {
    const finished = (denied: boolean): RunnerItem => ({
      kind: 'activity',
      draft: { agent: 'main', agentId: null, type: 'tool-finished', toolUseId: 't1', tool: 'Read', durationMs: null, denied }
    })
    const { activity, run } = setupActivity(streamOf([toolStarted('t1'), finished(true), finished(false), usageItem()]))
    await run()
    expect(activity.filter((e) => e.type === 'tool-finished')).toHaveLength(1)
    expect(activity.map((e) => e.seq)).toEqual(activity.map((_, i) => i))
  })
})
