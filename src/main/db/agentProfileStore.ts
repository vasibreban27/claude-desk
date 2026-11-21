import type Database from 'better-sqlite3'
import {
  AGENT_INSTRUCTIONS_MAX,
  AGENT_MODELS,
  HOUSE_RULES_MAX,
  isEmptyOverride,
  type AgentModel,
  type AgentOverride
} from '../../shared/agents'

/** What each project adds to the toolkit's agents: house rules for all of them, and per-agent overrides. */
export interface ProjectAgentProfile {
  houseRules: string
  overrides: Record<string, AgentOverride>
}

export interface AgentProfileStore {
  get(projectId: string): ProjectAgentProfile
  /** null, or an override that changes nothing, removes the row. */
  setOverride(projectId: string, agent: string, override: AgentOverride | null): void
  setHouseRules(projectId: string, text: string): void
  /** Removes everything a project stored (the project was removed). */
  removeProject(projectId: string): void
}

interface OverrideRow {
  agent: string
  model: string | null
  instructions: string
  used_in_plans: number
}

const isModel = (v: string | null): v is AgentModel => v !== null && (AGENT_MODELS as readonly string[]).includes(v)

export function createAgentProfileStore(db: Database.Database, now: () => number = Date.now): AgentProfileStore {
  const rules = db.prepare(`SELECT text FROM project_house_rules WHERE project_id = ?`)
  const overrides = db.prepare(`SELECT agent, model, instructions, used_in_plans FROM project_agent_overrides WHERE project_id = ?`)
  const upsertRules = db.prepare(
    `INSERT INTO project_house_rules (project_id, text, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (project_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`
  )
  const deleteRules = db.prepare(`DELETE FROM project_house_rules WHERE project_id = ?`)
  const upsertOverride = db.prepare(
    `INSERT INTO project_agent_overrides (project_id, agent, model, instructions, used_in_plans, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, agent) DO UPDATE SET model = excluded.model, instructions = excluded.instructions,
       used_in_plans = excluded.used_in_plans, updated_at = excluded.updated_at`
  )
  const deleteOverride = db.prepare(`DELETE FROM project_agent_overrides WHERE project_id = ? AND agent = ?`)
  const deleteOverrides = db.prepare(`DELETE FROM project_agent_overrides WHERE project_id = ?`)

  return {
    get(projectId) {
      const r = rules.get(projectId) as { text: string } | undefined
      const out: Record<string, AgentOverride> = {}
      for (const row of overrides.all(projectId) as OverrideRow[]) {
        out[row.agent] = {
          model: isModel(row.model) ? row.model : null,
          instructions: row.instructions.slice(0, AGENT_INSTRUCTIONS_MAX),
          usedInPlans: row.used_in_plans !== 0
        }
      }
      return { houseRules: (r?.text ?? '').slice(0, HOUSE_RULES_MAX), overrides: out }
    },
    setOverride(projectId, agent, override) {
      if (override === null || isEmptyOverride(override)) {
        deleteOverride.run(projectId, agent)
        return
      }
      upsertOverride.run(projectId, agent, override.model, override.instructions, override.usedInPlans ? 1 : 0, now())
    },
    setHouseRules(projectId, text) {
      if (text.trim() === '') deleteRules.run(projectId)
      else upsertRules.run(projectId, text, now())
    },
    removeProject(projectId) {
      db.transaction(() => {
        deleteRules.run(projectId)
        deleteOverrides.run(projectId)
      })()
    }
  }
}
