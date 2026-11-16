import { describe, expect, it } from 'vitest'
import { ALLOWED_TOOLS, guardPreToolUse, isDenied } from './tools'

describe('guardPreToolUse', () => {
  it.each(['Read', 'Grep', 'Glob', 'Agent', 'Task', 'Skill'])('allows %s', (tool_name) => {
    expect(guardPreToolUse({ hook_event_name: 'PreToolUse', tool_name })).toEqual({})
  })

  it.each(['Write', 'Edit', 'Bash', 'NotebookEdit', 'WebFetch', 'mcp__x__y', 'read'])(
    'denies %s with a reason',
    (tool_name) => {
      const out = guardPreToolUse({ tool_name })
      expect(out.hookSpecificOutput?.hookEventName).toBe('PreToolUse')
      expect(out.hookSpecificOutput?.permissionDecision).toBe('deny')
      expect(out.hookSpecificOutput?.permissionDecisionReason).toBeTruthy()
      expect(isDenied(out)).toBe(true)
    }
  )

  it.each([undefined, null, 'Read', 5, {}, { tool_name: 3 }, { tool_name: '' }])(
    'denies malformed input %j',
    (input) => {
      expect(isDenied(guardPreToolUse(input))).toBe(true)
    }
  )

  it('exposes the allowlist', () => {
    expect([...ALLOWED_TOOLS]).toEqual(['Read', 'Grep', 'Glob', 'Agent', 'Task', 'Skill'])
  })
})
