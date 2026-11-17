import type { ActivityEventBody } from '../../shared/ipc'

/** Pure mapping of SDK hook inputs and messages. All inputs are `unknown` and validated here. */

export const SUMMARY_MAX = 200
const SUMMARY_KEYS = ['file_path', 'path', 'pattern', 'description', 'subagent_type', 'skill']
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])

/** Event without the fields the service stamps (projectId, runId, seq, at). */
export type ActivityDraft = { agent: string; agentId: string | null } & ActivityEventBody

type Rec = Record<string, unknown>

function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

const ID_MAX = 100
const SUBAGENT_TYPE_RE = /^[\w:.-]{1,100}$/

/** Cuts to `max` UTF-16 units without leaving a lone high surrogate. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s
  const code = s.charCodeAt(max - 1)
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}

function truncate(s: string): string {
  return cut(s, SUMMARY_MAX)
}

/** Identifier-like string capped at 100 chars. */
function ident(v: unknown): string | null {
  const s = str(v)
  return s === null ? null : cut(s, ID_MAX)
}

/** Summary from allowlisted tool_input keys only; never from tool_response. */
export function summarizeToolInput(toolInput: unknown): string {
  if (!isRecord(toolInput)) return ''
  for (const key of SUMMARY_KEYS) {
    const v = toolInput[key]
    if (typeof v === 'string' && v.length > 0) return truncate(v)
  }
  return ''
}

function agentOf(input: Rec): { agent: string; agentId: string | null } {
  const agentId = ident(input['agent_id'])
  if (agentId === null) return { agent: 'main', agentId: null }
  return { agent: ident(input['agent_type']) ?? 'subagent', agentId }
}

/** Maps a hook input to an activity draft; null for unknown or malformed input. */
export function mapHookInput(input: unknown): ActivityDraft | null {
  if (!isRecord(input)) return null
  const event = input['hook_event_name']
  const who = agentOf(input)
  switch (event) {
    case 'PreToolUse': {
      const tool = ident(input['tool_name'])
      const toolUseId = ident(input['tool_use_id'])
      if (!tool || !toolUseId) return null
      return {
        ...who,
        type: 'tool-started',
        toolUseId,
        tool,
        summary: summarizeToolInput(input['tool_input'])
      }
    }
    case 'PostToolUse': {
      const tool = ident(input['tool_name'])
      const toolUseId = ident(input['tool_use_id'])
      if (!tool || !toolUseId) return null
      const d = input['duration_ms']
      const durationMs = typeof d === 'number' && Number.isFinite(d) && d >= 0 ? Math.round(d) : null
      return { ...who, type: 'tool-finished', toolUseId, tool, durationMs, denied: false }
    }
    case 'PostToolUseFailure': {
      // Never reads error or tool_response content.
      const tool = ident(input['tool_name'])
      const toolUseId = ident(input['tool_use_id'])
      if (!tool || !toolUseId) return null
      return { ...who, type: 'tool-finished', toolUseId, tool, durationMs: null, denied: false }
    }
    case 'SubagentStop': {
      if (who.agentId === null) return null
      const last = input['last_assistant_message']
      return { ...who, type: 'agent-finished', summary: typeof last === 'string' ? truncate(last) : '' }
    }
    default:
      return null
  }
}

/** A tool call the guard denied: a tool-finished with `denied: true`. */
export function mapDeniedToolUse(input: unknown): ActivityDraft | null {
  if (!isRecord(input)) return null
  const tool = ident(input['tool_name'])
  const toolUseId = ident(input['tool_use_id'])
  if (!tool || !toolUseId) return null
  return { ...agentOf(input), type: 'tool-finished', toolUseId, tool, durationMs: null, denied: true }
}

// --- Usage ------------------------------------------------------------------

export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface AgentUsage extends TokenCounts {
  agent: string
  steps: number
  /** True when output tokens come from per-step placeholders. */
  approximate: boolean
}

export interface ModelUsage extends TokenCounts {
  model: string
  costUsd: number
}

export interface RunUsage {
  /** result.total_cost_usd (includes subagents); null if absent. */
  costUsd: number | null
  durationMs: number | null
  isError: boolean
  /** result.modelUsage (includes subagents). */
  models: ModelUsage[]
  /** result.usage: main loop only, exact. */
  mainTokens: TokenCounts
}

const zeroTokens = (): TokenCounts => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0
})

/** Result message to RunUsage; null when it is not a result message. */
export function parseResultMessage(message: unknown): RunUsage | null {
  if (!isRecord(message) || message['type'] !== 'result') return null
  const cost = message['total_cost_usd']
  const dur = message['duration_ms']
  const usage = message['usage']
  const mainTokens = isRecord(usage)
    ? {
        inputTokens: num(usage['input_tokens']),
        outputTokens: num(usage['output_tokens']),
        cacheReadTokens: num(usage['cache_read_input_tokens']),
        cacheCreationTokens: num(usage['cache_creation_input_tokens'])
      }
    : zeroTokens()
  const models: ModelUsage[] = []
  const mu = message['modelUsage']
  if (isRecord(mu)) {
    for (const [model, v] of Object.entries(mu)) {
      if (!isRecord(v)) continue
      models.push({
        model,
        costUsd: num(v['costUSD']),
        inputTokens: num(v['inputTokens']),
        outputTokens: num(v['outputTokens']),
        cacheReadTokens: num(v['cacheReadInputTokens']),
        cacheCreationTokens: num(v['cacheCreationInputTokens'])
      })
    }
  }
  return {
    costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
    durationMs: typeof dur === 'number' && Number.isFinite(dur) && dur >= 0 ? Math.round(dur) : null,
    isError: message['is_error'] === true,
    models,
    mainTokens
  }
}

export interface UsageAccumulator {
  /** Feed an SDK message; non-assistant messages and duplicates are ignored. */
  add(message: unknown): void
  /**
   * Per-agent usage: `main` from the result's main-loop totals (exact, falls back to summed
   * steps when no result), subagents from summed deduplicated steps (approximate).
   */
  agents(mainTokens?: TokenCounts): AgentUsage[]
}

/** Accumulates assistant-step usage per agent, deduped by message.id + parent_tool_use_id. */
export function createUsageAccumulator(): UsageAccumulator {
  const seen = new Set<string>()
  const subagentByToolUse = new Map<string, string>()
  const groups = new Map<string, AgentUsage>()

  const group = (agent: string): AgentUsage => {
    let g = groups.get(agent)
    if (!g) {
      g = { agent, steps: 0, ...zeroTokens(), approximate: agent !== 'main' }
      groups.set(agent, g)
    }
    return g
  }

  return {
    add(message) {
      if (!isRecord(message) || message['type'] !== 'assistant') return
      const inner = message['message']
      if (!isRecord(inner)) return
      const parent = ident(message['parent_tool_use_id'])

      const content = inner['content']
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block) || block['type'] !== 'tool_use') continue
          const id = ident(block['id'])
          const name = str(block['name'])
          const input = block['input']
          if (id && name && SUBAGENT_TOOLS.has(name) && isRecord(input)) {
            const t = input['subagent_type']
            subagentByToolUse.set(id, typeof t === 'string' && SUBAGENT_TYPE_RE.test(t) ? t : 'subagent')
          }
        }
      }

      const usage = inner['usage']
      const messageId = str(inner['id']) ?? str(message['uuid'])
      if (!isRecord(usage) || messageId === null) return
      const key = `${messageId}|${parent ?? ''}`
      if (seen.has(key)) return
      seen.add(key)

      const agentName = parent === null ? 'main' : (subagentByToolUse.get(parent) ?? 'subagent')
      const g = group(agentName)
      g.steps += 1
      g.inputTokens += num(usage['input_tokens'])
      g.outputTokens += num(usage['output_tokens'])
      g.cacheReadTokens += num(usage['cache_read_input_tokens'])
      g.cacheCreationTokens += num(usage['cache_creation_input_tokens'])
    },
    agents(mainTokens) {
      const result = [...groups.values()].map((g) => ({ ...g }))
      if (mainTokens) {
        const main = result.find((g) => g.agent === 'main')
        if (main) Object.assign(main, mainTokens, { approximate: false })
        else result.unshift({ agent: 'main', steps: 0, ...mainTokens, approximate: false })
      } else {
        const main = result.find((g) => g.agent === 'main')
        if (main) main.approximate = true
      }
      return result
    }
  }
}
