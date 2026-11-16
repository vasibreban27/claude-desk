import { query, type HookCallback, type Options } from '@anthropic-ai/claude-agent-sdk'
import {
  createUsageAccumulator,
  mapDeniedToolUse,
  mapHookInput,
  parseResultMessage,
  type ActivityDraft,
  type AgentUsage,
  type RunUsage
} from './activity'
import { ALLOWED_TOOLS, guardPreToolUse, isDenied } from './tools'

/** What the chat service needs from the SDK; the renderer never sees raw SDK objects. */
export type RunnerItem =
  | { kind: 'text'; text: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'activity'; draft: ActivityDraft }
  | { kind: 'usage'; usage: RunUsage; agents: AgentUsage[] }

export interface RunnerArgs {
  prompt: string
  cwd: string
  pluginPath: string
  resume?: string | undefined
  signal?: AbortSignal
}

export type ChatRunner = (args: RunnerArgs) => AsyncIterable<RunnerItem>

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Extracts a text delta from an SDK message, validating its shape at the boundary. */
export function extractTextDelta(message: unknown): string | null {
  if (!isRecord(message) || message['type'] !== 'stream_event') return null
  const event = message['event']
  if (!isRecord(event) || event['type'] !== 'content_block_delta') return null
  const delta = event['delta']
  if (!isRecord(delta) || delta['type'] !== 'text_delta') return null
  const text = delta['text']
  return typeof text === 'string' ? text : null
}

export function extractSessionId(message: unknown): string | null {
  if (!isRecord(message)) return null
  const id = message['session_id']
  return typeof id === 'string' && id.length > 0 ? id : null
}

type Hooks = NonNullable<Options['hooks']>

/**
 * Hooks for one run. The single PreToolUse matcher is the guard (`onFailure: "block"`, fails closed):
 * it first reports `tool-started` (try/catch, never throws), then decides, and reports a denied
 * `tool-finished` itself because a denied tool never reaches PostToolUse. Doing both in one callback
 * keeps start before finish. Tracking-only hooks use `onFailure: "continue"`.
 */
export function buildHooks(emit: (draft: ActivityDraft) => void, cwd: string): Hooks {
  const safeEmit = (draft: ActivityDraft | null): void => {
    if (!draft) return
    try {
      emit(draft)
    } catch {
      // Tracking must never break the run.
    }
  }

  const guard: HookCallback = async (input) => {
    safeEmit(mapHookInput(input))
    const output = guardPreToolUse(input, cwd)
    if (isDenied(output)) safeEmit(mapDeniedToolUse(input))
    return output
  }

  const track: HookCallback = async (input) => {
    safeEmit(mapHookInput(input))
    return {}
  }

  return {
    PreToolUse: [{ hooks: [guard], onFailure: 'block' }],
    PostToolUse: [{ hooks: [track], onFailure: 'continue' }],
    PostToolUseFailure: [{ hooks: [track], onFailure: 'continue' }],
    SubagentStop: [{ hooks: [track], onFailure: 'continue' }]
  }
}

/**
 * Minimal push queue: hook callbacks and the message pump feed one async iterable.
 * The queue is unbounded by design: items are small and one run is short-lived; the consumer
 * (the chat service) drains it as fast as the SDK produces.
 */
function createQueue<T>() {
  const items: T[] = []
  let closed = false
  let failure: { error: unknown } | null = null
  let wake: (() => void) | null = null
  const notify = (): void => {
    const w = wake
    wake = null
    w?.()
  }
  return {
    push(item: T): void {
      if (closed) return
      items.push(item)
      notify()
    },
    close(error?: { error: unknown }): void {
      if (closed) return
      closed = true
      failure = error ?? null
      notify()
    },
    async *iterate(): AsyncGenerator<T> {
      for (;;) {
        const next = items.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (closed) {
          if (failure) throw failure.error
          return
        }
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    }
  }
}

/** Real runner: Agent SDK `query()` using the existing Claude Code login. */
export const sdkRunner: ChatRunner = async function* (args) {
  const abortController = new AbortController()
  if (args.signal?.aborted) abortController.abort()
  else args.signal?.addEventListener('abort', () => abortController.abort(), { once: true })
  const queue = createQueue<RunnerItem>()
  const stream = query({
    prompt: args.prompt,
    options: {
      cwd: args.cwd,
      // Plugins load independently of settingSources; no user/project/local settings are needed.
      settingSources: [],
      plugins: [{ type: 'local', path: args.pluginPath }],
      includePartialMessages: true,
      allowedTools: [...ALLOWED_TOOLS],
      hooks: buildHooks((draft) => queue.push({ kind: 'activity', draft }), args.cwd),
      abortController,
      ...(args.resume ? { resume: args.resume } : {})
    }
  })

  const accumulator = createUsageAccumulator()
  const pump = (async (): Promise<void> => {
    try {
      let sessionSent = false
      for await (const message of stream) {
        if (!sessionSent) {
          const sessionId = extractSessionId(message)
          if (sessionId) {
            sessionSent = true
            queue.push({ kind: 'session', sessionId })
          }
        }
        const text = extractTextDelta(message)
        if (text !== null) queue.push({ kind: 'text', text })
        accumulator.add(message)
        const usage = parseResultMessage(message)
        if (usage) {
          queue.push({ kind: 'usage', usage, agents: accumulator.agents(usage.mainTokens) })
          if (usage.isError) throw new Error('sdk-result-error')
        }
      }
      queue.close()
    } catch (error) {
      queue.close({ error })
    }
  })()

  try {
    yield* queue.iterate()
  } finally {
    abortController.abort()
    void pump
  }
}
