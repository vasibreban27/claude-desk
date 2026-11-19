import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { MODEL_CHOICES, type ModelChoice } from '../../shared/settings'

const fileSchema = z.object({
  projectsRoot: z.string().max(1000).nullable().optional(),
  defaultModel: z.enum(MODEL_CHOICES).optional()
})
export const APP_SETTINGS_FILE = 'app-settings.json'

export interface AppSettings {
  getProjectsRoot(): Promise<string | null>
  setProjectsRoot(root: string): Promise<void>
  getDefaultModel(): Promise<ModelChoice>
  setDefaultModel(model: ModelChoice): Promise<void>
}

/** App-level settings kept in a small validated JSON file. A missing or corrupt file means "unset". */
export function openAppSettings(dir: string): AppSettings {
  const file = path.join(dir, APP_SETTINGS_FILE)
  const read = async (): Promise<{ projectsRoot: string | null; defaultModel: ModelChoice }> => {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(file, 'utf8')))
      if (parsed.success) return { projectsRoot: parsed.data.projectsRoot ?? null, defaultModel: parsed.data.defaultModel ?? 'auto' }
    } catch {
      // A missing or corrupt file uses defaults.
    }
    return { projectsRoot: null, defaultModel: 'auto' }
  }
  let writes: Promise<void> = Promise.resolve()
  const update = (patch: Partial<{ projectsRoot: string | null; defaultModel: ModelChoice }>): Promise<void> => {
    const next = writes.then(async () => {
      await mkdir(dir, { recursive: true })
      const value = { ...await read(), ...patch }
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify(value), 'utf8')
      await rename(tmp, file)
    })
    writes = next.catch(() => undefined)
    return next
  }
  return {
    async getProjectsRoot() {
      return (await read()).projectsRoot
    },
    async setProjectsRoot(root) {
      await update({ projectsRoot: path.resolve(root) })
    },
    async getDefaultModel() {
      return (await read()).defaultModel
    },
    async setDefaultModel(model) {
      await update({ defaultModel: model })
    }
  }
}
