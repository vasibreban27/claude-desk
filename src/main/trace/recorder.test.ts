import { describe, expect, it, vi } from 'vitest'
import { createSessionRecorder, reportDenied, type TraceDraft, type TraceSessionMeta } from './recorder'

const META: TraceSessionMeta = {
  projectId: 'p',
  runId: 'r',
  taskId: 'T1',
  role: 'worker',
  session: 'worker',
  agent: 'node-developer',
  cwd: '/work/wt'
}

function setup(secrets: string[] = []) {
  const out: TraceDraft[] = []
  let t = 1000
  const rec = createSessionRecorder(META, (d) => out.push(d), { secrets: () => secrets, now: () => t })
  return { out, rec, tick: (ms: number) => (t += ms) }
}

const assistant = (content: unknown[], parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { id: 'm', content }
})
const user = (content: unknown[], parent: string | null = null) => ({ type: 'user', parent_tool_use_id: parent, message: { content } })

describe('createSessionRecorder', () => {
  it('records text, a tool call and its result with the time taken', () => {
    const { out, rec, tick } = setup()
    rec.message(assistant([{ type: 'text', text: 'Reading it.' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/work/wt/src/a.ts' } }]))
    tick(250)
    rec.message(user([{ type: 'tool_result', tool_use_id: 'tu1', content: 'const a = 1' }]))
    expect(out).toEqual([
      { taskId: 'T1', role: 'worker', session: 'worker', agent: 'node-developer', parentId: null, kind: 'text', text: 'Reading it.' },
      {
        taskId: 'T1',
        role: 'worker',
        session: 'worker',
        agent: 'node-developer',
        parentId: null,
        kind: 'tool',
        toolUseId: 'tu1',
        tool: 'Read',
        summary: 'src/a.ts',
        input: 'file_path: src/a.ts',
        diff: null,
        added: 0,
        removed: 0
      },
      {
        taskId: 'T1',
        role: 'worker',
        session: 'worker',
        agent: 'node-developer',
        parentId: null,
        kind: 'result',
        toolUseId: 'tu1',
        ok: true,
        denied: false,
        output: 'const a = 1',
        durationMs: 250
      }
    ])
  })

  it('records an edit diff and a failed result', () => {
    const { out, rec } = setup()
    rec.message(assistant([{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y\nz' } }]))
    rec.message(user([{ type: 'tool_result', tool_use_id: 'e1', is_error: true, content: [{ type: 'text', text: 'not found' }] }]))
    expect(out[0]).toMatchObject({ kind: 'tool', diff: '- x\n+ y\n+ z', added: 2, removed: 1 })
    expect(out[1]).toMatchObject({ kind: 'result', ok: false, denied: false, output: 'not found' })
  })

  it('names and nests subagent steps under the Agent call', () => {
    const { out, rec } = setup()
    rec.message(assistant([{ type: 'tool_use', id: 'ag', name: 'Agent', input: { subagent_type: 'flow:test-writer', prompt: 'p' } }]))
    rec.message(assistant([{ type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'x' } }], 'ag'))
    rec.message(user([{ type: 'tool_result', tool_use_id: 'g1', content: 'hit' }], 'ag'))
    rec.message(user([{ type: 'tool_result', tool_use_id: 'ag', content: 'done' }]))
    expect(out.map((e) => [e.kind, e.agent, e.parentId])).toEqual([
      ['tool', 'node-developer', null],
      ['tool', 'flow:test-writer', 'ag'],
      ['result', 'flow:test-writer', 'ag'],
      ['result', 'node-developer', null]
    ])
  })

  it('marks a denied call and uses the guard reason when the result is empty', () => {
    const { out, rec } = setup()
    rec.message(assistant([{ type: 'tool_use', id: 'b1', name: 'Write', input: { file_path: '.env', content: 'x' } }]))
    rec.denied('b1', 'Protected path: /work/wt/.env')
    rec.message(user([{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: '' }]))
    expect(out[1]).toMatchObject({ kind: 'result', ok: false, denied: true, output: 'Protected path: .env' })
  })

  it('records a session end with tokens and cost', () => {
    const { out, rec } = setup()
    rec.message({
      type: 'result',
      is_error: false,
      num_turns: 4,
      duration_ms: 1234.6,
      total_cost_usd: 0.05,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 }
    })
    expect(out[0]).toMatchObject({ kind: 'turn', ok: true, turns: 4, durationMs: 1235, inputTokens: 10, outputTokens: 20, cacheTokens: 35, costUsd: 0.05 })
  })

  it('hides secrets in text, inputs and outputs', () => {
    const { out, rec } = setup(['supersecret99'])
    rec.message(assistant([{ type: 'text', text: 'key supersecret99' }, { type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'echo supersecret99' } }]))
    rec.message(user([{ type: 'tool_result', tool_use_id: 'x', content: 'Authorization: Bearer abcdefghijk' }]))
    expect(JSON.stringify(out)).not.toContain('supersecret99')
    expect(JSON.stringify(out)).not.toContain('abcdefghijk')
  })

  it('ignores duplicates, junk and other message types, and never throws', () => {
    const { out, rec } = setup()
    const call = assistant([{ type: 'tool_use', id: 'd', name: 'Read', input: {} }])
    rec.message(call)
    rec.message(call)
    rec.message(user([{ type: 'tool_result', tool_use_id: 'd', content: 'a' }]))
    rec.message(user([{ type: 'tool_result', tool_use_id: 'd', content: 'a' }]))
    for (const junk of [null, 1, 'x', { type: 'assistant' }, { type: 'user', message: { content: 'str' } }, { type: 'stream_event' }]) {
      expect(() => rec.message(junk)).not.toThrow()
    }
    expect(out).toHaveLength(2)
  })

  it('survives a throwing writer', () => {
    const rec = createSessionRecorder(META, () => {
      throw new Error('boom')
    })
    expect(() => rec.message(assistant([{ type: 'text', text: 'hi' }]))).not.toThrow()
  })
})

describe('reportDenied', () => {
  it('passes the tool use id and reason', () => {
    const fn = vi.fn()
    reportDenied(fn, { tool_use_id: 'a' }, { hookSpecificOutput: { permissionDecisionReason: 'no' } })
    reportDenied(fn, { tool_use_id: 'b' }, {})
    reportDenied(fn, { tool_use_id: '' }, {})
    reportDenied(fn, null, {})
    reportDenied(undefined, { tool_use_id: 'c' }, {})
    expect(fn.mock.calls).toEqual([
      ['a', 'no'],
      ['b', null]
    ])
  })
})
