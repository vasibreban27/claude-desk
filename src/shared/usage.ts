import { z } from 'zod'

/** One plan meter from Claude Code's `/usage` report (e.g. the 5-hour session or the weekly limit). */
export interface PlanLimit {
  /** As reported, e.g. `session`, `weekly_all`, `weekly_scoped`. */
  kind: string
  /** Plain-language name for the UI. */
  label: string
  /** 0..100. */
  percent: number
  /** ISO-8601, or null when not reported. */
  resetsAt: string | null
  /** As reported (e.g. `normal`, `warning`); null when absent. */
  severity: string | null
}

export interface ExtraUsage {
  enabled: boolean
  /** Minor units (cents) of `currency`; null when not reported. */
  usedCredits: number | null
  monthlyLimit: number | null
  /** 0..100 or null. */
  percent: number | null
  currency: string | null
}

export interface PlanUsage {
  /**
   * `ok`: plan meters were reported. `text-only`: Claude Code answered without structured data (the text is shown).
   * `unavailable`: no plan data (API-key login, no profile scope, or usage-based billing).
   */
  status: 'ok' | 'text-only' | 'unavailable'
  limits: PlanLimit[]
  extraUsage: ExtraUsage | null
  /** The report text when there is no structured data (capped). */
  text: string | null
  /** ISO-8601 time of the check. */
  fetchedAt: string
}

export type PlanUsageError = 'failed'
export type PlanUsageResult = { ok: true; usage: PlanUsage } | { ok: false; error: PlanUsageError; message?: string }

export const planUsageRequestSchema = z.object({
  /** True asks for a fresh check; otherwise a recent cached one may be returned. */
  refresh: z.boolean()
})
export type PlanUsageRequest = z.infer<typeof planUsageRequestSchema>
