import { z } from 'zod'

/**
 * MCP connections the user adds in Settings (Linear, a local tool server, ...). They are app-wide and are given
 * to Chat and Plan sessions only, never to pipeline workers or reviewers. Only the tools the user ticked are allowed.
 * Secret values (env vars, headers such as `Authorization`) stay in the main process, encrypted with the OS keychain;
 * the renderer only ever sees their names.
 */

/** Server names the app uses itself; a connection may not take them. */
export const RESERVED_MCP_NAMES: readonly string[] = ['git', 'desk', 'work', 'review', 'assistant', 'claude_ai', 'plugin']
/** Lowercase letter first, then lowercase letters, digits and underscores; becomes `mcp__<name>__<tool>`. */
export const MCP_NAME_PATTERN = /^[a-z][a-z0-9_]{1,29}$/
export const MCP_TRANSPORTS = ['stdio', 'http', 'sse'] as const
export type McpTransport = (typeof MCP_TRANSPORTS)[number]
export const MCP_MAX_CONNECTIONS = 20
export const MCP_MAX_TOOLS = 200
export const MCP_MAX_ARGS = 32
export const MCP_MAX_SECRETS = 16
/** Env var / header name. */
export const MCP_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
export const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/

export const mcpNameSchema = z
  .string()
  .regex(MCP_NAME_PATTERN)
  .refine((n) => !RESERVED_MCP_NAMES.includes(n), 'reserved name')

const httpsUrl = z
  .string()
  .max(2000)
  .refine((u) => {
    try {
      const url = new URL(u)
      // Plain http only for a server on this machine.
      return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    } catch {
      return false
    }
  }, 'an https URL (http only for localhost)')

/** A tool the server offers, as discovered by Test connection. */
export const mcpToolInfoSchema = z.object({
  name: z.string().regex(MCP_TOOL_NAME_PATTERN),
  description: z.string().max(1000).nullable(),
  /** From the tool's `readOnlyHint` annotation; null when the server does not say. */
  readOnly: z.boolean().nullable()
})
export type McpToolInfo = z.infer<typeof mcpToolInfoSchema>

/** What is stored (no secret values). */
export const mcpConnectionSchema = z
  .object({
    id: z.uuid(),
    name: mcpNameSchema,
    transport: z.enum(MCP_TRANSPORTS),
    /** stdio only. */
    command: z.string().min(1).max(500).nullable(),
    args: z.array(z.string().max(1000)).max(MCP_MAX_ARGS),
    /** http / sse only. */
    url: httpsUrl.nullable(),
    /** Names of env vars (stdio) or headers (http/sse) whose values are kept encrypted. */
    secretKeys: z.array(z.string().regex(MCP_KEY_PATTERN)).max(MCP_MAX_SECRETS),
    enabled: z.boolean(),
    /** Tools from the last successful test. */
    knownTools: z.array(mcpToolInfoSchema).max(MCP_MAX_TOOLS),
    /** Tool names (without the `mcp__name__` prefix) agents may use. */
    allowedTools: z.array(z.string().regex(MCP_TOOL_NAME_PATTERN)).max(MCP_MAX_TOOLS)
  })
  .superRefine((c, ctx) => {
    if (c.transport === 'stdio' && c.command === null) ctx.addIssue({ code: 'custom', message: 'a command is required', path: ['command'] })
    if (c.transport !== 'stdio' && c.url === null) ctx.addIssue({ code: 'custom', message: 'a URL is required', path: ['url'] })
  })
export type McpConnection = z.infer<typeof mcpConnectionSchema>

/** Create or update. `secrets`: a string sets the value, null removes it; keys not listed keep their value. */
export const mcpSaveRequestSchema = z.object({
  id: z.uuid().nullable(),
  name: mcpNameSchema,
  transport: z.enum(MCP_TRANSPORTS),
  command: z.string().min(1).max(500).nullable(),
  args: z.array(z.string().max(1000)).max(MCP_MAX_ARGS),
  url: httpsUrl.nullable(),
  enabled: z.boolean(),
  allowedTools: z.array(z.string().regex(MCP_TOOL_NAME_PATTERN)).max(MCP_MAX_TOOLS),
  secrets: z.record(z.string().regex(MCP_KEY_PATTERN), z.string().max(4000).nullable())
})
export type McpSaveRequest = z.infer<typeof mcpSaveRequestSchema>

export const mcpIdRequestSchema = z.object({ id: z.uuid() })
export type McpIdRequest = z.infer<typeof mcpIdRequestSchema>

export type McpStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'

export type McpListResult = { ok: true; connections: McpConnection[]; secretsAvailable: boolean } | { ok: false; error: 'unreadable' }
export type McpSaveError = 'invalid' | 'duplicate-name' | 'not-found' | 'secrets-unavailable' | 'too-many' | 'storage-error'
export type McpSaveResult = { ok: true; connection: McpConnection } | { ok: false; error: McpSaveError; message?: string }
export type McpDeleteResult = { ok: true } | { ok: false; error: 'not-found' | 'storage-error' }
export type McpTestResult =
  | { ok: true; status: McpStatus; tools: McpToolInfo[]; error: string | null; connection: McpConnection }
  | { ok: false; error: 'not-found' | 'test-failed'; message?: string }
