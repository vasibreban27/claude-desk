import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

const fileSchema = z.object({ projectsRoot: z.string().max(1000).nullable() })
export const APP_SETTINGS_FILE = 'app-settings.json'

export interface AppSettings {
  getProjectsRoot(): Promise<string | null>
  setProjectsRoot(root: string): Promise<void>
}

/** App-level settings kept in a small validated JSON file. A missing or corrupt file means "unset". */
export function openAppSettings(dir: string): AppSettings {
  const file = path.join(dir, APP_SETTINGS_FILE)
  return {
    async getProjectsRoot() {
      try {
        const parsed = fileSchema.safeParse(JSON.parse(await readFile(file, 'utf8')))
        return parsed.success ? parsed.data.projectsRoot : null
      } catch {
        return null
      }
    },
    async setProjectsRoot(root) {
      await mkdir(dir, { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify({ projectsRoot: path.resolve(root) }), 'utf8')
      await rename(tmp, file)
    }
  }
}
