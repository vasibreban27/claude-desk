import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ExtraUsage, PlanLimit, PlanUsage, PlanUsageResult } from '../../shared/usage'
import type { QueryFn } from '../pipeline/workerRunner'

/**
 * Reads the plan limits Claude Code's `/usage` command shows (5-hour session, weekly meters, extra usage) by sending
 * `/usage` through the Agent SDK. The structured `usage_report` on the reply is documented in the SDK reference
 * (SDKUsageReport); when it is absent the reply text is kept instead. `/usage` is a local command, so the check
 * sends no prompt to the model. Results are cached: the docs ask to poll sparingly.
 */

export const PLAN_USAGE_TTL_MS = 5 * 60 * 1000
export const PLAN_USAGE_TIMEOUT_MS = 30 * 1000
export const PLAN_TEXT_MAX = 4000

const limitSchema = z.object({
  kind: z.string().max(100),
  group: z.string().max(200).nullish(),
  percent: z.number().finite(),
  resets_at: z.string().max(100).nullish(),
  scope: z.string().max(200).nullish(),
  severity: z.string().max(50).nullish(),
  is_active: z.boolean().nullish()
})

const extraSchema = z.object({
  is_enabled: z.boolean(),
  monthly_limit: z.number().finite().nullish(),
  used_credits: z.number().finite().nullish(),
  utilization: z.number().finite().nullish(),
  currency: z.string().max(10).nullish()
})

const reportSchema = z.object({
  rate_limits: z
    .object({
      limits: z.array(z.unknown()).max(50).nullish(),
      extra_usage: z.unknown().nullish()
    })
    .nullish()
})

const KIND_LABELS: Record<string, string> = {
  session: 'Current session (5-hour window)',
  weekly_all: 'This week, all models'
}

const clampPercent = (n: number): number => Math.max(0, Math.min(100, n))

function labelFor(kind: string, scope: string | null, group: string | null): string {
  const known = KIND_LABELS[kind]
  if (known !== undefined) return known
  const detail = scope ?? group
  if (kind === 'weekly_scoped') return detail ? `This week, ${detail}` : 'This week, limited models'
  const words = kind.replace(/_/g, ' ')
  return detail ? `${words} (${detail})` : words
}

function isoOrNull(s: string | null | undefined): string | null {
  if (typeof s !== 'string' || s === '') return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/** Parses the documented `usage_report` of a message; null when the message has none or it is unusable. */
export function parseUsageReport(message: unknown): { limits: PlanLimit[]; extraUsage: ExtraUsage | null } | null {
  if (typeof message !== 'object' || message === null) return null
  const raw = (message as Record<string, unknown>)['usage_report']
  if (raw === undefined || raw === null) return null
  const report = reportSchema.safeParse(raw)
  if (!report.success || !report.data.rate_limits) return null
  const limits: PlanLimit[] = []
  for (const item of report.data.rate_limits.limits ?? []) {
    const l = limitSchema.safeParse(item)
    // `is_active` marks the meter that binds right now; the others (e.g. weekly) still matter, so all are kept.
    if (!l.success) continue
    limits.push({
      kind: l.data.kind,
      label: labelFor(l.data.kind, l.data.scope ?? null, l.data.group ?? null),
      percent: clampPercent(l.data.percent),
      resetsAt: isoOrNull(l.data.resets_at),
      severity: l.data.severity ?? null
    })
  }
  const e = extraSchema.safeParse(report.data.rate_limits.extra_usage)
  const extraUsage: ExtraUsage | null = e.success
    ? {
        enabled: e.data.is_enabled,
        usedCredits: e.data.used_credits ?? null,
        monthlyLimit: e.data.monthly_limit ?? null,
        percent: typeof e.data.utilization === 'number' ? clampPercent(e.data.utilization) : null,
        currency: e.data.currency ?? null
      }
    : null
  return { limits, extraUsage }
}

/** Text of an assistant message or a local command output; empty when there is none. */
export function messageText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const m = message as Record<string, unknown>
  if (typeof m['content'] === 'string') return m['content']
  const inner = m['message']
  if (typeof inner !== 'object' || inner === null) return ''
  const content = (inner as Record<string, unknown>)['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (typeof b === 'object' && b !== null && (b as Record<string, unknown>)['type'] === 'text' ? String((b as Record<string, unknown>)['text'] ?? '') : ''))
    .join('')
}

export interface PlanUsageReaderDeps {
  /** Folder the `/usage` session runs in (an app-owned empty folder). */
  cwd: () => string
  queryFn?: QueryFn
  now?: () => number
  ttlMs?: number
  timeoutMs?: number
}

export interface PlanUsageReader {
  get(refresh: boolean): Promise<PlanUsageResult>
}

export function createPlanUsageReader(deps: PlanUsageReaderDeps): PlanUsageReader {
  const queryFn: QueryFn = deps.queryFn ?? ((p) => query(p))
  const now = deps.now ?? Date.now
  const ttl = deps.ttlMs ?? PLAN_USAGE_TTL_MS
  const timeout = deps.timeoutMs ?? PLAN_USAGE_TIMEOUT_MS
  let cached: { at: number; usage: PlanUsage } | null = null
  let inFlight: Promise<PlanUsageResult> | null = null

  async function check(): Promise<PlanUsageResult> {
    const abortController = new AbortController()
    const options: Options = {
      cwd: deps.cwd(),
      // Nothing from the user's or a project's settings, no plugins, no tools: only the built-in command runs.
      settingSources: [],
      tools: [],
      allowedTools: [],
      maxTurns: 1,
      abortController
    }
    const timer = setTimeout(() => abortController.abort(), timeout)
    let parsed: ReturnType<typeof parseUsageReport> = null
    let text = ''
    try {
      const q = queryFn({ prompt: '/usage', options })
      try {
        for await (const message of q) {
          parsed ??= parseUsageReport(message)
          const t = messageText(message)
          if (t !== '' && text.length < PLAN_TEXT_MAX) text += (text ? '\n' : '') + t
          if (typeof message === 'object' && message !== null && (message as Record<string, unknown>)['type'] === 'result') break
        }
      } finally {
        q.close()
      }
    } catch (e) {
      if (parsed === null && text === '') {
        const msg = abortController.signal.aborted ? 'the usage check timed out' : e instanceof Error ? e.message : String(e)
        return { ok: false, error: 'failed', message: msg.slice(0, 300) }
      }
    } finally {
      clearTimeout(timer)
    }
    const fetchedAt = new Date(now()).toISOString()
    const usage: PlanUsage =
      parsed !== null && (parsed.limits.length > 0 || parsed.extraUsage !== null)
        ? { status: 'ok', limits: parsed.limits, extraUsage: parsed.extraUsage, text: null, fetchedAt }
        : text.trim() !== ''
          ? { status: 'text-only', limits: [], extraUsage: null, text: text.trim().slice(0, PLAN_TEXT_MAX), fetchedAt }
          : { status: 'unavailable', limits: [], extraUsage: null, text: null, fetchedAt }
    cached = { at: now(), usage }
    return { ok: true, usage }
  }

  return {
    get(refresh) {
      if (!refresh && cached !== null && now() - cached.at < ttl) return Promise.resolve({ ok: true, usage: cached.usage })
      // Concurrent callers share one check.
      inFlight ??= check()
        .catch((e: unknown): PlanUsageResult => ({ ok: false, error: 'failed', message: (e instanceof Error ? e.message : String(e)).slice(0, 300) }))
        .finally(() => {
          inFlight = null
        })
      return inFlight
    }
  }
}
