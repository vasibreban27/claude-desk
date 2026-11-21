import { z } from 'zod'

/**
 * Per-project agents: the toolkit's agents (read-only), plus what a project adds to them. The app resolves both into
 * what each worker and reviewer session receives.
 */

export const AGENT_ROLES = ['worker', 'reviewer', 'helper'] as const
export type AgentRole = (typeof AGENT_ROLES)[number]

export const AGENT_MODELS = ['haiku', 'sonnet', 'opus'] as const
export type AgentModel = (typeof AGENT_MODELS)[number]

export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,99}$/
export const AGENT_INSTRUCTIONS_MAX = 4000
export const HOUSE_RULES_MAX = 8000

/** What a project changes for one agent. `model: null` keeps the toolkit's choice. */
export const agentOverrideSchema = z
  .object({
    model: z.enum(AGENT_MODELS).nullable(),
    instructions: z.string().max(AGENT_INSTRUCTIONS_MAX),
    /** False: the planner is told not to assign this worker, and a plan that does is refused. */
    usedInPlans: z.boolean()
  })
  .strict()
export type AgentOverride = z.infer<typeof agentOverrideSchema>

export const EMPTY_OVERRIDE: AgentOverride = { model: null, instructions: '', usedInPlans: true }

/** An override that changes nothing is stored as no override. */
export function isEmptyOverride(o: AgentOverride): boolean {
  return o.model === null && o.instructions.trim() === '' && o.usedInPlans
}

/** Where the effective model comes from, highest first (the plan's per-task Model is applied at run time). */
export type ModelSource = 'project' | 'toolkit' | 'project-default'

export interface AgentView {
  name: string
  role: AgentRole
  description: string
  /** The model in the toolkit file (haiku, sonnet, opus), or null when it names none or another value. */
  toolkitModel: AgentModel | null
  tools: string[]
  source: string
  /** The toolkit instructions (markdown). */
  body: string
  override: AgentOverride | null
  /** The model a session uses when the plan does not pick one; null = the project or app default. */
  effectiveModel: AgentModel | null
  modelSource: ModelSource
  /** Sessions and tokens in the last 30 days (pipeline workers and reviewers). */
  usage: { sessions: number; tokens: number } | null
}

export interface SkillView {
  name: string
  description: string
  source: string
  body: string
}

export interface HookView {
  event: string
  matcher: string | null
  command: string
  source: string
}

export interface ProjectAgentsView {
  toolkit: { name: string; version: string | null } | null
  problems: { file: string; reason: string }[]
  houseRules: string
  agents: AgentView[]
  skills: SkillView[]
  hooks: HookView[]
  /** False when the database is unavailable: overrides cannot be saved. */
  editable: boolean
}

export type ProjectAgentsResult =
  | { ok: true; view: ProjectAgentsView }
  | { ok: false; error: 'not-found' | 'no-toolkit' | 'unreadable' }

export const projectAgentsRequestSchema = z.object({ projectId: z.uuid() }).strict()
export type ProjectAgentsRequest = z.infer<typeof projectAgentsRequestSchema>

export const agentOverrideSaveRequestSchema = z
  .object({
    projectId: z.uuid(),
    agent: z.string().regex(AGENT_NAME_PATTERN),
    /** null removes the override. */
    override: agentOverrideSchema.nullable()
  })
  .strict()
export type AgentOverrideSaveRequest = z.infer<typeof agentOverrideSaveRequestSchema>

export const houseRulesSaveRequestSchema = z
  .object({ projectId: z.uuid(), houseRules: z.string().max(HOUSE_RULES_MAX) })
  .strict()
export type HouseRulesSaveRequest = z.infer<typeof houseRulesSaveRequestSchema>

export type AgentsSaveResult = { ok: true } | { ok: false; error: 'invalid' | 'not-found' | 'storage-unavailable' }

export const agentPreviewRequestSchema = z.object({ projectId: z.uuid(), agent: z.string().regex(AGENT_NAME_PATTERN) }).strict()
export type AgentPreviewRequest = z.infer<typeof agentPreviewRequestSchema>

export type AgentLayerKind = 'toolkit' | 'house-rules' | 'agent' | 'app'

/** One block of what a session receives, in order. */
export interface AgentLayer {
  kind: AgentLayerKind
  label: string
  text: string
}

export type AgentPreviewResult =
  | { ok: true; layers: AgentLayer[]; model: AgentModel | null; modelSource: ModelSource }
  | { ok: false; error: 'not-found' | 'no-toolkit' | 'unreadable' }

/** The toolkit `model:` line as a model this app can pass; other values (inherit, full ids) mean none. */
export function toolkitModelOf(value: string | null): AgentModel | null {
  const v = (value ?? '').trim().toLowerCase()
  return (AGENT_MODELS as readonly string[]).includes(v) ? (v as AgentModel) : null
}

/** The agent-level model: the project override, else the toolkit file, else none (the project default applies). */
export function agentModel(override: AgentOverride | null, toolkitModel: AgentModel | null): { model: AgentModel | null; source: ModelSource } {
  if (override?.model) return { model: override.model, source: 'project' }
  if (toolkitModel) return { model: toolkitModel, source: 'toolkit' }
  return { model: null, source: 'project-default' }
}
