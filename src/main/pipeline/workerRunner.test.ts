import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type ProjectSettings } from '../../shared/settings'
import type { PlanTask } from './planParser'
import { buildWorkerPrompt } from './prompts'
import {
  WORKER_BUILTIN_TOOLS,
  buildWorkerOptions,
  createWorkerRunner,
  type QueryLike,
  type WorkerRunArgs
} from './workerRunner'

const task: PlanTask = {
  id: 'T7',
  title: 'Serial orchestrator',
  worker: 'node-developer',
  owns: ['src/a.ts', 'src/dir/'],
  dependsOn: [],
  acceptance: ['it runs', 'it stops'],
  contract: 'none'
}

const baseArgs = (settings: ProjectSettings = defaultSettings(), signal?: AbortSignal): WorkerRunArgs => ({
  task,
  worktree: process.cwd(),
  branch: 'task/abcd1234-t7',
  settings,
  pluginPath: '/plugin',
  ...(signal ? { signal } : {})
})

const result = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 4,
  total_cost_usd: 0.02,
  ...extra
})

function fakeQuery(messages: unknown[], opts: { throwAfter?: Error; hang?: boolean } = {}) {
  const close = vi.fn()
  let release: (() => void) | null = null
  const q: QueryLike = {
    close: () => {
      close()
      release?.()
    },
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m
      if (opts.hang) await new Promise<void>((r) => (release = r))
      if (opts.throwAfter) throw opts.throwAfter
    }
  }
  return { q, close }
}

describe('buildWorkerOptions', () => {
  it('builds the sandboxed session options', () => {
    const ac = new AbortController()
    const settings = { ...defaultSettings(), model: 'haiku' as const }
    const { options, prompt } = buildWorkerOptions(baseArgs(settings), ac)
    expect(options.cwd).toBe(process.cwd())
    expect(options.maxTurns).toBe(40)
    expect(options.model).toBe('haiku')
    expect(options.settingSources).toEqual([])
    expect(options.permissionMode).toBe('acceptEdits')
    expect(options.plugins).toEqual([{ type: 'local', path: '/plugin' }])
    expect(options.tools).toEqual([...WORKER_BUILTIN_TOOLS])
    expect(options.tools).not.toContain('Bash')
    expect(options.allowedTools).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Write',
      'Edit',
      'mcp__work__run_check',
      'mcp__work__git_commit',
      'mcp__work__report_blocked'
    ])
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['work'])
    expect(options).not.toHaveProperty('agent')
    expect(options.abortController).toBe(ac)
    expect(options.hooks?.PreToolUse?.[0]?.onFailure).toBe('block')
    expect(prompt).toBe(buildWorkerPrompt(task))
  })

  it('omits model for auto and wires the guard', async () => {
    const { options } = buildWorkerOptions(baseArgs(), new AbortController())
    expect(options).not.toHaveProperty('model')
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0]
    const denied = await hook?.({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } } as never, undefined, {
      signal: new AbortController().signal
    })
    expect(JSON.stringify(denied)).toContain('deny')
  })

  it('picks the model: task over project, auto means none, unknown ignored', () => {
    const build = (taskModel: unknown, project: ProjectSettings['model']) =>
      buildWorkerOptions(
        { ...baseArgs({ ...defaultSettings(), model: project }), task: { ...task, model: taskModel as 'haiku' } },
        new AbortController()
      ).options
    expect(build('haiku', 'sonnet').model).toBe('haiku')
    expect(build(undefined, 'sonnet').model).toBe('sonnet')
    expect(build(undefined, 'auto')).not.toHaveProperty('model')
    expect(build('opus', 'auto').model).toBe('opus')
    expect(build('gpt', 'auto')).not.toHaveProperty('model')
    expect(build('gpt', 'sonnet').model).toBe('sonnet')
  })

  it('puts title, criteria, owns, contract and the report_blocked rule in the prompt', () => {
    const p = buildWorkerPrompt(task)
    for (const s of ['Serial orchestrator', 'it runs', 'it stops', 'src/a.ts', 'src/dir/', 'Contract:', 'report_blocked']) {
      expect(p).toContain(s)
    }
  })
})

describe('createWorkerRunner', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reports a finished session with turns and cost', async () => {
    const { q } = fakeQuery([{ type: 'assistant' }, result()])
    const run = createWorkerRunner({ queryFn: () => q })
    expect(await run(baseArgs())).toMatchObject({ status: 'finished', turns: 4, costUsd: 0.02, checksResult: 'none', blocked: null })
  })

  it('maps error_max_turns and the thrown error to limit', async () => {
    const { q } = fakeQuery([result({ subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (40)'] })], {
      throwAfter: new Error('Claude Code returned an error result: Reached maximum number of turns (40)')
    })
    expect((await createWorkerRunner({ queryFn: () => q })(baseArgs())).status).toBe('limit')
  })

  it('maps another error result (with the throw after it) to error', async () => {
    const { q } = fakeQuery([result({ subtype: 'error_during_execution', is_error: true, errors: ['kaput'] })], {
      throwAfter: new Error('Claude Code returned an error result: kaput')
    })
    expect(await createWorkerRunner({ queryFn: () => q })(baseArgs())).toMatchObject({ status: 'error', error: 'kaput' })
  })

  it('maps a thrown error and a missing result to error', async () => {
    const a = fakeQuery([], { throwAfter: new Error('spawn failed') })
    expect(await createWorkerRunner({ queryFn: () => a.q })(baseArgs())).toMatchObject({ status: 'error', error: 'spawn failed' })
    const b = fakeQuery([{ type: 'assistant' }])
    expect((await createWorkerRunner({ queryFn: () => b.q })(baseArgs())).status).toBe('error')
    expect(
      (
        await createWorkerRunner({
          queryFn: () => {
            throw new Error('nope')
          }
        })(baseArgs())
      ).status
    ).toBe('error')
  })

  it('closes the session and reports limit when the time cap passes', async () => {
    const { q, close } = fakeQuery([{ type: 'assistant' }], { hang: true })
    const p = createWorkerRunner({ queryFn: () => q })(baseArgs())
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000 + 1)
    const out = await p
    expect(close).toHaveBeenCalled()
    expect(out.status).toBe('limit')
  })

  it('applies maxTurns and the time cap from settings; deps override', async () => {
    const settings = { ...defaultSettings(), maxTurns: 12, taskTimeoutMinutes: 3 }
    const seen: number[] = []
    const a = fakeQuery([{ type: 'assistant' }], { hang: true })
    const p = createWorkerRunner({
      queryFn: (params) => {
        seen.push(params.options.maxTurns ?? -1)
        return a.q
      }
    })(baseArgs(settings))
    await vi.advanceTimersByTimeAsync(180000 - 1)
    expect(a.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect((await p).status).toBe('limit')
    expect(seen).toEqual([12])

    const b = fakeQuery([{ type: 'assistant' }], { hang: true })
    const p2 = createWorkerRunner({ queryFn: () => b.q, timeCapMs: 1000, maxTurns: 7 })(baseArgs(settings))
    await vi.advanceTimersByTimeAsync(1001)
    expect((await p2).status).toBe('limit')
    expect(buildWorkerOptions(baseArgs({ ...settings, maxTurns: undefined }), new AbortController()).options.maxTurns).toBe(40)
  })

  it('runs two runners independently (one cancelled, one finished)', async () => {
    const ac = new AbortController()
    const a = fakeQuery([{ type: 'assistant' }], { hang: true })
    const b = fakeQuery([{ type: 'assistant' }, result()])
    const pa = createWorkerRunner({ queryFn: () => a.q })(baseArgs(defaultSettings(), ac.signal))
    const pb = createWorkerRunner({ queryFn: () => b.q })(baseArgs())
    await vi.advanceTimersByTimeAsync(10)
    ac.abort()
    expect((await pa).status).toBe('cancelled')
    expect((await pb).status).toBe('finished')
    expect(b.close).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the timer when the session ends', async () => {
    const { q } = fakeQuery([result()])
    await createWorkerRunner({ queryFn: () => q })(baseArgs())
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes the session and reports cancelled on abort', async () => {
    const ac = new AbortController()
    const { q, close } = fakeQuery([{ type: 'assistant' }], { hang: true })
    const p = createWorkerRunner({ queryFn: () => q })(baseArgs(defaultSettings(), ac.signal))
    await vi.advanceTimersByTimeAsync(10)
    ac.abort()
    expect((await p).status).toBe('cancelled')
    expect(close).toHaveBeenCalled()
  })

  it('does not start when already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const queryFn = vi.fn()
    expect((await createWorkerRunner({ queryFn })(baseArgs(defaultSettings(), ac.signal))).status).toBe('cancelled')
    expect(queryFn).not.toHaveBeenCalled()
  })
})
