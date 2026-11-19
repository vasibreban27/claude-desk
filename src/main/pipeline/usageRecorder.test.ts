import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate } from '../db/migrations'
import { createRunStore } from '../db/runStore'
import { pipelineUsageRecorder } from './usageRecorder'
import type { RunUsage } from '../chat/activity'

const usage = (over: Partial<RunUsage> = {}): RunUsage => ({
  costUsd: 0.5,
  durationMs: 1000,
  isError: false,
  models: [
    { model: 'sonnet', costUsd: 0.3, inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000, cacheCreationTokens: 50 },
    { model: 'haiku', costUsd: 0.2, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 }
  ],
  mainTokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ...over
})

describe('pipelineUsageRecorder', () => {
  it('records worker and reviewer sessions with their kind and agent, summed over models', () => {
    const db = new Database(':memory:')
    migrate(db)
    const now = new Date(2026, 10, 19, 12).getTime()
    const store = createRunStore(db, () => now)
    let n = 0
    const record = pipelineUsageRecorder(store, () => `id-${++n}`)
    record({ projectId: 'p', kind: 'worker', agent: 'node-developer', startedAt: now, usage: usage() })
    record({ projectId: 'p', kind: 'reviewer', agent: 'reviewer', startedAt: now, usage: usage({ models: [], costUsd: 0.1 }) })

    const s = store.summary({ projectId: 'p', days: 1 })
    expect(s.totals.runs).toBe(2)
    expect(s.byKind).toEqual([
      { kind: 'worker', runs: 1, costUsd: 0.5, tokens: 1182 },
      { kind: 'reviewer', runs: 1, costUsd: 0.1, tokens: 2 }
    ])
    expect(s.byAgent.map((a) => a.agent)).toEqual(['node-developer', 'reviewer'])
    expect(s.byAgent[0]).toMatchObject({ steps: 1, inputTokens: 110, outputTokens: 22, cacheReadTokens: 1000, approximate: false })
  })
})
