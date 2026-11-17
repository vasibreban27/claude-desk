import { describe, expect, it } from 'vitest'
import {
  createUsageAccumulator,
  mapDeniedToolUse,
  mapHookInput,
  parseResultMessage
} from './activity'

const pre = (extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_use_id: 'tu1',
  tool_input: { file_path: '/a/b.ts' },
  ...extra
})

describe('mapHookInput', () => {
  it('maps PreToolUse with the file path as summary', () => {
    expect(mapHookInput(pre())).toEqual({
      agent: 'main',
      agentId: null,
      type: 'tool-started',
      toolUseId: 'tu1',
      tool: 'Read',
      summary: '/a/b.ts'
    })
  })

  it('truncates the summary to 200 chars', () => {
    const e = mapHookInput(pre({ tool_input: { file_path: 'x'.repeat(500) } }))
    expect(e?.type === 'tool-started' && e.summary.length).toBe(200)
  })

  it('uses the first present allowlisted key and ignores other keys', () => {
    const e = mapHookInput(pre({ tool_input: { pattern: 'foo', file_path: '/p' } }))
    expect(e?.type === 'tool-started' && e.summary).toBe('/p')
    const other = mapHookInput(pre({ tool_input: { command: 'rm -rf dir', content: 'TOKEN' } }))
    expect(other?.type === 'tool-started' && other.summary).toBe('')
    expect(JSON.stringify(other)).not.toContain('TOKEN')
    expect(JSON.stringify(other)).not.toContain('rm -rf')
  })

  it('handles a non-object tool_input', () => {
    const e = mapHookInput(pre({ tool_input: 'str' }))
    expect(e?.type === 'tool-started' && e.summary).toBe('')
  })

  it('labels subagents by type and id', () => {
    const e = mapHookInput(pre({ agent_id: 'a1', agent_type: 'reviewer' }))
    expect(e).toMatchObject({ agent: 'reviewer', agentId: 'a1' })
    expect(mapHookInput(pre({ agent_id: 'a1' }))).toMatchObject({ agent: 'subagent', agentId: 'a1' })
    expect(mapHookInput(pre({ agent_type: 'reviewer' }))).toMatchObject({
      agent: 'main',
      agentId: null
    })
  })

  it('maps PostToolUse with duration and never includes the response', () => {
    const e = mapHookInput({
      hook_event_name: 'PostToolUse',
      tool_name: 'Grep',
      tool_use_id: 'tu2',
      tool_response: 'FILE CONTENT',
      duration_ms: 12.4
    })
    expect(e).toEqual({
      agent: 'main',
      agentId: null,
      type: 'tool-finished',
      toolUseId: 'tu2',
      tool: 'Grep',
      durationMs: 12,
      denied: false
    })
  })

  it('uses null duration when missing', () => {
    const e = mapHookInput({ hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_use_id: 't' })
    expect(e).toMatchObject({ durationMs: null })
  })

  it('maps SubagentStop and truncates the summary', () => {
    const e = mapHookInput({
      hook_event_name: 'SubagentStop',
      agent_id: 'a1',
      agent_type: 'reviewer',
      last_assistant_message: 'y'.repeat(300)
    })
    expect(e).toMatchObject({ type: 'agent-finished', agent: 'reviewer', agentId: 'a1' })
    expect(e?.type === 'agent-finished' && e.summary.length).toBe(200)
  })

  it('produces nothing for the main Stop and for malformed input', () => {
    expect(mapHookInput({ hook_event_name: 'Stop' })).toBeNull()
    for (const bad of [null, undefined, 'x', 5, [], {}, { hook_event_name: 'PreToolUse' }]) {
      expect(mapHookInput(bad)).toBeNull()
    }
    expect(mapHookInput({ hook_event_name: 'PostToolUse', tool_name: 'x' })).toBeNull()
  })
})

describe('mapDeniedToolUse', () => {
  it('maps to a denied tool-finished', () => {
    expect(mapDeniedToolUse(pre({ tool_name: 'Write' }))).toMatchObject({
      type: 'tool-finished',
      tool: 'Write',
      denied: true,
      durationMs: null
    })
    expect(mapDeniedToolUse({})).toBeNull()
  })
})

const assistant = (
  id: string | undefined,
  usage: Record<string, number>,
  extra: Record<string, unknown> = {}
) => ({
  type: 'assistant',
  message: { ...(id ? { id } : {}), usage, content: [] },
  parent_tool_use_id: null,
  ...extra
})

describe('createUsageAccumulator', () => {
  it('counts messages sharing an id once', () => {
    const acc = createUsageAccumulator()
    const m = assistant('m1', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5 })
    acc.add(m)
    acc.add(m)
    acc.add(assistant('m2', { input_tokens: 2, cache_creation_input_tokens: 3 }))
    expect(acc.agents()).toEqual([
      {
        agent: 'main',
        steps: 2,
        inputTokens: 12,
        outputTokens: 1,
        cacheReadTokens: 5,
        cacheCreationTokens: 3,
        approximate: true
      }
    ])
  })

  it('attributes parent_tool_use_id messages to the subagent type', () => {
    const acc = createUsageAccumulator()
    acc.add({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'm1',
        usage: { input_tokens: 1 },
        content: [
          { type: 'tool_use', id: 'tu9', name: 'Agent', input: { subagent_type: 'reviewer' } }
        ]
      }
    })
    acc.add(assistant('s1', { input_tokens: 100, output_tokens: 4 }, { parent_tool_use_id: 'tu9' }))
    acc.add(assistant('s2', { input_tokens: 50 }, { parent_tool_use_id: 'tu9' }))
    acc.add(assistant('x1', { input_tokens: 7 }, { parent_tool_use_id: 'unknown' }))
    const agents = acc.agents()
    expect(agents.find((a) => a.agent === 'reviewer')).toMatchObject({
      steps: 2,
      inputTokens: 150,
      outputTokens: 4,
      approximate: true
    })
    expect(agents.find((a) => a.agent === 'subagent')).toMatchObject({ steps: 1, inputTokens: 7 })
    expect(agents.find((a) => a.agent === 'main')).toMatchObject({ steps: 1, inputTokens: 1 })
  })

  it('counts the same id under different parents separately', () => {
    const acc = createUsageAccumulator()
    acc.add(assistant('m1', { input_tokens: 1 }))
    acc.add(assistant('m1', { input_tokens: 1 }, { parent_tool_use_id: 'tu' }))
    expect(acc.agents().reduce((n, a) => n + a.steps, 0)).toBe(2)
  })

  it('ignores non-assistant, malformed and id-less messages', () => {
    const acc = createUsageAccumulator()
    const bads: unknown[] = [
      null,
      'x',
      { type: 'user' },
      { type: 'assistant' },
      assistant(undefined, { input_tokens: 5 })
    ]
    for (const bad of bads) acc.add(bad)
    expect(acc.agents()).toEqual([])
  })

  it('overrides main totals with the result usage and keeps subagents approximate', () => {
    const acc = createUsageAccumulator()
    acc.add(assistant('m1', { input_tokens: 1, output_tokens: 1 }))
    acc.add(assistant('s1', { input_tokens: 9 }, { parent_tool_use_id: 'tu' }))
    const main = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 7, cacheCreationTokens: 3 }
    const agents = acc.agents(main)
    expect(agents.find((a) => a.agent === 'main')).toMatchObject({
      ...main,
      steps: 1,
      approximate: false
    })
    expect(agents.find((a) => a.agent === 'subagent')?.approximate).toBe(true)
    expect(createUsageAccumulator().agents(main)[0]).toMatchObject({
      agent: 'main',
      steps: 0,
      ...main
    })
  })
})

describe('parseResultMessage', () => {
  it('extracts cost, per-model usage and main-loop tokens', () => {
    const r = parseResultMessage({
      type: 'result',
      is_error: false,
      total_cost_usd: 0.0123,
      duration_ms: 4500,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40
      },
      modelUsage: {
        'claude-x': {
          inputTokens: 1,
          outputTokens: 2,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 4,
          costUSD: 0.01
        },
        bad: 'nope'
      }
    })
    expect(r).toEqual({
      costUsd: 0.0123,
      durationMs: 4500,
      isError: false,
      models: [
        {
          model: 'claude-x',
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheCreationTokens: 4,
          costUsd: 0.01
        }
      ],
      mainTokens: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40 }
    })
  })

  it('flags errors and tolerates missing fields', () => {
    expect(parseResultMessage({ type: 'result', is_error: true })).toEqual({
      costUsd: null,
      durationMs: null,
      isError: true,
      models: [],
      mainTokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
    })
  })

  it('returns null for other messages', () => {
    expect(parseResultMessage({ type: 'assistant' })).toBeNull()
    expect(parseResultMessage(null)).toBeNull()
  })
})

describe('review fixes (S1, F1-F4)', () => {
  it('caps identifiers at 100 chars', () => {
    const long = 'a'.repeat(500)
    const e = mapHookInput(
      pre({ tool_name: long, tool_use_id: long, agent_id: long, agent_type: long })
    ) as Record<string, unknown>
    expect((e['tool'] as string).length).toBe(100)
    expect((e['toolUseId'] as string).length).toBe(100)
    expect((e['agentId'] as string).length).toBe(100)
    expect((e['agent'] as string).length).toBe(100)
  })

  it('falls back to "subagent" for an invalid model-written subagent_type', () => {
    const toolUse = (t: unknown) => ({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'm', usage: {}, content: [{ type: 'tool_use', id: 'tu', name: 'Agent', input: { subagent_type: t } }] }
    })
    const child = { type: 'assistant', parent_tool_use_id: 'tu', message: { id: 's1', usage: { input_tokens: 1 }, content: [] } }
    for (const bad of ['bad name\nwith <html>', 'x'.repeat(101)]) {
      const acc = createUsageAccumulator()
      acc.add(toolUse(bad))
      acc.add(child)
      expect(acc.agents().map((a) => a.agent).sort()).toEqual(['main', 'subagent'])
    }
  })

  it('marks main approximate without a result override', () => {
    const acc = createUsageAccumulator()
    acc.add({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', usage: { input_tokens: 1 }, content: [] } })
    expect(acc.agents()[0]).toMatchObject({ agent: 'main', approximate: true })
    const main = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }
    expect(acc.agents(main)[0]).toMatchObject({ approximate: false })
  })

  it('maps PostToolUseFailure to tool-finished without error content', () => {
    const d = mapHookInput({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Read',
      tool_use_id: 'u',
      error: 'ERR-BODY',
      tool_response: 'RESP-BODY'
    })
    expect(d).toEqual({
      agent: 'main',
      agentId: null,
      type: 'tool-finished',
      toolUseId: 'u',
      tool: 'Read',
      durationMs: null,
      denied: false
    })
  })

  it('does not leave a lone high surrogate when truncating', () => {
    const s = 'x'.repeat(199) + '\u{1F600}'
    const e = mapHookInput(pre({ tool_input: { file_path: s } })) as { summary: string }
    expect(e.summary).toBe('x'.repeat(199))
  })

  it('dedupes assistant steps by uuid when message.id is missing', () => {
    const acc = createUsageAccumulator()
    const m = { type: 'assistant', uuid: 'u1', parent_tool_use_id: null, message: { usage: { input_tokens: 4 }, content: [] } }
    acc.add(m)
    acc.add(m)
    expect(acc.agents()[0]).toMatchObject({ steps: 1, inputTokens: 4 })
  })
})
