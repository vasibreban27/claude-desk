import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { McpConnection } from '../../shared/mcp'
import type { McpStore } from './store'

/** Variables a local server usually needs to start (PATH to find node/npx/python, Windows system folders). */
const PASS_ENV = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'ComSpec', 'windir', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG']

function baseEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of PASS_ENV) {
    const v = env[key]
    if (typeof v === 'string') out[key] = v
  }
  return out
}

/**
 * The SDK config for one connection. A local (stdio) server gets a small base environment plus its secret env
 * vars, not the app's whole environment; a remote server gets its secrets as HTTP headers (e.g. Authorization).
 */
export function serverConfig(c: McpConnection, secrets: Record<string, string>, env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  if (c.transport === 'stdio') {
    return { type: 'stdio', command: c.command ?? '', args: [...c.args], env: { ...baseEnv(env), ...secrets } }
  }
  return { type: c.transport, url: c.url ?? '', headers: { ...secrets } }
}

/** The full tool name an agent sees. */
export const mcpToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`

export interface ChatMcp {
  servers: Record<string, McpServerConfig>
  /** Full `mcp__server__tool` names the user allowed. */
  allowedTools: string[]
}

/** Enabled connections with at least one allowed tool, for a Chat or Plan session. Never throws. */
export async function loadChatMcp(store: Pick<McpStore, 'list' | 'secretsFor'>): Promise<ChatMcp> {
  const servers: Record<string, McpServerConfig> = {}
  const allowedTools: string[] = []
  try {
    for (const c of await store.list()) {
      if (!c.enabled || c.allowedTools.length === 0) continue
      servers[c.name] = serverConfig(c, await store.secretsFor(c.id))
      for (const t of c.allowedTools) allowedTools.push(mcpToolName(c.name, t))
    }
  } catch {
    return { servers: {}, allowedTools: [] }
  }
  return { servers, allowedTools }
}
