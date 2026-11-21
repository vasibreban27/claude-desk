import {
  agentOverrideSaveRequestSchema,
  agentPreviewRequestSchema,
  houseRulesSaveRequestSchema,
  projectAgentsRequestSchema,
  type AgentLayer,
  type AgentPreviewResult,
  type AgentsSaveResult,
  type ProjectAgentsResult
} from '../../shared/agents'
import { REVIEWER_NAMES, type ReviewerName } from '../../shared/review'
import type { AgentProfileStore } from '../db/agentProfileStore'
import type { RunStore } from '../db/runStore'
import { workerRules } from '../pipeline/prompts'
import { reviewerRules } from '../pipeline/reviewRunner'
import type { ProjectStore } from '../projects/store'
import { resolveFrom, roleOf, type AgentResolver } from '../toolkit/agents'

/** The Toolkit tab: the project's view of the toolkit agents, saving its overrides and house rules, and a preview. */
export interface AgentHandlers {
  agentsView(payload: unknown): Promise<ProjectAgentsResult>
  agentsSave(payload: unknown): Promise<AgentsSaveResult>
  agentsRules(payload: unknown): Promise<AgentsSaveResult>
  agentsPreview(payload: unknown): Promise<AgentPreviewResult>
}

export interface AgentHandlerDeps {
  projects: Pick<ProjectStore, 'get'>
  resolver?: AgentResolver
  /** Absent: the database is unavailable; the view is read-only. */
  store?: Pick<AgentProfileStore, 'setOverride' | 'setHouseRules'>
  runStore?: Pick<RunStore, 'summary'>
  log?: (message: string) => void
}

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown')

/** The last block of a preview: the rules the app adds, which win over everything above. */
export function appLayer(name: string): AgentLayer {
  const role = roleOf(name)
  if (role === 'worker') return { kind: 'app', label: 'App rules (always win)', text: workerRules({ worker: name }) }
  if (role === 'reviewer') return { kind: 'app', label: 'App rules (always win)', text: reviewerRules(name as ReviewerName) }
  return {
    kind: 'app',
    label: 'How it runs',
    text: 'Helpers run as toolkit subagents inside Chat and Plan sessions. Project changes do not reach them yet; only workers and reviewers use them.'
  }
}

export function createAgentHandlers(deps: AgentHandlerDeps): AgentHandlers {
  const log = deps.log ?? ((m: string) => console.error(m))
  const known = async (projectId: string): Promise<boolean> => (await deps.projects.get(projectId)) !== undefined

  const usageFor = (projectId: string): Map<string, { sessions: number; tokens: number }> => {
    const out = new Map<string, { sessions: number; tokens: number }>()
    try {
      const s = deps.runStore?.summary({ projectId, days: 30 })
      for (const a of s?.byAgent ?? []) {
        out.set(a.agent, { sessions: a.steps, tokens: a.inputTokens + a.outputTokens + a.cacheReadTokens + a.cacheCreationTokens })
      }
    } catch {
      // usage is optional
    }
    return out
  }

  return {
    async agentsView(payload) {
      const req = projectAgentsRequestSchema.safeParse(payload)
      if (!req.success) return { ok: false, error: 'not-found' }
      try {
        if (!(await known(req.data.projectId))) return { ok: false, error: 'not-found' }
        if (!deps.resolver) return { ok: false, error: 'no-toolkit' }
        const view = await deps.resolver.view(req.data.projectId, usageFor(req.data.projectId), deps.store !== undefined)
        return view ? { ok: true, view } : { ok: false, error: 'no-toolkit' }
      } catch (e) {
        log(`agents:view failed: ${errName(e)}`)
        return { ok: false, error: 'unreadable' }
      }
    },

    async agentsSave(payload) {
      const req = agentOverrideSaveRequestSchema.safeParse(payload)
      if (!req.success) return { ok: false, error: 'invalid' }
      try {
        if (!(await known(req.data.projectId))) return { ok: false, error: 'not-found' }
        if (!deps.store) return { ok: false, error: 'storage-unavailable' }
        deps.store.setOverride(req.data.projectId, req.data.agent, req.data.override)
        return { ok: true }
      } catch (e) {
        log(`agents:save failed: ${errName(e)}`)
        return { ok: false, error: 'storage-unavailable' }
      }
    },

    async agentsRules(payload) {
      const req = houseRulesSaveRequestSchema.safeParse(payload)
      if (!req.success) return { ok: false, error: 'invalid' }
      try {
        if (!(await known(req.data.projectId))) return { ok: false, error: 'not-found' }
        if (!deps.store) return { ok: false, error: 'storage-unavailable' }
        deps.store.setHouseRules(req.data.projectId, req.data.houseRules)
        return { ok: true }
      } catch (e) {
        log(`agents:rules failed: ${errName(e)}`)
        return { ok: false, error: 'storage-unavailable' }
      }
    },

    async agentsPreview(payload) {
      const req = agentPreviewRequestSchema.safeParse(payload)
      if (!req.success) return { ok: false, error: 'not-found' }
      try {
        if (!(await known(req.data.projectId))) return { ok: false, error: 'not-found' }
        if (!deps.resolver) return { ok: false, error: 'no-toolkit' }
        const listing = await deps.resolver.listing()
        if (listing === null) return { ok: false, error: 'no-toolkit' }
        const name = req.data.agent
        if (!listing.agents.some((a) => a.name === name) && !(REVIEWER_NAMES as readonly string[]).includes(name)) {
          return { ok: false, error: 'not-found' }
        }
        const r = resolveFrom(listing, deps.resolver.profile(req.data.projectId), name)
        const layers = roleOf(name) === 'helper' ? [...r.layers.filter((l) => l.kind === 'toolkit'), appLayer(name)] : [...r.layers, appLayer(name)]
        return { ok: true, layers, model: r.model, modelSource: r.modelSource }
      } catch (e) {
        log(`agents:preview failed: ${errName(e)}`)
        return { ok: false, error: 'unreadable' }
      }
    }
  }
}
