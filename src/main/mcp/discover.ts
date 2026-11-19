import { query, type McpServerConfig, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { MCP_MAX_TOOLS, MCP_TOOL_NAME_PATTERN, type McpStatus, type McpToolInfo } from '../../shared/mcp'

/**
 * Lists a server's tools without sending anything to the model: a session is started with only this server and an
 * input stream that never sends a message, `Query.mcpServerStatus()` is polled until the server leaves `pending`,
 * and the session is closed. Documented in the SDK reference (McpServerStatus).
 */

export const DISCOVER_TIMEOUT_MS = 30_000
const POLL_MS = 400

export interface StatusQuery extends AsyncIterable<unknown> {
  close(): void
  mcpServerStatus(): Promise<unknown[]>
}
export type DiscoverQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => StatusQuery

const statusSchema = z.object({
  name: z.string(),
  status: z.enum(['connected', 'failed', 'needs-auth', 'pending', 'disabled']),
  error: z.string().nullish(),
  tools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().nullish(),
        // The SDK reports the MCP `readOnlyHint` as `readOnly` (seen live); both are accepted.
        annotations: z.object({ readOnly: z.boolean().nullish(), readOnlyHint: z.boolean().nullish() }).passthrough().nullish()
      })
    )
    .nullish()
})

export interface DiscoverResult {
  status: McpStatus
  tools: McpToolInfo[]
  error: string | null
}

export interface DiscoverDeps {
  cwd: string
  queryFn?: DiscoverQueryFn
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** Tools as the server names them (any `mcp__<server>__` prefix removed), valid names only, capped. */
export function toToolInfos(server: string, tools: z.infer<typeof statusSchema>['tools']): McpToolInfo[] {
  const prefix = `mcp__${server}__`
  const out: McpToolInfo[] = []
  for (const t of tools ?? []) {
    const name = t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name
    if (!MCP_TOOL_NAME_PATTERN.test(name) || out.some((o) => o.name === name)) continue
    const ro = t.annotations?.readOnly ?? t.annotations?.readOnlyHint
    out.push({
      name,
      description: t.description ? t.description.slice(0, 1000) : null,
      readOnly: typeof ro === 'boolean' ? ro : null
    })
    if (out.length >= MCP_MAX_TOOLS) break
  }
  return out
}

export async function discoverTools(server: string, config: McpServerConfig, deps: DiscoverDeps): Promise<DiscoverResult> {
  const queryFn: DiscoverQueryFn = deps.queryFn ?? ((p) => query(p))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const timeout = deps.timeoutMs ?? DISCOVER_TIMEOUT_MS
  const stop = new AbortController()
  // An input stream that never sends a message and ends when the check is over.
  const noInput: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<SDKUserMessage>>((resolve) =>
          stop.signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true })
        )
    })
  }
  const abortController = new AbortController()
  let q: StatusQuery | null = null
  try {
    q = queryFn({
      prompt: noInput,
      options: {
        cwd: deps.cwd,
        settingSources: [],
        tools: [],
        allowedTools: [],
        mcpServers: { [server]: config },
        abortController
      }
    })
    // Keep the message stream drained so control responses are processed.
    const drain = (async () => {
      for await (const message of q) void message
    })().catch(() => undefined)
    void drain
    const deadline = Date.now() + timeout
    let last: z.infer<typeof statusSchema> | null = null
    while (Date.now() < deadline) {
      const all = await q.mcpServerStatus()
      const found = all.map((s) => statusSchema.safeParse(s)).find((s) => s.success && s.data.name === server)
      last = found?.success ? found.data : null
      if (last !== null && last.status !== 'pending') break
      await sleep(POLL_MS)
    }
    if (last === null) return { status: 'failed', tools: [], error: 'the server did not report a status' }
    if (last.status === 'pending') return { status: 'pending', tools: [], error: 'the server did not connect in time' }
    return {
      status: last.status,
      tools: last.status === 'connected' ? toToolInfos(server, last.tools) : [],
      error: last.status === 'connected' ? null : (last.error ?? (last.status === 'needs-auth' ? 'the server needs a sign-in or token' : null))?.slice(0, 300) ?? null
    }
  } catch (e) {
    return { status: 'failed', tools: [], error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }
  } finally {
    stop.abort()
    try {
      q?.close()
    } catch {
      // already closed
    }
    abortController.abort()
  }
}
