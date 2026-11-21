import { createHash } from 'node:crypto'
import {
  agentModel,
  toolkitModelOf,
  type AgentLayer,
  type AgentModel,
  type AgentOverride,
  type AgentRole,
  type AgentView,
  type ModelSource,
  type ProjectAgentsView
} from '../../shared/agents'
import { REVIEWER_NAMES } from '../../shared/review'
import type { ToolkitAgent, ToolkitListing } from '../../shared/toolkit'
import type { AgentProfileStore, ProjectAgentProfile } from '../db/agentProfileStore'
import { PLAN_WORKERS } from '../pipeline/planParser'
import { scanToolkit } from './scan'

/**
 * Resolves what an agent session receives in a project: the toolkit agent's own instructions, the project's house
 * rules and the project's instructions for that agent (the app's rules are added last by each runner). Workers and
 * reviewers are run by the app, so this is where the toolkit agent finally reaches them.
 */

/** Toolkit instructions kept per agent in a prompt. */
export const TOOLKIT_BODY_MAX = 20_000

export function roleOf(name: string): AgentRole {
  if (PLAN_WORKERS.includes(name)) return 'worker'
  if ((REVIEWER_NAMES as readonly string[]).includes(name)) return 'reviewer'
  return 'helper'
}

export interface ResolvedAgent {
  name: string
  /** The agent-level model; the plan's per-task Model still wins, and null falls back to the project model. */
  model: AgentModel | null
  modelSource: ModelSource
  /** Toolkit, house rules and agent layers that are not empty, in order. */
  layers: AgentLayer[]
  /** The layers as one system-prompt block ('' when there is nothing). */
  text: string
  /** Short hash of `text` and `model`, shown in Activity so a run can be matched to its instructions. */
  fingerprint: string
  /** True when the project changed this agent or set house rules. */
  customized: boolean
}

export function composeLayers(layers: readonly AgentLayer[]): string {
  return layers.map((l) => `## ${l.label}\n${l.text.trim()}`).join('\n\n')
}

/** The layers a session gets for one agent (without the app's own rules). */
export function agentLayers(agent: ToolkitAgent | undefined, profile: ProjectAgentProfile, name: string): AgentLayer[] {
  const layers: AgentLayer[] = []
  const body = agent?.body.trim() ?? ''
  if (body !== '') {
    const text = body.length > TOOLKIT_BODY_MAX ? `${body.slice(0, TOOLKIT_BODY_MAX)}\n…(cut)` : body
    layers.push({ kind: 'toolkit', label: `Agent instructions (claude-toolkit ${agent?.source ?? name})`, text })
  }
  if (profile.houseRules.trim() !== '') {
    layers.push({ kind: 'house-rules', label: 'Project house rules (follow them in this project)', text: profile.houseRules })
  }
  const extra = profile.overrides[name]?.instructions.trim() ?? ''
  if (extra !== '') layers.push({ kind: 'agent', label: `Project instructions for ${name}`, text: extra })
  return layers
}

export function resolveFrom(listing: ToolkitListing | null, profile: ProjectAgentProfile, name: string): ResolvedAgent {
  const agent = listing?.agents.find((a) => a.name === name)
  const override: AgentOverride | null = profile.overrides[name] ?? null
  const { model, source } = agentModel(override, toolkitModelOf(agent?.model ?? null))
  const layers = agentLayers(agent, profile, name)
  const text = composeLayers(layers)
  const fingerprint = createHash('sha256').update(`${model ?? ''}\n${text}`).digest('hex').slice(0, 8)
  return {
    name,
    model,
    modelSource: source,
    layers,
    text,
    fingerprint,
    customized: override !== null || profile.houseRules.trim() !== ''
  }
}

/** Plan-mode note: the project's house rules (they shape the files a plan creates) and workers turned off. */
export function planNote(profile: ProjectAgentProfile): string | null {
  const parts: string[] = []
  const off = Object.entries(profile.overrides)
    .filter(([name, o]) => !o.usedInPlans && roleOf(name) === 'worker')
    .map(([name]) => name)
    .sort()
  if (off.length > 0) {
    parts.push(`Workers turned off for this project (never assign them): ${off.join(', ')}.`)
  }
  if (profile.houseRules.trim() !== '') {
    parts.push(
      'Project house rules. Follow them when you choose files, packages and structure for the tasks (Owns), and when you write the plan:',
      profile.houseRules.trim()
    )
  }
  return parts.length > 0 ? `## This project\n${parts.join('\n')}` : null
}

/** Workers a project turned off. */
export function disabledWorkers(profile: ProjectAgentProfile): string[] {
  return Object.entries(profile.overrides)
    .filter(([name, o]) => !o.usedInPlans && roleOf(name) === 'worker')
    .map(([name]) => name)
}

export interface AgentResolverDeps {
  /** The toolkit folder; null when it is not set up. */
  toolkitPath: () => string | null
  /** Absent: no project layer (database unavailable). */
  store?: Pick<AgentProfileStore, 'get'>
  scan?: (folder: string) => Promise<ToolkitListing>
  /** How long a toolkit scan is reused. */
  cacheMs?: number
  now?: () => number
}

export interface AgentResolver {
  resolve(projectId: string, name: string): Promise<ResolvedAgent>
  profile(projectId: string): ProjectAgentProfile
  /** The toolkit listing (cached), or null when there is no toolkit or it cannot be read. */
  listing(): Promise<ToolkitListing | null>
  view(projectId: string, usage: Map<string, { sessions: number; tokens: number }>, editable: boolean): Promise<ProjectAgentsView | null>
}

const EMPTY_PROFILE: ProjectAgentProfile = { houseRules: '', overrides: {} }

export function createAgentResolver(deps: AgentResolverDeps): AgentResolver {
  const scan = deps.scan ?? scanToolkit
  const now = deps.now ?? Date.now
  const cacheMs = deps.cacheMs ?? 30_000
  let cache: { path: string; at: number; listing: ToolkitListing } | null = null

  const listing = async (): Promise<ToolkitListing | null> => {
    const p = deps.toolkitPath()
    if (p === null) return null
    if (cache && cache.path === p && now() - cache.at < cacheMs) return cache.listing
    try {
      const l = await scan(p)
      cache = { path: p, at: now(), listing: l }
      return l
    } catch {
      return null
    }
  }

  const profile = (projectId: string): ProjectAgentProfile => {
    try {
      return deps.store?.get(projectId) ?? EMPTY_PROFILE
    } catch {
      return EMPTY_PROFILE
    }
  }

  return {
    profile,
    listing,
    async resolve(projectId, name) {
      return resolveFrom(await listing(), profile(projectId), name)
    },
    async view(projectId, usage, editable) {
      const l = await listing()
      if (l === null) return null
      const p = profile(projectId)
      const agents: AgentView[] = l.agents.map((a) => {
        const override = p.overrides[a.name] ?? null
        const toolkitModel = toolkitModelOf(a.model)
        const m = agentModel(override, toolkitModel)
        return {
          name: a.name,
          role: roleOf(a.name),
          description: a.description,
          toolkitModel,
          tools: a.tools,
          source: a.source,
          body: a.body,
          override,
          effectiveModel: m.model,
          modelSource: m.source,
          usage: usage.get(a.name) ?? null
        }
      })
      return {
        toolkit: l.plugin ? { name: l.plugin.name, version: l.plugin.version } : null,
        problems: l.problems,
        houseRules: p.houseRules,
        agents,
        skills: l.skills.map((s) => ({ name: s.name, description: s.description, source: s.source, body: s.body })),
        hooks: l.hooks,
        editable
      }
    }
  }
}
