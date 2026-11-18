import { z } from 'zod'

/** Review findings: the shape a reviewer reports and the pipeline stores. */

export const REVIEWER_NAMES = ['reviewer', 'security-auditor'] as const
export type ReviewerName = (typeof REVIEWER_NAMES)[number]

export const FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number]

export const FINDING_FILE_MAX = 200
export const FINDING_TEXT_MAX = 500
/** Findings kept per task view and per reviewer report. */
export const FINDINGS_MAX_COUNT = 20

export const AUTO_FIX_ROUNDS_RANGE = { min: 0, max: 5, default: 2 } as const
export const REVIEWERS_MAX_COUNT = 2
export const DEFAULT_REVIEWERS: readonly ReviewerName[] = ['reviewer']

export const findingSchema = z.object({
  reviewer: z.enum(REVIEWER_NAMES),
  severity: z.enum(FINDING_SEVERITIES),
  file: z.string().max(FINDING_FILE_MAX),
  line: z.number().int().nullable(),
  text: z.string().max(FINDING_TEXT_MAX)
})
export type Finding = z.infer<typeof findingSchema>

export function isBlocking(finding: Pick<Finding, 'severity'>): boolean {
  return finding.severity === 'blocker' || finding.severity === 'major'
}

export type PipelineStage = 'checks' | 'review' | 'fixing'

export interface TaskFindingsView {
  blocking: number
  minor: number
  /** At most FINDINGS_MAX_COUNT. */
  items: Finding[]
}
