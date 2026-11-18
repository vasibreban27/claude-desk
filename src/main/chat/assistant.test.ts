import { describe, expect, it, vi } from 'vitest'
import { CREATE_PROJECT_TOOL, assistantGuard, assistantOptions } from './assistant'

const call = (tool_name: string) => assistantGuard({ hook_event_name: 'PreToolUse', tool_name, tool_input: {} } as never, undefined, { signal: new AbortController().signal })

describe('assistant', () => {
  it('allows only create_project', async () => {
    expect(await call(CREATE_PROJECT_TOOL)).toEqual({})
    for (const t of ['Bash', 'Read', 'Write', 'mcp__claude_ai_Gmail__search']) {
      expect(await call(t)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    }
  })

  it('has no built-in tools and only the proposal tool allowed', () => {
    const o = assistantOptions(vi.fn())
    expect(o.tools).toEqual([])
    expect(o.allowedTools).toEqual([CREATE_PROJECT_TOOL])
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['assistant'])
  })
})
