import { query } from '@anthropic-ai/claude-agent-sdk'

/** What the chat service needs from the SDK; the renderer never sees raw SDK objects. */
export type RunnerItem = { kind: 'text'; text: string } | { kind: 'session'; sessionId: string }

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

/** Real runner: Agent SDK `query()` using the existing Claude Code login. */
export const sdkRunner: ChatRunner = async function* (args) {
  const abortController = new AbortController()
  args.signal?.addEventListener('abort', () => abortController.abort(), { once: true })
  const stream = query({
    prompt: args.prompt,
    options: {
      cwd: args.cwd,
      plugins: [{ type: 'local', path: args.pluginPath }],
      includePartialMessages: true,
      allowedTools: [],
      abortController,
      ...(args.resume ? { resume: args.resume } : {})
    }
  })
  let sessionSent = false
  for await (const message of stream) {
    if (!sessionSent) {
      const sessionId = extractSessionId(message)
      if (sessionId) {
        sessionSent = true
        yield { kind: 'session', sessionId }
      }
    }
    const text = extractTextDelta(message)
    if (text !== null) yield { kind: 'text', text }
    if (isRecord(message) && message['type'] === 'result' && message['is_error'] === true) {
      throw new Error('sdk-result-error')
    }
  }
}
