import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityDraft } from './activity'
import { ALLOWED_TOOLS } from './tools'

type Hooks = NonNullable<Options['hooks']>
interface Captured {
  options: Options
}

const state = vi.hoisted(() => ({
  captured: null as null | { options: unknown },
  script: (async function* () {}) as (options: unknown) => AsyncGenerator<unknown>
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { options: unknown }) => {
    state.captured = params
    return state.script(params.options)
  }
}))

import { buildHooks, sdkRunner, type RunnerItem } from './runner'

const run = (args: Partial<Parameters<typeof sdkRunner>[0]> = {}) =>
  sdkRunner({ prompt: 'p', cwd: '/w', pluginPath: '/plug', ...args })

async function collect(it: AsyncIterable<RunnerItem>): Promise<RunnerItem[]> {
  const out: RunnerItem[] = []
  for await (const i of it) out.push(i)
  return out
}

const call = async (hooks: Hooks, event: 'PreToolUse' | 'PostToolUse' | 'SubagentStop', input: unknown) => {
  const matcher = hooks[event]?.[0]
  if (!matcher) throw new Error('no matcher')
  const cb = matcher.hooks[0]
  if (!cb) throw new Error('no callback')
  return cb(input as never, undefined, { signal: new AbortController().signal })
}

const resultMsg = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  session_id: 's1',
  is_error: false,
  total_cost_usd: 0.02,
  duration_ms: 500,
  usage: { input_tokens: 3, output_tokens: 4 },
  modelUsage: {},
  ...extra
})

beforeEach(() => {
  state.captured = null
})

describe('sdkRunner options', () => {
  it('registers the guard with onFailure block, tracking with continue, and keeps existing options', async () => {
    state.script = async function* () {}
    const ctrl = new AbortController()
    await collect(run({ resume: 'sess', signal: ctrl.signal }))
    const { options } = state.captured as unknown as Captured
    expect(options.allowedTools).toEqual([...ALLOWED_TOOLS])
    expect(options.cwd).toBe('/w')
    expect(options.plugins).toEqual([{ type: 'local', path: '/plug' }])
    expect(options.includePartialMessages).toBe(true)
    expect(options.resume).toBe('sess')
    expect(options.abortController).toBeInstanceOf(AbortController)
    expect(options.hooks?.PreToolUse?.[0]?.onFailure).toBe('block')
    expect(options.hooks?.PostToolUse?.[0]?.onFailure).toBe('continue')
    expect(options.hooks?.SubagentStop?.[0]?.onFailure).toBe('continue')
  })

  it('aborts the SDK when the caller signal aborts', async () => {
    state.script = async function* () {}
    const ctrl = new AbortController()
    await collect(run({ signal: ctrl.signal }))
    const { options } = state.captured as unknown as Captured
    ctrl.abort()
    expect(options.abortController?.signal.aborted).toBe(true)
  })
})

describe('sdkRunner stream', () => {
  it('yields session, activity (from hooks), text and one usage in order', async () => {
    state.script = async function* (options) {
      const hooks = (options as Options).hooks as Hooks
      yield { type: 'system', session_id: 's1' }
      await call(hooks, 'PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_use_id: 'u1',
        tool_input: { file_path: 'a.ts' }
      })
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }
      yield resultMsg()
    }
    const items = await collect(run())
    expect(items.map((i) => i.kind)).toEqual(['session', 'activity', 'text', 'usage'])
    expect(items[1]).toMatchObject({ draft: { type: 'tool-started', tool: 'Read', summary: 'a.ts', agent: 'main' } })
    expect(items[3]).toMatchObject({ usage: { costUsd: 0.02, isError: false }, agents: [{ agent: 'main' }] })
  })

  it('yields usage before throwing when the result is an error', async () => {
    state.script = async function* () {
      yield resultMsg({ is_error: true })
    }
    const seen: string[] = []
    await expect(
      (async () => {
        for await (const i of run()) seen.push(i.kind)
      })()
    ).rejects.toThrow('sdk-result-error')
    expect(seen).toEqual(['session', 'usage'])
  })

  it('propagates a stream failure', async () => {
    state.script = async function* () {
      yield { type: 'system', session_id: 's' }
      throw new Error('network')
    }
    await expect(collect(run())).rejects.toThrow('network')
  })
})

describe('buildHooks', () => {
  const drafts = () => {
    const list: ActivityDraft[] = []
    return { list, hooks: buildHooks((d) => list.push(d)) }
  }

  it('guard allows Read and reports tool-started only', async () => {
    const { list, hooks } = drafts()
    const out = await call(hooks, 'PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'u', tool_input: {} })
    expect(out).toEqual({})
    expect(list.map((d) => d.type)).toEqual(['tool-started'])
  })

  it('guard denies Write, reporting tool-started then a denied tool-finished', async () => {
    const { list, hooks } = drafts()
    const out = await call(hooks, 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_use_id: 'u',
      tool_input: { file_path: 'x', content: 'SECRET' }
    })
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(list.map((d) => d.type)).toEqual(['tool-started', 'tool-finished'])
    expect(list[1]).toMatchObject({ denied: true, tool: 'Write' })
  })

  it('guard denies for subagent calls and labels them with the agent type', async () => {
    const { list, hooks } = drafts()
    const out = await call(hooks, 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'u',
      agent_id: 'a1',
      agent_type: 'reviewer',
      tool_input: { command: 'rm -rf /' }
    })
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(list.every((d) => d.agent === 'reviewer' && d.agentId === 'a1')).toBe(true)
  })

  it('guard denies malformed input without throwing', async () => {
    const { hooks } = drafts()
    const out = await call(hooks, 'PreToolUse', null)
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })

  it('a throwing emitter never breaks the guard or tracking hooks', async () => {
    const hooks = buildHooks(() => {
      throw new Error('queue broke')
    })
    await expect(
      call(hooks, 'PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'u', tool_input: {} })
    ).resolves.toEqual({})
    await expect(
      call(hooks, 'PostToolUse', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'u' })
    ).resolves.toEqual({})
  })

  it('PostToolUse and SubagentStop map to tool-finished and agent-finished', async () => {
    const { list, hooks } = drafts()
    await call(hooks, 'PostToolUse', { hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_use_id: 'u', duration_ms: 12 })
    await call(hooks, 'SubagentStop', {
      hook_event_name: 'SubagentStop',
      agent_id: 'a1',
      agent_type: 'reviewer',
      last_assistant_message: 'done'
    })
    expect(list).toMatchObject([
      { type: 'tool-finished', durationMs: 12, denied: false },
      { type: 'agent-finished', summary: 'done', agent: 'reviewer' }
    ])
  })
})
