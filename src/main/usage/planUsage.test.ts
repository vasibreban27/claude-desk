import { describe, expect, it, vi } from 'vitest'
import { createPlanUsageReader, messageText, parseUsageReport } from './planUsage'
import type { QueryLike } from '../pipeline/workerRunner'

const report = {
  rate_limits: {
    limits: [
      { kind: 'session', group: 'session', percent: 42.5, resets_at: '2026-11-19T15:00:00Z', scope: null, severity: 'normal', is_active: true },
      { kind: 'weekly_all', group: 'weekly', percent: 130, resets_at: 'not a date', scope: null, severity: 'warning', is_active: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 10, resets_at: null, scope: 'Opus', severity: null, is_active: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: null, scope: 'Sonnet', severity: null, is_active: false },
      { kind: 'session', percent: 'bad' }
    ],
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25, currency: 'USD' }
  }
}

function fakeQuery(messages: unknown[], opts: { throws?: Error } = {}) {
  const close = vi.fn()
  const q: QueryLike = {
    close,
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m
      if (opts.throws) throw opts.throws
    }
  }
  return { q, close }
}

describe('parseUsageReport', () => {
  it('maps every meter (active or not) with plain labels, clamps percent and drops bad dates and rows', () => {
    const r = parseUsageReport({ type: 'assistant', usage_report: report })
    expect(r?.limits).toEqual([
      { kind: 'session', label: 'Current session (5-hour window)', percent: 42.5, resetsAt: '2026-11-19T15:00:00.000Z', severity: 'normal' },
      { kind: 'weekly_all', label: 'This week, all models', percent: 100, resetsAt: null, severity: 'warning' },
      { kind: 'weekly_scoped', label: 'This week, Opus', percent: 10, resetsAt: null, severity: null },
      { kind: 'weekly_scoped', label: 'This week, Sonnet', percent: 0, resetsAt: null, severity: null }
    ])
    expect(r?.extraUsage).toEqual({ enabled: true, usedCredits: 1250, monthlyLimit: 5000, percent: 25, currency: 'USD' })
  })

  it('returns null without a report or without plan data', () => {
    expect(parseUsageReport({ type: 'assistant' })).toBeNull()
    expect(parseUsageReport({ usage_report: { rate_limits: null } })).toBeNull()
    expect(parseUsageReport({ usage_report: 'x' })).toBeNull()
    expect(parseUsageReport(null)).toBeNull()
  })
})

describe('messageText', () => {
  it('reads assistant text blocks and local command output', () => {
    expect(messageText({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] } })).toBe('ab')
    expect(messageText({ type: 'system', subtype: 'local_command_output', content: 'Session 42%' })).toBe('Session 42%')
    expect(messageText({ type: 'result' })).toBe('')
  })
})

describe('createPlanUsageReader', () => {
  const at = 1_800_000_000_000

  it('sends /usage with no settings, tools or plugins and returns the structured meters', async () => {
    const { q, close } = fakeQuery([{ type: 'system', subtype: 'init' }, { type: 'assistant', message: { content: [] }, usage_report: report }, { type: 'result' }])
    const queryFn = vi.fn(() => q)
    const reader = createPlanUsageReader({ cwd: () => '/data/usage-check', queryFn, now: () => at })
    const r = await reader.get(false)
    expect(r).toMatchObject({ ok: true, usage: { status: 'ok', fetchedAt: new Date(at).toISOString() } })
    expect(r.ok && r.usage.limits).toHaveLength(4)
    const call = queryFn.mock.calls[0] as unknown as [{ prompt: string; options: Record<string, unknown> }]
    expect(call[0].prompt).toBe('/usage')
    expect(call[0].options).toMatchObject({ cwd: '/data/usage-check', settingSources: [], tools: [], allowedTools: [], maxTurns: 1 })
    expect(call[0].options['plugins']).toBeUndefined()
    expect(close).toHaveBeenCalled()
  })

  it('keeps the text when there is no structured report, and reports unavailable when there is nothing', async () => {
    const text = createPlanUsageReader({
      cwd: () => '/d',
      queryFn: () => fakeQuery([{ type: 'system', subtype: 'local_command_output', content: 'Usage: 42% of session' }]).q
    })
    expect(await text.get(true)).toMatchObject({ ok: true, usage: { status: 'text-only', text: 'Usage: 42% of session' } })
    const none = createPlanUsageReader({ cwd: () => '/d', queryFn: () => fakeQuery([{ type: 'result' }]).q })
    expect(await none.get(true)).toMatchObject({ ok: true, usage: { status: 'unavailable', limits: [] } })
  })

  it('caches for the TTL, refreshes on request and shares a check in flight', async () => {
    let t = at
    const queryFn = vi.fn(() => fakeQuery([{ usage_report: report }]).q)
    const reader = createPlanUsageReader({ cwd: () => '/d', queryFn, now: () => t, ttlMs: 1000 })
    await Promise.all([reader.get(false), reader.get(false)])
    expect(queryFn).toHaveBeenCalledTimes(1)
    t += 500
    await reader.get(false)
    expect(queryFn).toHaveBeenCalledTimes(1)
    await reader.get(true)
    expect(queryFn).toHaveBeenCalledTimes(2)
    t += 2000
    await reader.get(false)
    expect(queryFn).toHaveBeenCalledTimes(3)
  })

  it('reports a failure when the session throws before any data', async () => {
    const reader = createPlanUsageReader({ cwd: () => '/d', queryFn: () => fakeQuery([], { throws: new Error('not logged in') }).q })
    expect(await reader.get(true)).toEqual({ ok: false, error: 'failed', message: 'not logged in' })
    const thrower = createPlanUsageReader({
      cwd: () => '/d',
      queryFn: () => {
        throw new Error('spawn failed')
      }
    })
    expect(await thrower.get(true)).toEqual({ ok: false, error: 'failed', message: 'spawn failed' })
  })

  it('keeps data that arrived before the session threw', async () => {
    const reader = createPlanUsageReader({ cwd: () => '/d', queryFn: () => fakeQuery([{ usage_report: report }], { throws: new Error('late') }).q })
    expect(await reader.get(true)).toMatchObject({ ok: true, usage: { status: 'ok' } })
  })
})
