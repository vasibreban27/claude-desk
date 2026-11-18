import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { toolkitListingSchema, type ToolkitListing } from '../../shared/toolkit'

export const MAX_FILE_BYTES = 256 * 1024
export const MAX_FILES = 200

const manifestSchema = z.object({
  name: z.string().min(1).max(100),
  version: z.string().max(50).optional(),
  description: z.string().max(1000).optional()
})
const agentFm = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(2000),
  model: z.string().max(100).optional(),
  tools: z.string().max(2000).optional()
})
const skillFm = z.object({ name: z.string().min(1).max(100), description: z.string().min(1).max(2000) })
const hookEntry = z.object({
  matcher: z.string().max(500).optional(),
  hooks: z.array(z.object({ type: z.string().max(50).optional(), command: z.string().max(2000).optional() })).max(100)
})
const hooksFile = z.object({ hooks: z.record(z.string().max(100), z.array(hookEntry).max(100)) })

/** Minimal `key: value` frontmatter reader (single-line values only). Returns null when there is none. */
export function parseFrontmatter(src: string): { data: Record<string, string>; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src)
  if (!m) return null
  const data: Record<string, string> = {}
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    let v = (kv[2] ?? '').trim()
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1)
    data[kv[1] as string] = v
  }
  return { data, body: m[2] ?? '' }
}

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Reads a regular file whose real path stays inside `root`, under the size cap. */
async function safeRead(root: string, file: string): Promise<string> {
  const real = await realpath(file)
  if (!inside(root, real)) throw new Error('symlink outside toolkit')
  const st = await lstat(real)
  if (!st.isFile()) throw new Error('not a regular file')
  if (st.size > MAX_FILE_BYTES) throw new Error('file too large')
  return readFile(real, 'utf8')
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort().slice(0, MAX_FILES)
  } catch {
    return []
  }
}

const exists = (f: string): Promise<boolean> => lstat(f).then(() => true, () => false)

/** Read-only scan of a toolkit folder. Never executes anything; bad files are reported in `problems`. */
export async function scanToolkit(folder: string): Promise<ToolkitListing> {
  const root = await realpath(folder)
  const listing: ToolkitListing = { plugin: null, agents: [], skills: [], hooks: [], problems: [] }
  const problem = (file: string, e: unknown): void => {
    const reason = e instanceof z.ZodError ? 'invalid content' : e instanceof Error ? e.message.slice(0, 200) : 'unreadable'
    listing.problems.push({ file, reason })
  }

  const manifest = path.join(root, '.claude-plugin', 'plugin.json')
  if (await exists(manifest)) {
    try {
      const m = manifestSchema.parse(JSON.parse(await safeRead(root, manifest)))
      listing.plugin = { name: m.name, version: m.version ?? null, description: m.description ?? null }
    } catch (e) {
      problem('.claude-plugin/plugin.json', e)
    }
  } else {
    problem('.claude-plugin/plugin.json', new Error('missing'))
  }

  for (const f of (await listDir(path.join(root, 'agents'))).filter((n) => n.endsWith('.md'))) {
    const source = `agents/${f}`
    try {
      const fm = parseFrontmatter(await safeRead(root, path.join(root, 'agents', f)))
      if (!fm) throw new Error('missing frontmatter')
      const d = agentFm.parse(fm.data)
      listing.agents.push({
        name: d.name,
        description: d.description,
        model: d.model ?? null,
        tools: (d.tools ?? '').split(',').map((t) => t.trim()).filter(Boolean),
        source,
        body: fm.body
      })
    } catch (e) {
      problem(source, e)
    }
  }

  for (const d of await listDir(path.join(root, 'skills'))) {
    const file = path.join(root, 'skills', d, 'SKILL.md')
    if (!(await exists(file))) continue
    const source = `skills/${d}/SKILL.md`
    try {
      const fm = parseFrontmatter(await safeRead(root, file))
      if (!fm) throw new Error('missing frontmatter')
      const s = skillFm.parse(fm.data)
      listing.skills.push({ name: s.name, description: s.description, source, body: fm.body })
    } catch (e) {
      problem(source, e)
    }
  }

  const hooksPath = path.join(root, 'hooks', 'hooks.json')
  if (await exists(hooksPath)) {
    try {
      const h = hooksFile.parse(JSON.parse(await safeRead(root, hooksPath)))
      for (const [event, entries] of Object.entries(h.hooks)) {
        for (const entry of entries) {
          for (const hook of entry.hooks) {
            listing.hooks.push({ event, matcher: entry.matcher ?? null, command: hook.command ?? '', source: 'hooks/hooks.json' })
          }
        }
      }
    } catch (e) {
      problem('hooks/hooks.json', e)
    }
  }

  return toolkitListingSchema.parse(listing)
}
