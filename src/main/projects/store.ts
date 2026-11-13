import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { projectSchema, type Project } from '../../shared/ipc'

export interface NewProject {
  path: string
  branch: string | null
  dirty: boolean
}

export type AddProjectResult = { ok: true; project: Project } | { ok: false; error: 'duplicate' }

/** Persistence boundary. Phase 2/3 replace the JSON implementation with SQLite. */
export interface ProjectStore {
  list(): Promise<Project[]>
  get(id: string): Promise<Project | undefined>
  add(input: NewProject): Promise<AddProjectResult>
  /** Updates branch/dirty of an existing project. */
  update(id: string, status: { branch: string | null; dirty: boolean }): Promise<Project | undefined>
}

/** Normalised comparison key: absolute, and case-insensitive on win32. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const abs = resolve(p)
  return platform === 'win32' ? abs.toLowerCase() : abs
}

const fileSchema = z.array(projectSchema)

export const STORE_FILE = 'projects.json'

export async function openJsonProjectStore(dir: string): Promise<ProjectStore> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, STORE_FILE)
  let projects: Project[] = []

  let raw: string | undefined
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (raw !== undefined) {
    let parsed: Project[] | undefined
    try {
      const result = fileSchema.safeParse(JSON.parse(raw))
      if (result.success) parsed = result.data
    } catch {
      // invalid JSON: handled below
    }
    if (parsed) projects = parsed
    else await rename(file, `${file}.bak`)
  }

  // Serialise writes so concurrent calls cannot interleave.
  let queue: Promise<unknown> = Promise.resolve()
  const persist = (): Promise<void> => {
    const snapshot = JSON.stringify(projects, null, 2)
    const next = queue.then(async () => {
      const tmp = `${file}.tmp`
      await writeFile(tmp, snapshot, 'utf8')
      await rename(tmp, file)
    })
    queue = next.catch(() => undefined)
    return next
  }

  return {
    async list() {
      return projects.map((p) => ({ ...p }))
    },
    async get(id) {
      const p = projects.find((x) => x.id === id)
      return p ? { ...p } : undefined
    },
    async add(input) {
      const abs = resolve(input.path)
      const key = pathKey(abs)
      if (projects.some((p) => pathKey(p.path) === key)) return { ok: false, error: 'duplicate' }
      const project: Project = {
        id: randomUUID(),
        path: abs,
        name: basename(abs) || abs,
        branch: input.branch,
        dirty: input.dirty,
        addedAt: new Date().toISOString()
      }
      projects = [...projects, project]
      await persist()
      return { ok: true, project: { ...project } }
    },
    async update(id, status) {
      const current = projects.find((p) => p.id === id)
      if (!current) return undefined
      const updated: Project = { ...current, branch: status.branch, dirty: status.dirty }
      projects = projects.map((p) => (p.id === id ? updated : p))
      await persist()
      return { ...updated }
    }
  }
}
