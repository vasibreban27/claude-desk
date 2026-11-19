import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  MCP_MAX_CONNECTIONS,
  MCP_KEY_PATTERN,
  mcpConnectionSchema,
  type McpConnection,
  type McpDeleteResult,
  type McpSaveRequest,
  type McpSaveResult,
  type McpToolInfo
} from '../../shared/mcp'

export const MCP_CONNECTIONS_FILE = 'mcp-connections.json'
export const MCP_SECRETS_FILE = 'mcp-secrets.json'

/** Encrypts secret values with the OS keychain (Electron safeStorage). Injected so tests need no Electron. */
export interface SecretBox {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export interface McpStore {
  list(): Promise<McpConnection[]>
  get(id: string): Promise<McpConnection | undefined>
  save(req: McpSaveRequest): Promise<McpSaveResult>
  remove(id: string): Promise<McpDeleteResult>
  /** Stores the tools of a successful test; allowed tools the server no longer offers are dropped. */
  setKnownTools(id: string, tools: McpToolInfo[]): Promise<McpConnection | undefined>
  /** Decrypted secret values of one connection (main process only). Undecryptable values are left out. */
  secretsFor(id: string): Promise<Record<string, string>>
  secretsAvailable(): boolean
}

const connectionsFileSchema = z.array(z.unknown()).max(MCP_MAX_CONNECTIONS * 2)
const secretsFileSchema = z.record(z.uuid(), z.record(z.string().regex(MCP_KEY_PATTERN), z.string().max(20000)))
type SecretsFile = z.infer<typeof secretsFileSchema>

/** `dir` may be a getter, resolved on first use (the app's data folder is only known once Electron is ready). */
export function createMcpStore(dir: string | (() => string), box: SecretBox, newId: () => string = randomUUID): McpStore {
  const folder = (): string => (typeof dir === 'string' ? dir : dir())
  const files = (): { dir: string; connections: string; secrets: string } => {
    const d = folder()
    return { dir: d, connections: path.join(d, MCP_CONNECTIONS_FILE), secrets: path.join(d, MCP_SECRETS_FILE) }
  }
  // Every read-modify-write runs one after another.
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }

  async function readJson(file: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as unknown
    } catch {
      return undefined
    }
  }

  async function writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(files().dir, { recursive: true })
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmp, file)
  }

  /** A missing or corrupt file means no connections; invalid entries are skipped. */
  async function readConnections(): Promise<McpConnection[]> {
    const raw = connectionsFileSchema.safeParse(await readJson(files().connections))
    if (!raw.success) return []
    const out: McpConnection[] = []
    for (const item of raw.data) {
      const c = mcpConnectionSchema.safeParse(item)
      if (c.success && !out.some((o) => o.id === c.data.id || o.name === c.data.name)) out.push(c.data)
    }
    return out
  }

  async function readSecrets(): Promise<SecretsFile> {
    const raw = secretsFileSchema.safeParse(await readJson(files().secrets))
    return raw.success ? raw.data : {}
  }

  return {
    list: () => serial(readConnections),

    get: (id) => serial(async () => (await readConnections()).find((c) => c.id === id)),

    secretsAvailable: () => box.available(),

    save: (req) =>
      serial(async (): Promise<McpSaveResult> => {
        const all = await readConnections()
        const existing = req.id === null ? undefined : all.find((c) => c.id === req.id)
        if (req.id !== null && existing === undefined) return { ok: false, error: 'not-found' }
        if (existing === undefined && all.length >= MCP_MAX_CONNECTIONS) return { ok: false, error: 'too-many' }
        if (all.some((c) => c.name === req.name && c.id !== req.id)) return { ok: false, error: 'duplicate-name' }

        const secrets = await readSecrets()
        const id = existing?.id ?? newId()
        const mine: Record<string, string> = { ...(secrets[id] ?? {}) }
        for (const [key, value] of Object.entries(req.secrets)) {
          if (value === null || value === '') {
            delete mine[key]
            continue
          }
          if (!box.available()) return { ok: false, error: 'secrets-unavailable' }
          mine[key] = box.encrypt(value).toString('base64')
        }

        const knownTools = existing?.knownTools ?? []
        const known = new Set(knownTools.map((t) => t.name))
        const parsed = mcpConnectionSchema.safeParse({
          id,
          name: req.name,
          transport: req.transport,
          command: req.transport === 'stdio' ? req.command : null,
          args: req.transport === 'stdio' ? req.args : [],
          url: req.transport === 'stdio' ? null : req.url,
          secretKeys: Object.keys(mine).sort(),
          enabled: req.enabled,
          knownTools,
          // Only tools seen in a test can be allowed.
          allowedTools: [...new Set(req.allowedTools)].filter((t) => known.has(t))
        })
        if (!parsed.success) return { ok: false, error: 'invalid', message: parsed.error.issues[0]?.message ?? 'invalid connection' }

        try {
          const nextSecrets = { ...secrets }
          if (Object.keys(mine).length > 0) nextSecrets[id] = mine
          else delete nextSecrets[id]
          await writeJson(files().secrets, nextSecrets)
          await writeJson(files().connections, existing ? all.map((c) => (c.id === id ? parsed.data : c)) : [...all, parsed.data])
        } catch {
          return { ok: false, error: 'storage-error' }
        }
        return { ok: true, connection: parsed.data }
      }),

    remove: (id) =>
      serial(async (): Promise<McpDeleteResult> => {
        const all = await readConnections()
        if (!all.some((c) => c.id === id)) return { ok: false, error: 'not-found' }
        try {
          const secrets = await readSecrets()
          delete secrets[id]
          await writeJson(files().secrets, secrets)
          await writeJson(files().connections, all.filter((c) => c.id !== id))
        } catch {
          return { ok: false, error: 'storage-error' }
        }
        return { ok: true }
      }),

    setKnownTools: (id, tools) =>
      serial(async () => {
        const all = await readConnections()
        const c = all.find((x) => x.id === id)
        if (c === undefined) return undefined
        const names = new Set(tools.map((t) => t.name))
        const parsed = mcpConnectionSchema.safeParse({ ...c, knownTools: tools, allowedTools: c.allowedTools.filter((t) => names.has(t)) })
        if (!parsed.success) return undefined
        await writeJson(files().connections, all.map((x) => (x.id === id ? parsed.data : x)))
        return parsed.data
      }),

    secretsFor: (id) =>
      serial(async () => {
        const out: Record<string, string> = {}
        if (!box.available()) return out
        for (const [key, value] of Object.entries((await readSecrets())[id] ?? {})) {
          try {
            out[key] = box.decrypt(Buffer.from(value, 'base64'))
          } catch {
            // a value encrypted by another user or machine cannot be used; the user enters it again
          }
        }
        return out
      })
  }
}
