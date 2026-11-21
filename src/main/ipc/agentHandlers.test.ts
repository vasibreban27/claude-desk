import { describe, expect, it, vi } from 'vitest'
import type { ToolkitListing } from '../../shared/toolkit'
import { createAgentResolver } from '../toolkit/agents'
import { createAgentHandlers } from './agentHandlers'

const ID = '11111111-1111-4111-8111-111111111111'
const LISTING: ToolkitListing = {
  plugin: { name: 'flow', version: '1', description: null },
  agents: [
    { name: 'java-developer', description: 'Java', model: 'sonnet', tools: [], source: 'agents/java-developer.md', body: 'Toolkit body.' },
    { name: 'test-writer', description: 'Tests', model: null, tools: [], source: 'agents/test-writer.md', body: 'Write tests.' }
  ],
  skills: [],
  hooks: [],
  problems: []
}

function setup(over: { store?: boolean; toolkit?: boolean } = {}) {
  const profile = { houseRules: 'House.', overrides: { 'java-developer': { model: 'opus' as const, instructions: 'Extra.', usedInPlans: true } } }
  const store = { setOverride: vi.fn(), setHouseRules: vi.fn() }
  const resolver = createAgentResolver({
    toolkitPath: () => (over.toolkit === false ? null : '/tk'),
    scan: async () => LISTING,
    store: { get: () => profile }
  })
  const h = createAgentHandlers({
    projects: { get: async (id: string) => (id === ID ? ({ id } as never) : undefined) },
    resolver,
    ...(over.store === false ? {} : { store }),
    runStore: {
      summary: () =>
        ({ byAgent: [{ agent: 'java-developer', steps: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 }] }) as never
    },
    log: () => undefined
  })
  return { h, store }
}

describe('agent handlers', () => {
  it('returns the project view with usage', async () => {
    const r = await setup().h.agentsView({ projectId: ID })
    expect(r.ok && r.view.agents[0]).toMatchObject({ name: 'java-developer', effectiveModel: 'opus', usage: { sessions: 2, tokens: 15 } })
    expect(r.ok && r.view.editable).toBe(true)
    const ro = await setup({ store: false }).h.agentsView({ projectId: ID })
    expect(ro.ok && ro.view.editable).toBe(false)
  })

  it('refuses bad payloads, unknown projects and a missing toolkit', async () => {
    const { h } = setup()
    expect(await h.agentsView({ projectId: 'x' })).toEqual({ ok: false, error: 'not-found' })
    expect(await h.agentsView({ projectId: '22222222-2222-4222-8222-222222222222' })).toEqual({ ok: false, error: 'not-found' })
    expect(await setup({ toolkit: false }).h.agentsView({ projectId: ID })).toEqual({ ok: false, error: 'no-toolkit' })
  })

  it('saves overrides and house rules after validating them', async () => {
    const { h, store } = setup()
    const override = { model: 'haiku', instructions: 'x', usedInPlans: false }
    expect(await h.agentsSave({ projectId: ID, agent: 'java-developer', override })).toEqual({ ok: true })
    expect(store.setOverride).toHaveBeenCalledWith(ID, 'java-developer', override)
    expect(await h.agentsSave({ projectId: ID, agent: 'java-developer', override: null })).toEqual({ ok: true })
    expect(await h.agentsSave({ projectId: ID, agent: '../x', override: null })).toEqual({ ok: false, error: 'invalid' })
    expect(await h.agentsSave({ projectId: ID, agent: 'a', override: { ...override, model: 'gpt' } })).toEqual({ ok: false, error: 'invalid' })
    expect(await h.agentsSave({ projectId: ID, agent: 'a', override: { ...override, instructions: 'x'.repeat(4001) } })).toEqual({ ok: false, error: 'invalid' })
    expect(await h.agentsRules({ projectId: ID, houseRules: 'Rules.' })).toEqual({ ok: true })
    expect(store.setHouseRules).toHaveBeenCalledWith(ID, 'Rules.')
    expect(await setup({ store: false }).h.agentsRules({ projectId: ID, houseRules: 'x' })).toEqual({ ok: false, error: 'storage-unavailable' })
  })

  it('previews the layers a worker session gets, with the app rules last', async () => {
    const r = await setup().h.agentsPreview({ projectId: ID, agent: 'java-developer' })
    expect(r.ok && r.layers.map((l) => l.kind)).toEqual(['toolkit', 'house-rules', 'agent', 'app'])
    expect(r.ok && r.layers[3]?.text).toContain('You are the "java-developer" worker')
    expect(r.ok && r.model).toBe('opus')
    const helper = await setup().h.agentsPreview({ projectId: ID, agent: 'test-writer' })
    expect(helper.ok && helper.layers.map((l) => l.kind)).toEqual(['toolkit', 'app'])
    expect(await setup().h.agentsPreview({ projectId: ID, agent: 'nobody' })).toEqual({ ok: false, error: 'not-found' })
  })
})
