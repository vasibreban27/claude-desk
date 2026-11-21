import { z } from 'zod'

const text = (max: number) => z.string().max(max)

export const toolkitPluginSchema = z.object({
  name: text(100),
  version: text(50).nullable(),
  description: text(1000).nullable()
})
export const toolkitAgentSchema = z.object({
  name: text(100),
  description: text(2000),
  model: text(100).nullable(),
  tools: z.array(text(100)).max(100),
  source: text(500),
  body: text(300_000)
})
export const toolkitSkillSchema = z.object({
  name: text(100),
  description: text(2000),
  source: text(500),
  body: text(300_000)
})
export const toolkitHookSchema = z.object({
  event: text(100),
  matcher: text(500).nullable(),
  command: text(2000),
  source: text(500)
})
export const toolkitProblemSchema = z.object({ file: text(500), reason: text(500) })

export const toolkitListingSchema = z.object({
  plugin: toolkitPluginSchema.nullable(),
  agents: z.array(toolkitAgentSchema).max(500),
  skills: z.array(toolkitSkillSchema).max(500),
  hooks: z.array(toolkitHookSchema).max(500),
  problems: z.array(toolkitProblemSchema).max(500)
})
export type ToolkitListing = z.infer<typeof toolkitListingSchema>
export type ToolkitAgent = z.infer<typeof toolkitAgentSchema>
export type ToolkitSkill = z.infer<typeof toolkitSkillSchema>
export type ToolkitHook = z.infer<typeof toolkitHookSchema>

export type ToolkitListResult = { ok: true; listing: ToolkitListing } | { ok: false; error: 'unset' | 'unreadable' }

/** The toolkit's git state, shown in Settings. */
export interface ToolkitGit {
  /** null on a detached HEAD. */
  branch: string | null
  commit: string
  /** YYYY-MM-DD of the last commit. */
  date: string
  subject: string
  dirty: boolean
}

export interface ToolkitStatus {
  status: 'unset' | 'invalid' | 'valid'
  path: string | null
  version: string | null
  /** Where the path comes from: chosen in Settings, CLAUDE_TOOLKIT_PATH, or nowhere. */
  source: 'settings' | 'environment' | 'unset'
  git: ToolkitGit | null
}

export type ToolkitPickResult =
  | { ok: true; status: ToolkitStatus }
  | { ok: false; error: 'cancelled' | 'not-a-toolkit' | 'unavailable'; message?: string }

export type ToolkitUpdateResult =
  | { ok: true; updated: boolean; from: string; to: string }
  | { ok: false; error: 'not-set' | 'not-a-repo' | 'dirty' | 'failed'; message?: string }
