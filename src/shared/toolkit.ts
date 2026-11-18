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
