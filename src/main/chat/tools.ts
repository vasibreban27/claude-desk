/** Tool allowlist and the deny-by-default PreToolUse guard for chat runs (Phase 2: read-only). */

export const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Agent', 'Task', 'Skill'] as const

const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_TOOLS)

export interface GuardOutput {
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse'
    permissionDecision: 'deny'
    permissionDecisionReason: string
  }
}

function deny(reason: string): GuardOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }
}

export function isToolAllowed(name: string): boolean {
  return ALLOWED_SET.has(name)
}

/** Fails closed: anything not explicitly allowed, or malformed, is denied. Never throws. */
export function guardPreToolUse(input: unknown): GuardOutput {
  if (typeof input !== 'object' || input === null) return deny('Malformed tool request.')
  const name = (input as Record<string, unknown>)['tool_name']
  if (typeof name !== 'string' || name.length === 0) return deny('Malformed tool request.')
  if (isToolAllowed(name)) return {}
  return deny(`Tool "${name}" is not allowed in chat: only read-only tools, agents and skills are.`)
}

/** True when a guard result denies the call. */
export function isDenied(output: GuardOutput): boolean {
  return output.hookSpecificOutput?.permissionDecision === 'deny'
}
