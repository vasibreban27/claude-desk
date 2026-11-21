import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import type { ToolkitListing } from '../../shared/toolkit'
import { migrate } from '../db/migrations'
import { createAgentProfileStore } from '../db/agentProfileStore'
import { createAgentResolver, disabledWorkers, planNote, resolveFrom, roleOf, TOOLKIT_BODY_MAX } from './agents'

const LISTING: ToolkitListing = {
  plugin: { name: 'flow', version: '1.4.0', description: null },
  agents: [
    { name: 'java-developer', description: 'Java and Spring', model: 'sonnet', tools: ['Read', 'Edit'], source: 'agents/java-developer.md', body: 'Use layer-first packages.\n' },
    { name: 'reviewer', description: 'Reviews code', model: 'inherit', tools: [], source: 'agents/reviewer.md', body: 'Look for bugs.' },
    { name: 'test-writer', description: 'Writes tests', model: null, tools: [], source: 'agents/test-writer.md', body: 'Write tests.' }
  ],
  skills: [{ name: 'plan', description: 'Plans', source: 'skills/plan/SKILL.md', body: 'x' }],
  hooks: [],
  problems: []
}

const store = () => {
  const db = new Database(':memory:')
  migrate(db)
  return createAgentProfileStore(db, () => 5)
}

describe('roles', () => {
  it('knows workers, reviewers and helpers', () => {
    expect(roleOf('java-developer')).toBe('worker')
    expect(roleOf('security-auditor')).toBe('reviewer')
    expect(roleOf('test-writer')).toBe('helper')
  })
})

describe('resolveFrom', () => {
  it('uses the toolkit instructions and model when the project changed nothing', () => {
    const r = resolveFrom(LISTING, { houseRules: '', overrides: {} }, 'java-developer')
    expect(r).toMatchObject({ model: 'sonnet', modelSource: 'toolkit', customized: false })
    expect(r.layers.map((l) => l.kind)).toEqual(['toolkit'])
    expect(r.text).toBe('## Agent instructions (claude-toolkit agents/java-developer.md)\nUse layer-first packages.')
    expect(r.fingerprint).toMatch(/^[0-9a-f]{8}$/)
  })

  it('stacks house rules and the agent instructions, and the project model wins', () => {
    const r = resolveFrom(
      LISTING,
      { houseRules: 'Records for DTOs.', overrides: { 'java-developer': { model: 'opus', instructions: 'MapStruct everywhere.', usedInPlans: true } } },
      'java-developer'
    )
    expect(r).toMatchObject({ model: 'opus', modelSource: 'project', customized: true })
    expect(r.layers.map((l) => l.kind)).toEqual(['toolkit', 'house-rules', 'agent'])
    expect(r.text).toContain('## Project house rules (follow them in this project)\nRecords for DTOs.')
    expect(r.text.endsWith('## Project instructions for java-developer\nMapStruct everywhere.')).toBe(true)
    expect(resolveFrom(LISTING, { houseRules: '', overrides: {} }, 'java-developer').fingerprint).not.toBe(r.fingerprint)
  })

  it('treats unknown model values as none and works for agents missing from the toolkit', () => {
    expect(resolveFrom(LISTING, { houseRules: '', overrides: {} }, 'reviewer')).toMatchObject({ model: null, modelSource: 'project-default' })
    const missing = resolveFrom(null, { houseRules: 'Rule.', overrides: {} }, 'python-developer')
    expect(missing.layers.map((l) => l.kind)).toEqual(['house-rules'])
  })

  it('cuts very long toolkit instructions', () => {
    const long = { ...LISTING, agents: [{ ...LISTING.agents[0]!, body: 'x'.repeat(TOOLKIT_BODY_MAX + 50) }] }
    expect(resolveFrom(long, { houseRules: '', overrides: {} }, 'java-developer').text).toContain('…(cut)')
  })
})

describe('plan note and turned-off workers', () => {
  it('tells the planner the house rules and which workers are off', () => {
    const profile = {
      houseRules: 'Layer-first packages.',
      overrides: {
        'python-developer': { model: null, instructions: '', usedInPlans: false },
        reviewer: { model: null, instructions: '', usedInPlans: false }
      }
    }
    expect(disabledWorkers(profile)).toEqual(['python-developer'])
    const note = planNote(profile)
    expect(note).toContain('never assign them): python-developer.')
    expect(note).toContain('Layer-first packages.')
    expect(planNote({ houseRules: ' ', overrides: {} })).toBeNull()
  })
})

describe('createAgentResolver', () => {
  it('builds the project view with overrides, usage and effective models', async () => {
    const s = store()
    s.setOverride('p1', 'java-developer', { model: 'opus', instructions: '', usedInPlans: true })
    s.setHouseRules('p1', 'Rules.')
    const resolver = createAgentResolver({ toolkitPath: () => '/tk', scan: async () => LISTING, store: s })
    const view = await resolver.view('p1', new Map([['java-developer', { sessions: 3, tokens: 1200 }]]), true)
    expect(view?.houseRules).toBe('Rules.')
    expect(view?.agents.find((a) => a.name === 'java-developer')).toMatchObject({
      role: 'worker',
      toolkitModel: 'sonnet',
      effectiveModel: 'opus',
      modelSource: 'project',
      usage: { sessions: 3, tokens: 1200 }
    })
    expect(view?.agents.find((a) => a.name === 'test-writer')).toMatchObject({ role: 'helper', override: null, usage: null })
    expect((await resolver.resolve('p1', 'java-developer')).model).toBe('opus')
    expect((await resolver.resolve('p2', 'java-developer')).model).toBe('sonnet')
  })

  it('reuses a scan for a while and reports no toolkit', async () => {
    let t = 0
    const scan = vi.fn(async () => LISTING)
    const resolver = createAgentResolver({ toolkitPath: () => '/tk', scan, now: () => t, cacheMs: 1000 })
    await resolver.listing()
    await resolver.listing()
    t = 2000
    await resolver.listing()
    expect(scan).toHaveBeenCalledTimes(2)
    expect(await createAgentResolver({ toolkitPath: () => null }).view('p', new Map(), true)).toBeNull()
    const broken = createAgentResolver({ toolkitPath: () => '/tk', scan: async () => Promise.reject(new Error('x')) })
    expect(await broken.listing()).toBeNull()
  })

  it('falls back to no project layer when the store fails', async () => {
    const resolver = createAgentResolver({
      toolkitPath: () => '/tk',
      scan: async () => LISTING,
      store: {
        get: () => {
          throw new Error('db')
        }
      }
    })
    expect((await resolver.resolve('p', 'java-developer')).customized).toBe(false)
  })
})

describe('agentProfileStore', () => {
  it('saves, reads and removes overrides and house rules', () => {
    const s = store()
    s.setOverride('p1', 'java-developer', { model: 'haiku', instructions: 'x', usedInPlans: false })
    s.setOverride('p1', 'reviewer', { model: null, instructions: '', usedInPlans: true })
    s.setHouseRules('p1', 'r')
    expect(s.get('p1')).toEqual({ houseRules: 'r', overrides: { 'java-developer': { model: 'haiku', instructions: 'x', usedInPlans: false } } })
    s.setOverride('p1', 'java-developer', null)
    s.setHouseRules('p1', '  ')
    expect(s.get('p1')).toEqual({ houseRules: '', overrides: {} })
    s.setOverride('p1', 'a', { model: 'opus', instructions: '', usedInPlans: true })
    s.setHouseRules('p1', 'r')
    s.removeProject('p1')
    expect(s.get('p1')).toEqual({ houseRules: '', overrides: {} })
  })
})
